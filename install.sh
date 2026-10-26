#!/usr/bin/env bash
# ===========================================================================
#  Proxmox Zentrale (BetterProxmoxUI) – Installer
#
#  Installieren:   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Tillhnz/BetterProxmoxUI/main/install.sh)"
#  Aktualisieren:  bash /opt/better-proxmox-ui/install.sh --update
#  Entfernen:      bash /opt/better-proxmox-ui/install.sh --uninstall
# ===========================================================================
set -euo pipefail

# >>> Hier deinen GitHub-Benutzernamen bzw. dein Repository eintragen <<<
REPO="${BPUI_REPO:-Tillhnz/BetterProxmoxUI}"
BRANCH="${BPUI_BRANCH:-main}"

INSTALL_DIR="/opt/better-proxmox-ui"
SERVICE="better-proxmox-ui"
ENV_FILE="/etc/better-proxmox-ui.env"
STATE_DIR="/var/lib/better-proxmox-ui"
XTERM_VERSION="5.5.0"
XTERM_FIT_VERSION="0.10.0"

C_OK=$'\e[1;32m'; C_ERR=$'\e[1;31m'; C_INFO=$'\e[1;36m'; C_DIM=$'\e[2m'; C_OFF=$'\e[0m'
step() { echo "${C_INFO}›${C_OFF} $*"; }
ok()   { echo "${C_OK}✔${C_OFF} $*"; }
die()  { echo "${C_ERR}✘ $*${C_OFF}" >&2; exit 1; }

MODE="install"
case "${1:-}" in
  --update)    MODE="update" ;;
  --uninstall) MODE="uninstall" ;;
  ""|--install) ;;
  *) die "Unbekannte Option: $1 (erlaubt: --update, --uninstall)" ;;
esac

[[ $EUID -eq 0 ]] || die "Bitte als root ausführen."

# Läuft das Skript aus dem Installationsordner, wird es gleich überschrieben →
# vorher eine Kopie ausführen.
if [[ "${BASH_SOURCE[0]:-}" == "$INSTALL_DIR/install.sh" && -z "${BPUI_REEXEC:-}" ]]; then
  TMP="$(mktemp /tmp/bpui-install.XXXXXX.sh)"
  cp "$INSTALL_DIR/install.sh" "$TMP"
  BPUI_REEXEC=1 exec bash "$TMP" "$@"
fi

# Repository aus der bestehenden Konfiguration übernehmen (z. B. bei Updates)
if [[ -z "${BPUI_REPO:-}" && -f "$ENV_FILE" ]]; then
  _r="$(grep -E '^BPUI_REPO=' "$ENV_FILE" | cut -d= -f2- || true)"; [[ -n "$_r" ]] && REPO="$_r"
  _b="$(grep -E '^BPUI_BRANCH=' "$ENV_FILE" | cut -d= -f2- || true)"; [[ -n "$_b" ]] && BRANCH="$_b"
fi
command -v pveversion >/dev/null 2>&1 || die "Das ist kein Proxmox-VE-Server (pveversion nicht gefunden)."

# ---------------------------------------------------------------------------
if [[ $MODE == "uninstall" ]]; then
  step "Entferne Proxmox Zentrale …"
  systemctl disable --now "$SERVICE" 2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE}.service"
  systemctl daemon-reload
  rm -rf "$INSTALL_DIR" "$STATE_DIR"
  rm -f "$ENV_FILE"
  ok "Entfernt. Proxmox selbst wurde nicht verändert."
  exit 0
fi


echo
echo "  ${C_INFO}Proxmox Zentrale${C_OFF} ${C_DIM}– eine einfache Oberfläche für Proxmox VE${C_OFF}"
echo

# ---------------------------------------------------------------------------
step "Benötigte Pakete installieren …"
export DEBIAN_FRONTEND=noninteractive
NEED=()
for p in git python3 python3-venv curl ca-certificates; do dpkg -s "$p" >/dev/null 2>&1 || NEED+=("$p"); done
if ((${#NEED[@]})); then
  apt-get update -qq || true
  apt-get install -y -qq "${NEED[@]}" >/dev/null
fi
ok "Pakete vorhanden"

# ---------------------------------------------------------------------------
step "Programm von GitHub laden (${REPO}, Zweig ${BRANCH}) …"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" remote set-url origin "https://github.com/${REPO}.git"
  git -C "$INSTALL_DIR" fetch -q --depth 1 origin "$BRANCH"
  git -C "$INSTALL_DIR" reset -q --hard FETCH_HEAD
else
  rm -rf "$INSTALL_DIR"
  git clone -q --depth 1 --branch "$BRANCH" "https://github.com/${REPO}.git" "$INSTALL_DIR" \
    || die "Konnte https://github.com/${REPO} nicht laden. Ist das Repository öffentlich?"
fi
ok "Version $(cat "$INSTALL_DIR/VERSION" 2>/dev/null || echo '?')"

# ---------------------------------------------------------------------------
step "Python-Umgebung einrichten …"
if [[ ! -x "$INSTALL_DIR/.venv/bin/python" ]]; then
  python3 -m venv "$INSTALL_DIR/.venv"
fi
"$INSTALL_DIR/.venv/bin/pip" install -q --upgrade pip >/dev/null
"$INSTALL_DIR/.venv/bin/pip" install -q -r "$INSTALL_DIR/backend/requirements.txt"
ok "Python-Umgebung bereit"

# ---------------------------------------------------------------------------
step "Terminal-Komponente laden …"
VENDOR="$INSTALL_DIR/frontend/vendor/xterm"
mkdir -p "$VENDOR"
CDN="https://cdn.jsdelivr.net/npm"
if curl -fsSL "$CDN/@xterm/xterm@${XTERM_VERSION}/lib/xterm.js" -o "$VENDOR/xterm.js" \
  && curl -fsSL "$CDN/@xterm/xterm@${XTERM_VERSION}/css/xterm.css" -o "$VENDOR/xterm.css" \
  && curl -fsSL "$CDN/@xterm/addon-fit@${XTERM_FIT_VERSION}/lib/addon-fit.js" -o "$VENDOR/addon-fit.js"; then
  ok "Terminal-Komponente lokal gespeichert"
else
  echo "  ${C_DIM}Hinweis: Download fehlgeschlagen – der Browser lädt sie dann direkt aus dem Internet.${C_OFF}"
fi

# ---------------------------------------------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  step "Konfiguration anlegen …"
  # IP-Adresse im lokalen Netz ermitteln (Schnittstelle der Standardroute)
  DEV="$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')"
  BIND_IP="$(ip -4 -o addr show dev "${DEV:-vmbr0}" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1)"
  [[ -n "$BIND_IP" ]] || BIND_IP="$(hostname -I | awk '{print $1}')"
  [[ -n "$BIND_IP" ]] || die "Konnte die IP-Adresse des Servers nicht ermitteln. Bitte BPUI_BIND in $ENV_FILE setzen."
  cat > "$ENV_FILE" <<EOF
# Proxmox Zentrale – Einstellungen. Nach Änderungen: systemctl restart ${SERVICE}

# Auf welcher IP-Adresse und welchem Port die Oberfläche erreichbar ist
BPUI_BIND=${BIND_IP}
BPUI_PORT=8443

# Zusätzlich erlaubte Netze (kommagetrennt). Private Netze (192.168.x.x, 10.x.x.x,
# 172.16-31.x.x) sind immer erlaubt. Beispiel Tailscale: 100.64.0.0/10
BPUI_ALLOW_NETS=

# Skripte, Updates und Host-Konsole erlauben (1 = an, 0 = aus) und für wen
BPUI_HOST_ACTIONS=1
BPUI_HOST_ADMINS=root@pam

# Repository für Selbst-Updates
BPUI_REPO=${REPO}
BPUI_BRANCH=${BRANCH}
EOF
  chmod 600 "$ENV_FILE"
  ok "Konfiguration: $ENV_FILE"
else
  # Repository für Updates aktuell halten
  if grep -q '^BPUI_REPO=' "$ENV_FILE"; then sed -i "s#^BPUI_REPO=.*#BPUI_REPO=${REPO}#" "$ENV_FILE"; else echo "BPUI_REPO=${REPO}" >> "$ENV_FILE"; fi
fi
# shellcheck disable=SC1090
source "$ENV_FILE"
mkdir -p "$STATE_DIR"

# ---------------------------------------------------------------------------
step "Dienst einrichten …"
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=Proxmox Zentrale (BetterProxmoxUI)
After=network-online.target pveproxy.service pve-cluster.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
Environment=BPUI_INSTALL_DIR=${INSTALL_DIR}
Environment=BPUI_STATE_DIR=${STATE_DIR}
WorkingDirectory=${INSTALL_DIR}
ExecStart=${INSTALL_DIR}/bin/start.sh
Restart=on-failure
RestartSec=3
KillMode=mixed

[Install]
WantedBy=multi-user.target
EOF
chmod +x "$INSTALL_DIR/bin/start.sh" "$INSTALL_DIR/install.sh"
systemctl daemon-reload
systemctl enable -q "$SERVICE"
systemctl restart "$SERVICE"

for _ in $(seq 1 20); do
  if curl -fsk "https://${BPUI_BIND}:${BPUI_PORT}/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! systemctl is-active -q "$SERVICE"; then
  journalctl -u "$SERVICE" -n 30 --no-pager || true
  die "Der Dienst ist nicht gestartet (siehe Meldungen oben)."
fi
ok "Dienst läuft"

# ---------------------------------------------------------------------------
if command -v pve-firewall >/dev/null 2>&1 && pve-firewall status 2>/dev/null | grep -q "enabled/running"; then
  echo
  echo "  ${C_ERR}Hinweis:${C_OFF} Die Proxmox-Firewall ist aktiv. Erlaube ggf. Port ${BPUI_PORT}/tcp"
  echo "  unter Rechenzentrum → Firewall (Quelle: dein Heimnetz)."
fi

echo
ok "Fertig! Öffne im Browser:  ${C_INFO}https://${BPUI_BIND}:${BPUI_PORT}${C_OFF}"
echo "  ${C_DIM}Anmeldung mit deinen normalen Proxmox-Zugangsdaten. Der Browser warnt beim ersten Mal"
echo "  vor dem Zertifikat – das ist dasselbe wie bei der Proxmox-Seite und kann bestätigt werden.${C_OFF}"
echo
