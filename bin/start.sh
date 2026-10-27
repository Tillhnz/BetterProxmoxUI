#!/usr/bin/env bash
# Startet die Oberfläche.
#
#  - Die App nimmt auf BPUI_BIND:BPUI_PORT (Standard 8443) Verbindungen an:
#    HTTPS wird durchgereicht, versehentliches http:// automatisch auf https:// umgeleitet.
#  - Zusätzlich leitet Port 80 (BPUI_HTTP_PORT) auf https:// weiter, sodass die nackte
#    IP-Adresse im Browser reicht.
#  - Intern läuft der Webserver (uvicorn) mit TLS nur auf 127.0.0.1:BPUI_INTERNAL_PORT.
set -euo pipefail
DIR="${BPUI_INSTALL_DIR:-/opt/better-proxmox-ui}"

# Warten, bis das Proxmox-Dateisystem (/etc/pve) bereit ist
for _ in $(seq 1 30); do [[ -f /etc/pve/local/pve-ssl.pem ]] && break; sleep 1; done

read -r CERT KEY MODE < <(bash "$DIR/bin/cert.sh" --activate)
export BPUI_TLS_CERT="$CERT" BPUI_TLS_KEY="$KEY" BPUI_TLS_MODE="$MODE"
export BPUI_FRONT=1

cd "$DIR"
exec "$DIR/.venv/bin/uvicorn" backend.app:app \
  --host 127.0.0.1 --port "${BPUI_INTERNAL_PORT:-8442}" \
  --ssl-certfile "$CERT" --ssl-keyfile "$KEY" \
  --no-proxy-headers --no-server-header --log-level warning \
  --ws-max-size 1048576
