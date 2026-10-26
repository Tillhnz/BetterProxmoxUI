"""
BetterProxmoxUI – Backend

Eine schlanke Starlette-App, die auf dem Proxmox-Host läuft und
 * den Login 1:1 an die Proxmox-API weiterreicht (gleiche Benutzer, gleiche Rechte, inkl. 2FA),
 * alle Proxmox-API-Aufrufe im Namen des eingeloggten Benutzers weiterleitet,
 * Host-Aktionen (Community-Skripte, Updates, Root-Shell) als "Jobs" in einem
   Pseudo-Terminal ausführt, die auch dann weiterlaufen, wenn der Browser zu ist,
 * nur aus dem lokalen Netz erreichbar ist.
"""

from __future__ import annotations

import asyncio
import fcntl
import ipaddress
import json
import os
import pty
import re
import secrets
import signal
import ssl
import struct
import termios
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocket, WebSocketDisconnect

# --------------------------------------------------------------------------
# Konfiguration (über /etc/better-proxmox-ui.env bzw. Umgebungsvariablen)
# --------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = Path(os.environ.get("BPUI_FRONTEND_DIR", BASE_DIR / "frontend"))
VERSION = (BASE_DIR / "VERSION").read_text().strip() if (BASE_DIR / "VERSION").exists() else "dev"

PVE_URL = os.environ.get("BPUI_PVE_URL", "https://127.0.0.1:8006").rstrip("/")
PVE_CA = os.environ.get("BPUI_PVE_CA", "/etc/pve/pve-root-ca.pem")
# Zusätzlich erlaubte Netze (kommagetrennt), z. B. "100.64.0.0/10" für Tailscale.
EXTRA_NETS = [n.strip() for n in os.environ.get("BPUI_ALLOW_NETS", "").split(",") if n.strip()]
# Auf "0" setzen, um Skripte/Updates/Shell komplett abzuschalten.
HOST_ACTIONS = os.environ.get("BPUI_HOST_ACTIONS", "1") == "1"
# Wer Host-Aktionen ausführen darf (wie bei Proxmox: nur root@pam bekommt die Host-Shell).
HOST_ADMINS = {u.strip() for u in os.environ.get("BPUI_HOST_ADMINS", "root@pam").split(",") if u.strip()}
INSTALL_DIR = os.environ.get("BPUI_INSTALL_DIR", "/opt/better-proxmox-ui")
STATE_DIR = Path(os.environ.get("BPUI_STATE_DIR", "/var/lib/better-proxmox-ui"))
SESSION_IDLE = int(os.environ.get("BPUI_SESSION_IDLE", str(8 * 3600)))
SCRIPTS_REPO = os.environ.get("BPUI_SCRIPTS_REPO", "community-scripts/ProxmoxVE")
SCRIPTS_BRANCH = os.environ.get("BPUI_SCRIPTS_BRANCH", "main")
COOKIE_SECURE = os.environ.get("BPUI_COOKIE_SECURE", "1") == "1"

COOKIE = "bpui_sid"
ALLOWED_NETS = [ipaddress.ip_network(n, strict=False) for n in EXTRA_NETS]

# --------------------------------------------------------------------------
# Proxmox-API-Client (nur Standardbibliothek, läuft in Threads)
# --------------------------------------------------------------------------


def _ssl_context() -> ssl.SSLContext:
    host = urllib.parse.urlparse(PVE_URL).hostname or ""
    if host in ("127.0.0.1", "localhost", "::1"):
        # Verbindung zum eigenen Host – das Proxmox-Zertifikat lautet auf den Hostnamen,
        # daher nur gegen die Proxmox-CA prüfen (falls vorhanden), ohne Hostnamenprüfung.
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        if os.path.exists(PVE_CA):
            ctx.load_verify_locations(PVE_CA)
        else:
            ctx.verify_mode = ssl.CERT_NONE
        return ctx
    return ssl.create_default_context()


SSL_CTX = _ssl_context()


class PveError(Exception):
    def __init__(self, status: int, message: str, errors=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.errors = errors


def _encode_form(data: dict | None) -> bytes | None:
    if not data:
        return None
    pairs = []
    for k, v in data.items():
        if v is None or v == "":
            continue
        if isinstance(v, bool):
            v = 1 if v else 0
        if isinstance(v, (list, tuple)):
            for item in v:
                pairs.append((k, str(item)))
        else:
            pairs.append((k, str(v)))
    return urllib.parse.urlencode(pairs).encode()


def _pve_call_sync(method: str, path: str, ticket: str | None = None, csrf: str | None = None,
                   data: dict | None = None, query: str = "", timeout: int = 60):
    url = f"{PVE_URL}/api2/json{path}"
    if query:
        url += "?" + query
    body = _encode_form(data) if method != "GET" else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Accept", "application/json")
    if body is not None:
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
    if ticket:
        req.add_header("Cookie", f"PVEAuthCookie={urllib.parse.quote(ticket, safe='')}")
    if csrf and method != "GET":
        req.add_header("CSRFPreventionToken", csrf)
    try:
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read() or b"{}"
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = {}
        raise PveError(e.code, e.reason or f"HTTP {e.code}", payload.get("errors")) from None
    except urllib.error.URLError as e:
        raise PveError(502, f"Proxmox nicht erreichbar: {e.reason}") from None


async def pve_call(method, path, ticket=None, csrf=None, data=None, query="", timeout=60):
    return await asyncio.to_thread(_pve_call_sync, method, path, ticket, csrf, data, query, timeout)


# --------------------------------------------------------------------------
# Sessions
# --------------------------------------------------------------------------


class Session:
    def __init__(self, username: str, ticket: str, csrf: str, cap: dict | None):
        self.id = secrets.token_urlsafe(32)
        self.username = username
        self.ticket = ticket
        self.csrf = csrf
        self.cap = cap or {}
        self.ticket_time = time.time()
        self.last_seen = time.time()
        self.lock = asyncio.Lock()

    @property
    def host_admin(self) -> bool:
        return HOST_ACTIONS and self.username in HOST_ADMINS


SESSIONS: dict[str, Session] = {}
PENDING_TFA: dict[str, dict] = {}  # sid -> {username, ticket, time}
LOGIN_FAILS: dict[str, list[float]] = {}


def _cleanup_sessions():
    now = time.time()
    for sid, s in list(SESSIONS.items()):
        # Proxmox-Tickets sind 2h gültig; wir erneuern sie laufend. Nach Leerlauf ausloggen.
        if now - s.last_seen > SESSION_IDLE or now - s.ticket_time > 7000:
            SESSIONS.pop(sid, None)
    for sid, p in list(PENDING_TFA.items()):
        if now - p["time"] > 300:
            PENDING_TFA.pop(sid, None)


async def get_session(request: Request | WebSocket) -> Session | None:
    _cleanup_sessions()
    sid = request.cookies.get(COOKIE)
    s = SESSIONS.get(sid or "")
    if not s:
        return None
    s.last_seen = time.time()
    if time.time() - s.ticket_time > 3600:
        async with s.lock:
            if time.time() - s.ticket_time > 3600:
                try:
                    _, res = await pve_call("POST", "/access/ticket",
                                            data={"username": s.username, "password": s.ticket})
                    d = res.get("data") or {}
                    s.ticket = d["ticket"]
                    s.csrf = d.get("CSRFPreventionToken", s.csrf)
                    s.ticket_time = time.time()
                except Exception:
                    SESSIONS.pop(s.id, None)
                    return None
    return s


def _set_cookie(resp: Response, sid: str):
    resp.set_cookie(COOKIE, sid, httponly=True, secure=COOKIE_SECURE, samesite="strict", path="/")


def _err(status: int, message: str, **extra):
    return JSONResponse({"error": message, **extra}, status_code=status)


# --------------------------------------------------------------------------
# Middleware: nur lokales Netz, Sicherheits-Header, CSRF-Schutz
# --------------------------------------------------------------------------


def _ip_allowed(host: str | None) -> bool:
    if not host:
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    if getattr(ip, "ipv4_mapped", None):
        ip = ip.ipv4_mapped
    if ip.is_loopback or ip.is_private or ip.is_link_local:
        return True
    return any(ip in net for net in ALLOWED_NETS)


SECURITY_HEADERS = [
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"no-referrer"),
    (b"content-security-policy",
     b"default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' "
     b"https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"),
]


class GuardMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        client = scope.get("client")
        if not _ip_allowed(client[0] if client else None):
            if scope["type"] == "http":
                return await PlainTextResponse("Nur aus dem lokalen Netzwerk erreichbar.", 403)(scope, receive, send)
            return await send({"type": "websocket.close", "code": 4403})

        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        method = scope.get("method", "GET")
        path = scope.get("path", "")

        if scope["type"] == "http" and path.startswith("/api/") and method not in ("GET", "HEAD", "OPTIONS"):
            # Eigener Header erzwingt einen CORS-Preflight → fremde Seiten können nichts auslösen.
            if headers.get("x-bpui") != "1":
                return await _err(403, "CSRF-Schutz: Header fehlt")(scope, receive, send)

        if scope["type"] == "websocket":
            origin = headers.get("origin", "")
            host = headers.get("host", "")
            if origin and urllib.parse.urlparse(origin).netloc != host:
                return await send({"type": "websocket.close", "code": 4403})

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                hdrs = list(message.get("headers", []))
                hdrs.extend(SECURITY_HEADERS)
                if path.startswith("/api/"):
                    hdrs.append((b"cache-control", b"no-store"))
                message["headers"] = hdrs
            await send(message)

        await self.app(scope, receive, send_wrapper)


# --------------------------------------------------------------------------
# Auth-Endpunkte
# --------------------------------------------------------------------------


async def realms(request: Request):
    try:
        _, res = await pve_call("GET", "/access/domains")
        items = [{"realm": d["realm"], "comment": d.get("comment") or d["realm"], "default": d.get("default", 0)}
                 for d in res.get("data", [])]
    except PveError:
        items = [{"realm": "pam", "comment": "Linux PAM", "default": 1},
                 {"realm": "pve", "comment": "Proxmox VE", "default": 0}]
    return JSONResponse({"data": items})


def _rate_limited(ip: str) -> bool:
    now = time.time()
    fails = [t for t in LOGIN_FAILS.get(ip, []) if now - t < 300]
    LOGIN_FAILS[ip] = fails
    return len(fails) >= 10


def _finish_login(d: dict, username: str) -> Response:
    s = Session(d.get("username", username), d["ticket"], d.get("CSRFPreventionToken", ""), d.get("cap"))
    SESSIONS[s.id] = s
    resp = JSONResponse({"ok": True, "user": _me(s)})
    _set_cookie(resp, s.id)
    return resp


async def login(request: Request):
    ip = request.client.host if request.client else "?"
    if _rate_limited(ip):
        return _err(429, "Zu viele Fehlversuche. Bitte 5 Minuten warten.")
    body = await request.json()
    user = (body.get("username") or "").strip()
    realm = (body.get("realm") or "pam").strip()
    password = body.get("password") or ""
    if not user or not password:
        return _err(400, "Benutzername und Passwort angeben")
    username = user if "@" in user else f"{user}@{realm}"
    try:
        _, res = await pve_call("POST", "/access/ticket", data={"username": username, "password": password})
    except PveError as e:
        LOGIN_FAILS.setdefault(ip, []).append(time.time())
        if e.status in (401, 403):
            return _err(401, "Anmeldung fehlgeschlagen. Bitte Benutzername, Passwort und Bereich prüfen.")
        return _err(e.status, e.message)
    d = res.get("data") or {}
    if d.get("NeedTFA"):
        pid = secrets.token_urlsafe(24)
        PENDING_TFA[pid] = {"username": d.get("username", username), "ticket": d["ticket"], "time": time.time()}
        challenge = {}
        try:
            # Ticket-Format: PVE:user::<base64 challenge>... – wir zeigen nur an, welche Arten erlaubt sind.
            raw = urllib.parse.unquote(d["ticket"]).split("!tfa!", 1)[1].split(":", 1)[0]
            challenge = json.loads(raw)
        except Exception:
            pass
        kinds = [k for k in ("totp", "yubico", "recovery") if challenge.get(k)] or ["totp", "recovery"]
        resp = JSONResponse({"need_tfa": True, "kinds": kinds})
        resp.set_cookie("bpui_tfa", pid, httponly=True, secure=COOKIE_SECURE, samesite="strict", path="/api/")
        return resp
    return _finish_login(d, username)


async def login_tfa(request: Request):
    ip = request.client.host if request.client else "?"
    if _rate_limited(ip):
        return _err(429, "Zu viele Fehlversuche. Bitte 5 Minuten warten.")
    pid = request.cookies.get("bpui_tfa", "")
    pending = PENDING_TFA.pop(pid, None)
    if not pending:
        return _err(401, "Die Anmeldung ist abgelaufen. Bitte neu anmelden.")
    body = await request.json()
    code = re.sub(r"\s", "", body.get("code") or "")
    kind = body.get("kind") or "totp"
    if kind not in ("totp", "yubico", "recovery"):
        kind = "totp"
    try:
        _, res = await pve_call("POST", "/access/ticket", data={
            "username": pending["username"], "tfa-challenge": pending["ticket"], "password": f"{kind}:{code}"})
    except PveError:
        LOGIN_FAILS.setdefault(ip, []).append(time.time())
        return _err(401, "Code ungültig. Bitte neu anmelden.")
    resp = _finish_login(res.get("data") or {}, pending["username"])
    resp.delete_cookie("bpui_tfa", path="/api/")
    return resp


async def logout(request: Request):
    sid = request.cookies.get(COOKIE)
    SESSIONS.pop(sid or "", None)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE, path="/")
    return resp


def _me(s: Session) -> dict:
    return {"username": s.username, "host_admin": s.host_admin, "version": VERSION,
            "host_actions": HOST_ACTIONS}


async def me(request: Request):
    s = await get_session(request)
    if not s:
        return _err(401, "Nicht angemeldet")
    return JSONResponse({"user": _me(s)})


# --------------------------------------------------------------------------
# Allgemeiner Proxmox-API-Proxy: /api/pve/<pfad> → /api2/json/<pfad>
# Proxmox selbst prüft die Berechtigungen des eingeloggten Benutzers.
# --------------------------------------------------------------------------

SAFE_PATH = re.compile(r"^/[A-Za-z0-9/_\-.:@=%~+]*$")


async def pve_proxy(request: Request):
    s = await get_session(request)
    if not s:
        return _err(401, "Nicht angemeldet")
    raw = request.scope.get("raw_path", b"").decode("latin-1") or request.url.path
    path = raw.split("?", 1)[0][len("/api/pve"):] or "/"
    if not SAFE_PATH.match(path) or ".." in path:
        return _err(400, "Ungültiger Pfad")
    data = None
    if request.method in ("POST", "PUT", "DELETE"):
        body = await request.body()
        if body:
            try:
                data = json.loads(body)
            except ValueError:
                return _err(400, "Ungültige Daten")
        if request.method == "DELETE" and data:
            # Proxmox erwartet DELETE-Parameter in der Query
            q = _encode_form(data).decode()
            data = None
            query = "&".join(x for x in (request.url.query, q) if x)
        else:
            query = request.url.query
    else:
        query = request.url.query
    try:
        status, res = await pve_call(request.method, path, s.ticket, s.csrf, data, query)
    except PveError as e:
        if e.status == 401:
            SESSIONS.pop(s.id, None)
        return _err(e.status, e.message, errors=e.errors)
    return JSONResponse(res, status_code=status)


# --------------------------------------------------------------------------
# Skript-Katalog (community-scripts)
# --------------------------------------------------------------------------

CATALOG_CACHE: dict = {"time": 0, "items": []}
SCRIPT_PATH = re.compile(r"^(ct|vm|tools/pve)/[A-Za-z0-9._-]+\.sh$")

# Kuratierte Auswahl mit deutschen Beschreibungen. Alles andere erscheint automatisch im Katalog.
FEATURED = {
    "vm/haos-vm.sh": ("Home Assistant OS", "Smart Home – die komplette Home-Assistant-Installation als VM.", "Smart Home"),
    "ct/homeassistant.sh": ("Home Assistant (Container)", "Home Assistant in einem leichten Container mit Docker.", "Smart Home"),
    "ct/iobroker.sh": ("ioBroker", "Smart-Home-Zentrale, beliebt im deutschsprachigen Raum.", "Smart Home"),
    "ct/mqtt.sh": ("MQTT (Mosquitto)", "Nachrichten-Broker für Smart-Home-Geräte.", "Smart Home"),
    "ct/zigbee2mqtt.sh": ("Zigbee2MQTT", "Zigbee-Geräte ohne Hersteller-Bridge nutzen.", "Smart Home"),
    "ct/node-red.sh": ("Node-RED", "Automationen per Drag & Drop bauen.", "Smart Home"),
    "ct/esphome.sh": ("ESPHome", "Eigene ESP32/ESP8266-Geräte flashen und verwalten.", "Smart Home"),
    "ct/adguard.sh": ("AdGuard Home", "Werbung und Tracker im ganzen Netzwerk blockieren.", "Netzwerk"),
    "ct/pihole.sh": ("Pi-hole", "Netzwerkweiter Werbeblocker per DNS.", "Netzwerk"),
    "ct/nginxproxymanager.sh": ("Nginx Proxy Manager", "Dienste unter schönen Adressen mit HTTPS erreichbar machen.", "Netzwerk"),
    "ct/wireguard.sh": ("WireGuard", "Sicherer VPN-Zugang von unterwegs ins Heimnetz.", "Netzwerk"),
    "ct/cloudflared.sh": ("Cloudflare Tunnel", "Dienste ohne Portfreigabe veröffentlichen.", "Netzwerk"),
    "ct/uptimekuma.sh": ("Uptime Kuma", "Überwacht, ob deine Dienste erreichbar sind.", "Netzwerk"),
    "ct/jellyfin.sh": ("Jellyfin", "Eigener Streaming-Server für Filme und Serien.", "Medien"),
    "ct/plex.sh": ("Plex", "Medienserver für Filme, Serien und Musik.", "Medien"),
    "ct/immich.sh": ("Immich", "Eigene Foto-Cloud – wie Google Fotos, nur bei dir.", "Medien"),
    "ct/navidrome.sh": ("Navidrome", "Musik-Streaming für deine eigene Sammlung.", "Medien"),
    "ct/audiobookshelf.sh": ("Audiobookshelf", "Hörbücher und Podcasts selbst hosten.", "Medien"),
    "ct/frigate.sh": ("Frigate", "Kamera-Aufzeichnung mit Personen- und Objekterkennung.", "Medien"),
    "ct/vaultwarden.sh": ("Vaultwarden", "Eigener Passwort-Manager, kompatibel mit Bitwarden.", "Daten"),
    "ct/paperless-ngx.sh": ("Paperless-ngx", "Papierloses Büro: Dokumente scannen, durchsuchen, ablegen.", "Daten"),
    "ct/nextcloudpi.sh": ("Nextcloud", "Eigene Cloud für Dateien, Kalender und Kontakte.", "Daten"),
    "ct/syncthing.sh": ("Syncthing", "Ordner zwischen Geräten synchron halten.", "Daten"),
    "ct/mealie.sh": ("Mealie", "Rezepte sammeln, Wochenplan und Einkaufsliste.", "Daten"),
    "ct/homepage.sh": ("Homepage", "Startseite mit Übersicht über alle deine Dienste.", "Werkzeuge"),
    "ct/docker.sh": ("Docker", "Container mit Docker und optional Portainer.", "Werkzeuge"),
    "vm/docker-vm.sh": ("Docker (VM)", "Eine VM mit Docker – gut für viele Container.", "Werkzeuge"),
    "ct/grafana.sh": ("Grafana", "Schöne Diagramme und Dashboards für Messwerte.", "Werkzeuge"),
    "ct/n8n.sh": ("n8n", "Workflows und Automationen zwischen Apps.", "Werkzeuge"),
    "ct/ollama.sh": ("Ollama", "KI-Sprachmodelle lokal betreiben.", "KI"),
    "ct/openwebui.sh": ("Open WebUI", "Chat-Oberfläche für lokale KI-Modelle.", "KI"),
    "ct/debian.sh": ("Debian", "Leerer Debian-Container als Basis für eigene Projekte.", "Betriebssysteme"),
    "ct/ubuntu.sh": ("Ubuntu", "Leerer Ubuntu-Container.", "Betriebssysteme"),
    "ct/alpine.sh": ("Alpine", "Sehr kleiner Linux-Container.", "Betriebssysteme"),
    "vm/debian-vm.sh": ("Debian (VM)", "Debian als vollständige virtuelle Maschine.", "Betriebssysteme"),
    "tools/pve/post-pve-install.sh": ("Proxmox nach der Installation", "Paketquellen einrichten, Abo-Hinweis entfernen, Updates.", "Proxmox-Pflege"),
    "tools/pve/update-lxcs.sh": ("Alle Container aktualisieren", "Spielt Updates in allen LXC-Containern ein.", "Proxmox-Pflege"),
    "tools/pve/clean-lxcs.sh": ("Container aufräumen", "Löscht Paket-Caches und alte Logs in Containern.", "Proxmox-Pflege"),
    "tools/pve/kernel-clean.sh": ("Alte Kernel entfernen", "Gibt Speicherplatz frei.", "Proxmox-Pflege"),
    "tools/pve/microcode.sh": ("Prozessor-Microcode", "Sicherheits-Updates für die CPU einspielen.", "Proxmox-Pflege"),
}


def _title_from_path(p: str) -> str:
    name = p.rsplit("/", 1)[1][:-3]
    name = re.sub(r"[-_]+", " ", name).strip()
    return " ".join(w if w.isupper() else w.capitalize() for w in name.split())


def _fetch_catalog_sync() -> list[dict]:
    url = f"https://api.github.com/repos/{SCRIPTS_REPO}/git/trees/{SCRIPTS_BRANCH}?recursive=1"
    req = urllib.request.Request(url, headers={"User-Agent": "BetterProxmoxUI", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        tree = json.loads(resp.read())
    items = []
    for node in tree.get("tree", []):
        p = node.get("path", "")
        if node.get("type") != "blob" or not SCRIPT_PATH.match(p):
            continue
        kind = "vm" if p.startswith("vm/") else ("tool" if p.startswith("tools/") else "ct")
        title, desc, cat = FEATURED.get(p, (_title_from_path(p), "", ""))
        items.append({"path": p, "kind": kind, "title": title, "description": desc,
                      "category": cat, "featured": p in FEATURED})
    items.sort(key=lambda x: (not x["featured"], x["title"].lower()))
    return items


async def scripts_catalog(request: Request):
    s = await get_session(request)
    if not s:
        return _err(401, "Nicht angemeldet")
    cache_file = STATE_DIR / "catalog.json"
    if time.time() - CATALOG_CACHE["time"] > 6 * 3600 or request.query_params.get("refresh"):
        try:
            items = await asyncio.to_thread(_fetch_catalog_sync)
            CATALOG_CACHE.update(time=time.time(), items=items)
            try:
                STATE_DIR.mkdir(parents=True, exist_ok=True)
                cache_file.write_text(json.dumps(items))
            except OSError:
                pass
        except Exception:
            if not CATALOG_CACHE["items"] and cache_file.exists():
                CATALOG_CACHE["items"] = json.loads(cache_file.read_text())
            if not CATALOG_CACHE["items"]:
                CATALOG_CACHE["items"] = [
                    {"path": p, "kind": "vm" if p.startswith("vm/") else ("tool" if p.startswith("tools/") else "ct"),
                     "title": t, "description": d, "category": c, "featured": True}
                    for p, (t, d, c) in FEATURED.items()]
    return JSONResponse({"data": CATALOG_CACHE["items"], "host_admin": s.host_admin})


# --------------------------------------------------------------------------
# Jobs: Host-Befehle in einem Pseudo-Terminal, laufen auch ohne offenen Browser weiter
# --------------------------------------------------------------------------

MAX_BUFFER = 1024 * 1024
MAX_RUNNING = 3


class Job:
    def __init__(self, title: str, kind: str, argv: list[str], owner: str, env: dict | None = None):
        self.id = secrets.token_hex(6)
        self.title = title
        self.kind = kind
        self.owner = owner
        self.started = time.time()
        self.ended: float | None = None
        self.exit_code: int | None = None
        self.buffer = bytearray()
        self.clients: set[asyncio.Queue] = set()
        self.loop = asyncio.get_running_loop()

        full_env = {"TERM": "xterm-256color", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
                    "HOME": "/root", "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
        full_env.update(env or {})
        pid, fd = pty.fork()
        if pid == 0:  # Kindprozess
            try:
                os.chdir("/root")
            except OSError:
                pass
            os.execvpe(argv[0], argv, full_env)
        self.pid, self.fd = pid, fd
        self.resize(120, 32)
        fl = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)
        self.loop.add_reader(fd, self._on_output)

    @property
    def running(self) -> bool:
        return self.exit_code is None

    def info(self) -> dict:
        return {"id": self.id, "title": self.title, "kind": self.kind, "owner": self.owner,
                "started": self.started, "ended": self.ended, "running": self.running,
                "exit_code": self.exit_code}

    def _broadcast(self, item):
        for q in list(self.clients):
            q.put_nowait(item)

    def _on_output(self):
        try:
            data = os.read(self.fd, 65536)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if data:
            self.buffer.extend(data)
            if len(self.buffer) > MAX_BUFFER:
                del self.buffer[: len(self.buffer) - MAX_BUFFER]
            self._broadcast(data)
            return
        self._finish()

    def _finish(self):
        try:
            self.loop.remove_reader(self.fd)
        except Exception:
            pass
        code = -1
        try:
            _, status = os.waitpid(self.pid, 0)
            code = os.waitstatus_to_exitcode(status)
        except ChildProcessError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass
        self.exit_code = code
        self.ended = time.time()
        msg = f"\r\n\x1b[1;{32 if code == 0 else 31}m── Beendet (Code {code}) ──\x1b[0m\r\n".encode()
        self.buffer.extend(msg)
        self._broadcast(msg)
        self._broadcast({"type": "exit", "code": code})

    def write(self, data: bytes):
        if self.running:
            try:
                os.write(self.fd, data)
            except OSError:
                pass

    def resize(self, cols: int, rows: int):
        if self.running:
            try:
                fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            except OSError:
                pass

    def kill(self):
        if self.running:
            try:
                os.killpg(os.getpgid(self.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass


JOBS: dict[str, Job] = {}


def _prune_jobs():
    done = sorted((j for j in JOBS.values() if not j.running), key=lambda j: j.ended or 0)
    while len(done) > 20:
        JOBS.pop(done.pop(0).id, None)
    for j in done:
        if time.time() - (j.ended or 0) > 24 * 3600:
            JOBS.pop(j.id, None)


def _raw_url(path: str) -> str:
    return f"https://raw.githubusercontent.com/{SCRIPTS_REPO}/{SCRIPTS_BRANCH}/{path}"


async def jobs_list(request: Request):
    s = await get_session(request)
    if not s:
        return _err(401, "Nicht angemeldet")
    _prune_jobs()
    items = sorted((j.info() for j in JOBS.values()), key=lambda x: -x["started"])
    return JSONResponse({"data": items})


async def jobs_create(request: Request):
    s = await get_session(request)
    if not s:
        return _err(401, "Nicht angemeldet")
    if not s.host_admin:
        return _err(403, "Diese Aktion ist nur für root@pam erlaubt – genau wie die Host-Shell in Proxmox.")
    if sum(1 for j in JOBS.values() if j.running) >= MAX_RUNNING:
        return _err(429, "Es laufen schon zu viele Aufgaben gleichzeitig.")
    body = await request.json()
    kind = body.get("kind")
    if kind == "script":
        path = body.get("path") or ""
        if not SCRIPT_PATH.match(path) or ".." in path:
            return _err(400, "Unbekanntes Skript")
        title = body.get("title") or _title_from_path(path)
        argv = ["bash", "-c", f'bash -c "$(curl -fsSL {_raw_url(path)})"']
    elif kind == "upgrade":
        title = "Proxmox-Updates installieren"
        argv = ["bash", "-c", "apt-get update && apt-get -y dist-upgrade; echo; "
                "if [ -f /var/run/reboot-required ] || [ \"$(uname -r)\" != \"$(ls -t /boot/vmlinuz-* | head -1 | sed 's#/boot/vmlinuz-##')\" ]; "
                "then echo 'Hinweis: Für den neuen Kernel ist ein Neustart nötig.'; fi"]
    elif kind == "shell":
        title = "Host-Konsole"
        argv = ["bash", "-l"]
    elif kind == "selfupdate":
        title = "BetterProxmoxUI aktualisieren"
        # Läuft außerhalb des eigenen Dienstes, weil der Dienst dabei neu gestartet wird.
        argv = ["bash", "-c", f"systemd-run --unit=bpui-selfupdate-$(date +%s) --collect "
                f"bash {INSTALL_DIR}/install.sh --update && echo 'Update läuft im Hintergrund. "
                f"Die Seite lädt gleich neu.'"]
    else:
        return _err(400, "Unbekannte Aktion")
    job = Job(title, kind, argv, s.username)
    JOBS[job.id] = job
    return JSONResponse({"data": job.info()})


async def jobs_kill(request: Request):
    s = await get_session(request)
    if not s or not s.host_admin:
        return _err(403, "Nicht erlaubt")
    job = JOBS.get(request.path_params["job_id"])
    if not job:
        return _err(404, "Aufgabe nicht gefunden")
    job.kill()
    return JSONResponse({"ok": True})


async def job_socket(ws: WebSocket):
    s = await get_session(ws)
    job = JOBS.get(ws.path_params["job_id"])
    if not s or not s.host_admin or not job:
        await ws.close(code=4401)
        return
    await ws.accept()
    queue: asyncio.Queue = asyncio.Queue()
    if bytes(job.buffer):
        await ws.send_bytes(bytes(job.buffer))
    if not job.running:
        await ws.send_text(json.dumps({"type": "exit", "code": job.exit_code}))
    job.clients.add(queue)

    async def sender():
        while True:
            item = await queue.get()
            if isinstance(item, (bytes, bytearray)):
                await ws.send_bytes(bytes(item))
            else:
                await ws.send_text(json.dumps(item))

    async def receiver():
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                return
            text = msg.get("text")
            if text is None:
                continue
            try:
                m = json.loads(text)
            except ValueError:
                continue
            if m.get("type") == "input":
                job.write(str(m.get("data", "")).encode())
            elif m.get("type") == "resize":
                job.resize(max(20, min(int(m.get("cols", 80)), 400)), max(5, min(int(m.get("rows", 24)), 200)))

    tasks = [asyncio.create_task(sender()), asyncio.create_task(receiver())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except WebSocketDisconnect:
        pass
    finally:
        for t in tasks:
            t.cancel()
        job.clients.discard(queue)
        try:
            await ws.close()
        except Exception:
            pass


# --------------------------------------------------------------------------
# Frontend ausliefern
# --------------------------------------------------------------------------


async def index(request: Request):
    return FileResponse(FRONTEND_DIR / "index.html", headers={"cache-control": "no-cache"})


async def health(request: Request):
    return JSONResponse({"ok": True, "version": VERSION})


routes = [
    Route("/api/health", health),
    Route("/api/realms", realms),
    Route("/api/login", login, methods=["POST"]),
    Route("/api/login/tfa", login_tfa, methods=["POST"]),
    Route("/api/logout", logout, methods=["POST"]),
    Route("/api/me", me),
    Route("/api/scripts", scripts_catalog),
    Route("/api/jobs", jobs_list, methods=["GET"]),
    Route("/api/jobs", jobs_create, methods=["POST"]),
    Route("/api/jobs/{job_id}/kill", jobs_kill, methods=["POST"]),
    WebSocketRoute("/api/jobs/{job_id}/ws", job_socket),
    Route("/api/pve/{path:path}", pve_proxy, methods=["GET", "POST", "PUT", "DELETE"]),
    Route("/", index),
    Mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static"),
]

app = Starlette(routes=routes, middleware=[Middleware(GuardMiddleware)])
