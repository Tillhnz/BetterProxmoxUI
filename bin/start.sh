#!/usr/bin/env bash
# Startet die Oberfläche mit demselben Zertifikat wie die Proxmox-Weboberfläche.
set -euo pipefail
DIR="${BPUI_INSTALL_DIR:-/opt/better-proxmox-ui}"

# Warten, bis das Proxmox-Dateisystem (/etc/pve) bereit ist
for _ in $(seq 1 30); do [[ -f /etc/pve/local/pve-ssl.pem ]] && break; sleep 1; done

CERT=/etc/pve/local/pve-ssl.pem
KEY=/etc/pve/local/pve-ssl.key
# Eigenes Zertifikat (z. B. Let's Encrypt über Proxmox) bevorzugen
if [[ -f /etc/pve/local/pveproxy-ssl.pem && -f /etc/pve/local/pveproxy-ssl.key ]]; then
  CERT=/etc/pve/local/pveproxy-ssl.pem
  KEY=/etc/pve/local/pveproxy-ssl.key
fi

cd "$DIR"
exec "$DIR/.venv/bin/uvicorn" backend.app:app \
  --host "${BPUI_BIND:-0.0.0.0}" --port "${BPUI_PORT:-8443}" \
  --ssl-certfile "$CERT" --ssl-keyfile "$KEY" \
  --no-proxy-headers --no-server-header --log-level warning \
  --ws-max-size 1048576
