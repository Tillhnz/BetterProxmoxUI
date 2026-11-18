#!/usr/bin/env python3
"""Proxmox Zentrale – eine Maschine (Container oder VM) aktualisieren.

Aufruf: guest-update.py <lxc|qemu> <vmid> <aktionen> <snapshot:0|1> [compose-dateien …]
  aktionen: kommagetrennt aus system, script (Community-Scripts „update“), compose (Docker-Compose-Apps)

* Container: Befehle laufen per `pct exec` direkt im Container (mit Terminal, also auch interaktiv).
* VMs: Befehle laufen über den QEMU-Gast-Agenten; die Ausgabe wird aus einer Protokolldatei
  in der VM nachgelesen, damit man den Fortschritt live sieht.
"""
import base64
import contextlib
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time

# Läuft in der Maschine (POSIX-sh): erkennt das System und nimmt den passenden Update-Befehl.
INNER = r'''
[ -r /etc/os-release ] && . /etc/os-release
echo "System: ${PRETTY_NAME:-unbekannt}"
echo
run() { printf '\033[1;34m$ %s\033[0m\n' "$*"; "$@"; }
case " ${ID:-} ${ID_LIKE:-} " in
  *" haos "*)
    echo "Home Assistant OS aktualisiert sich über die eigene Oberfläche: Einstellungen → System → Updates."; exit 3 ;;
  *" debian "*|*" ubuntu "*)
    export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
    run apt-get update && \
    run apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade && \
    run apt-get -y autoremove --purge && run apt-get clean ;;
  *" alpine "*)
    run apk update && run apk upgrade ;;
  *" arch "*)
    run pacman -Syu --noconfirm ;;
  *" fedora "*|*" rhel "*|*" centos "*)
    if command -v dnf >/dev/null 2>&1; then run dnf -y upgrade; else run yum -y update; fi ;;
  *" suse "*|*" opensuse "*)
    run zypper --non-interactive refresh && run zypper --non-interactive update ;;
  *)
    echo "Dieses System (${ID:-unbekannt}) kennt die Zentrale noch nicht – bitte von Hand aktualisieren."; exit 4 ;;
esac
rc=$?
echo
if [ $rc -eq 0 ]; then printf '\033[1;32m✔ Updates installiert.\033[0m\n'; else printf '\033[1;31m✘ Update mit Fehler beendet (%s).\033[0m\n' "$rc"; fi
if [ -f /var/run/reboot-required ]; then echo "Hinweis: Für einige Updates ist ein Neustart der Maschine nötig."; fi
exit $rc
'''

# Docker-Compose-Apps auf die neuesten Images bringen ("$@" = compose-Dateien)
COMPOSE_INNER = r'''
dc() { if docker compose version >/dev/null 2>&1; then docker compose "$@"; else docker-compose "$@"; fi; }
vers() { ids=$(dc -f "$1" ps -q 2>/dev/null); [ -n "$ids" ] && docker inspect --format '  {{.Name}}: {{.Config.Image}} {{index .Config.Labels "org.opencontainers.image.version"}}' $ids | sed 's#^  /#  #'; }
rc=0
for f in "$@"; do
  printf '\n\033[1;36m━━ App: %s ━━\033[0m\n' "$f"
  cd "$(dirname "$f")" || { rc=1; continue; }
  echo "Vorher:"; vers "$f"
  printf '\033[1;34m$ docker compose pull\033[0m\n'
  dc -f "$f" pull || { echo "✘ Herunterladen fehlgeschlagen"; rc=1; continue; }
  printf '\033[1;34m$ docker compose up -d\033[0m\n'
  dc -f "$f" up -d --remove-orphans || { echo "✘ Neustart fehlgeschlagen"; rc=1; continue; }
  echo; echo "Jetzt:"; vers "$f"
done
printf '\033[1;34m$ docker image prune -f\033[0m  (alte Images aufräumen)\n'
docker image prune -f >/dev/null 2>&1 && echo "Alte Images entfernt."
echo
if [ $rc -eq 0 ]; then printf '\033[1;32m✔ Apps aktualisiert.\033[0m\n'; else printf '\033[1;31m✘ Mindestens eine App hatte Fehler.\033[0m\n'; fi
exit $rc
'''

LOG = "/var/tmp/bpui-update.log"
RC = "/var/tmp/bpui-update.rc"


def say(msg, color="36"):
    print(f"\n\033[1;{color}m━━ {msg} ━━\033[0m", flush=True)


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def pvesh_json(path):
    r = run(["pvesh", "get", path, "--output-format", "json"])
    return json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else None


def snapshot(kind, vmid):
    tool = "pct" if kind == "lxc" else "qm"
    name = time.strftime("vor_update_%Y%m%d_%H%M")
    say("Sicherungspunkt (Snapshot) anlegen")
    r = run([tool, "snapshot", vmid, name, "--description", "Automatisch vor dem Update (Proxmox Zentrale)"])
    if r.returncode != 0:
        print("⚠ Snapshot nicht möglich (" + (r.stderr.strip().splitlines() or ["unbekannt"])[-1] + ").")
        print("  Das Update läuft trotzdem weiter. Für Snapshots braucht die Festplatte z. B. LVM-Thin oder ZFS.")
        return
    print(f"✔ Snapshot „{name}“ angelegt – darauf kannst du im Reiter Sicherungen zurückspringen.")
    # Alte automatische Snapshots aufräumen (die letzten 3 bleiben)
    snaps = pvesh_json(f"/nodes/{socket.gethostname()}/{kind}/{vmid}/snapshot") or []
    ours = sorted(s["name"] for s in snaps if str(s.get("name", "")).startswith("vor_update_"))
    for old in ours[:-3]:
        if run([tool, "delsnapshot", vmid, old]).returncode == 0:
            print(f"  Alten Snapshot „{old}“ aufgeräumt.")


def host_mem_available():
    with contextlib.suppress(OSError):
        for line in open("/proc/meminfo"):
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    return 0


def lxc_conf(vmid):
    out = {}
    for line in run(["pct", "config", vmid]).stdout.splitlines():
        k, _, v = line.partition(":")
        out[k.strip()] = v.strip()
    return out


@contextlib.contextmanager
def update_boost(vmid, boost):
    """Gibt dem Container für die Dauer des App-Updates so viel RAM/Kerne, wie das Update-Skript verlangt –
    danach wird wieder auf die alten Werte zurückgestellt. Container übernehmen das ohne Neustart."""
    if not boost:
        yield
        return
    need_ram, need_cpu, app = boost
    conf = lxc_conf(vmid)
    cur_ram, cur_cpu = int(conf.get("memory", 512)), int(conf.get("cores", 0) or 0)
    changes, restore = [], []
    if cur_ram < need_ram:
        free = host_mem_available()
        give = min(need_ram, cur_ram + max(0, free - 1024))  # 1 GB für den Server übrig lassen
        if give > cur_ram:
            changes += ["--memory", str(give)]
            restore += ["--memory", str(cur_ram)]
            print(f"\033[1;33m↑\033[0m Für das Update braucht {app} etwa {need_ram} MB RAM, der Container hat {cur_ram} MB – "
                  f"wird für die Dauer des Updates auf {give} MB erhöht.", flush=True)
            if give < need_ram:
                print(f"  Mehr ist gerade nicht frei auf dem Server (frei: {free} MB). Das Update kann trotzdem knapp werden.", flush=True)
        else:
            print(f"⚠ {app} braucht für das Update etwa {need_ram} MB RAM, auf dem Server ist aber kaum etwas frei.", flush=True)
    if cur_cpu and cur_cpu < need_cpu:
        changes += ["--cores", str(need_cpu)]
        restore += ["--cores", str(cur_cpu)]
        print(f"\033[1;33m↑\033[0m Kerne für die Dauer des Updates: {cur_cpu} → {need_cpu}", flush=True)
    if changes:
        r = run(["pct", "set", vmid, *changes])
        if r.returncode != 0:
            print(f"⚠ Konnte die Größe nicht anpassen: {r.stderr.strip()[-200:]}", flush=True)
            changes = []
    try:
        yield
    finally:
        if changes:
            r = run(["pct", "set", vmid, *restore])
            print(("\033[1;32m↓\033[0m Größe wieder zurückgestellt (" + " ".join(restore[1::2]) + ")") if r.returncode == 0
                  else f"⚠ Größe konnte nicht zurückgestellt werden – bitte von Hand prüfen ({' '.join(restore)}).", flush=True)


def fix_update_source(vmid):
    """Ältere Container rufen beim „update“ noch das stillgelegte Original-Repo tteck/Proxmox auf. Dessen Skripte
    passen nicht mehr zu neuen App-Versionen und brechen mittendrin ab. → auf community-scripts/ProxmoxVE umstellen."""
    r = run(["pct", "exec", vmid, "--", "cat", "/usr/bin/update"])
    if "tteck/Proxmox" not in r.stdout:
        return
    m = re.search(r"ct/([\w.-]+\.sh)", r.stdout)
    url = f"https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/{m.group(1)}" if m else None
    exists = False
    if url:
        import urllib.request
        with contextlib.suppress(Exception):
            req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "BetterProxmoxUI"})
            exists = urllib.request.urlopen(req, timeout=10).status == 200
    if not exists:
        print("\033[1;33m⚠ Dieser Container nutzt noch das alte, stillgelegte Update-Skript (tteck/Proxmox) – "
              "ein aktuelles Gegenstück wurde nicht gefunden. Das Update kann scheitern.\033[0m", flush=True)
        return
    run(["pct", "exec", vmid, "--", "sed", "-i", "s#tteck/Proxmox#community-scripts/ProxmoxVE#g", "/usr/bin/update"])
    print("\033[1;33m↻\033[0m Update-Quelle von tteck/Proxmox (stillgelegt) auf community-scripts/ProxmoxVE umgestellt.", flush=True)


def lxc_running(vmid):
    return "running" in run(["pct", "status", vmid]).stdout


def update_lxc(vmid, action, files, boost=None):
    if action in ("script", "compose") and boost:
        with update_boost(vmid, boost):
            return update_lxc(vmid, action, files)
    if not lxc_running(vmid):
        print("Der Container ist ausgeschaltet – bitte zuerst starten."); return 1
    if action == "script":
        say("App aktualisieren (Update-Skript der Community-Scripts)")
        fix_update_source(vmid)
        print("Falls Fragen kommen: meist einfach mit Enter bestätigen.\n", flush=True)
        return subprocess.call(["pct", "exec", vmid, "--", "bash", "-lc", "update"])
    if action == "compose":
        say("Docker-Apps auf die neueste Version bringen")
        return subprocess.call(["pct", "exec", vmid, "--", "sh", "-c", COMPOSE_INNER, "sh", *files])
    say("System-Pakete aktualisieren")
    return subprocess.call(["pct", "exec", vmid, "--", "sh", "-c", INNER])


def agent(vmid, *args, timeout=60):
    r = run(["qm", "guest", "exec", vmid, "--timeout", str(timeout), "--", *args])
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or r.stdout.strip())
    return json.loads(r.stdout or "{}")


def update_qemu(vmid, action="system", files=()):
    script = INNER if action == "system" else COMPOSE_INNER
    say("System-Pakete aktualisieren (über den QEMU-Gast-Agenten)" if action == "system"
        else "Docker-Apps auf die neueste Version bringen (über den QEMU-Gast-Agenten)")
    try:
        agent(vmid, "sh", "-c", f"rm -f {LOG} {RC}")
        # Im Hintergrund starten; Ausgabe landet in einer Datei in der VM
        r = run(["qm", "guest", "exec", vmid, "--synchronous", "0", "--", "sh", "-c",
                 f"( {script} ) >{LOG} 2>&1; echo $? >{RC}", "sh", *files])
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip())
    except Exception as e:  # noqa: BLE001
        print(f"Der Gast-Agent antwortet nicht: {e}")
        print("Ist in der VM „qemu-guest-agent“ installiert und läuft? Ist er in den Einstellungen aktiviert?")
        return 1
    offset, misses = 0, 0
    while True:
        time.sleep(2)
        try:
            res = agent(vmid, "sh", "-c",
                        # Erst den Rückgabewert lesen: ist er da, ist das Protokoll vollständig
                        f"cat {RC} 2>/dev/null; echo; tail -c +{offset + 1} {LOG} 2>/dev/null | head -c 65536 | base64 | tr -d '\\n'")
            misses = 0
        except Exception:  # noqa: BLE001
            misses += 1
            if misses > 30:
                print("\nDie VM antwortet nicht mehr. Bitte später nachsehen."); return 1
            continue
        out = (res.get("out-data") or "").split("\n", 1)
        rc = out[0].strip()
        b64 = out[1].strip() if len(out) > 1 else ""
        chunk = base64.b64decode(b64) if b64 else b""
        if chunk:
            os.write(1, chunk)
            offset += len(chunk)
        if rc and len(chunk) < 65536:
            return int(rc) if rc.isdigit() else 1


def main():
    if len(sys.argv) < 5 or sys.argv[1] not in ("lxc", "qemu") or not sys.argv[2].isdigit() or sys.argv[4] not in ("0", "1"):
        print(__doc__); return 2
    kind, vmid, actions, snap = sys.argv[1:5]
    # Beim Abbrechen sauber beenden, damit eine vorübergehende Größenänderung zurückgestellt wird
    for sig in (signal.SIGHUP, signal.SIGTERM):
        signal.signal(sig, lambda *_: sys.exit(130))
    files = [f for f in sys.argv[5:] if f.startswith("/")]
    boost = None
    for a in sys.argv[5:]:
        m = re.fullmatch(r"boost=(\d+):(\d+):([\w.-]+)", a)
        if m:
            boost = (int(m.group(1)), int(m.group(2)), m.group(3))
    actions = [a for a in actions.split(",") if a in ("system", "script", "compose")]
    if not actions or ("script" in actions and kind != "lxc") or ("compose" in actions and not files):
        print(__doc__); return 2
    if snap == "1":
        snapshot(kind, vmid)
    rc = 0
    for a in actions:  # Reihenfolge: erst System, dann Apps
        r = update_lxc(vmid, a, files, boost) if kind == "lxc" else update_qemu(vmid, a, files)
        rc = rc or r
    if len(actions) > 1:
        print(("\n\033[1;32m✔ Alles aktualisiert.\033[0m" if rc == 0 else "\n\033[1;33m⚠ Fertig, aber nicht alles hat geklappt – siehe oben.\033[0m"), flush=True)
    return rc


if __name__ == "__main__":
    sys.exit(main())
