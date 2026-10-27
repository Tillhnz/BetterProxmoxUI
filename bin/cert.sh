#!/usr/bin/env bash
# ===========================================================================
#  Proxmox Zentrale – HTTPS-Zertifikate
#
#  Erstellt eine eigene, auf das Heimnetz beschränkte Zertifizierungsstelle (CA)
#  und damit das Zertifikat der Oberfläche. Die CA installierst du einmal auf
#  deinen Geräten – danach gibt es keine Browser-Warnung mehr.
#
#  Die CA darf dank „Name Constraints“ nur Zertifikate für private IP-Adressen
#  und Heimnetz-Namen ausstellen. Selbst wenn ihr Schlüssel gestohlen würde,
#  ließen sich damit keine fremden Webseiten (Bank, Google …) fälschen.
#
#  Aufruf:  cert.sh            → stellt sicher, dass alles da ist, gibt "CERT KEY" aus
#           cert.sh --renew    → für den täglichen Timer: erneuert bei Bedarf und startet neu
# ===========================================================================
set -euo pipefail

STATE="${BPUI_STATE_DIR:-/var/lib/better-proxmox-ui}"
TLS="$STATE/tls"
SERVICE="better-proxmox-ui"
CA_NAME="Proxmox Zentrale CA"
PVE_CUSTOM_CERT="${BPUI_PVE_CUSTOM_CERT:-/etc/pve/local/pveproxy-ssl.pem}"
PVE_CUSTOM_KEY="${BPUI_PVE_CUSTOM_KEY:-/etc/pve/local/pveproxy-ssl.key}"
PVE_CERT="${BPUI_PVE_CERT:-/etc/pve/local/pve-ssl.pem}"
PVE_KEY="${BPUI_PVE_KEY:-/etc/pve/local/pve-ssl.key}"

mkdir -p "$TLS"
chmod 700 "$TLS"
umask 077

log() { echo "[cert] $*" >&2; }

HOST="$(hostname -s 2>/dev/null || hostname)"
FQDN="$(hostname -f 2>/dev/null || echo "$HOST")"
valid_name() { [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; }
valid_name "$HOST" || HOST="proxmox"
valid_name "$FQDN" || FQDN="$HOST"

is_private_ip() {
  case "$1" in
    10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;;
    100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) return 0 ;;  # Tailscale/CGNAT
    *) return 1 ;;
  esac
}

# Alle privaten IPv4-Adressen des Servers (die Bind-Adresse zuerst)
server_ips() {
  local seen=" " a
  for a in "${BPUI_BIND:-}" $(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1); do
    [[ -n "$a" && "$a" != "0.0.0.0" ]] || continue
    is_private_ip "$a" || continue
    [[ "$seen" == *" $a "* ]] && continue
    seen+="$a "
    echo "$a"
  done
}

is_ours() { [[ -f "$1" ]] && openssl x509 -in "$1" -noout -issuer 2>/dev/null | grep -q "$CA_NAME"; }

ensure_ca() {
  [[ -s "$TLS/ca.pem" && -s "$TLS/ca.key" ]] && return 0
  log "Erstelle eigene Zertifizierungsstelle für $HOST …"
  local nc="critical"
  nc+=",permitted;IP:10.0.0.0/255.0.0.0,permitted;IP:172.16.0.0/255.240.0.0"
  nc+=",permitted;IP:192.168.0.0/255.255.0.0,permitted;IP:100.64.0.0/255.192.0.0"
  local d
  for d in "$HOST" "$FQDN" local lan home.arpa internal localdomain; do
    [[ "$nc" == *"DNS:$d,"* || "$nc" == *"DNS:$d" ]] && continue
    nc+=",permitted;DNS:$d"
  done
  cat > "$TLS/ca.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ca
[dn]
O = Proxmox Zentrale
CN = $CA_NAME ($HOST)
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = $nc
EOF
  openssl req -x509 -new -config "$TLS/ca.cnf" -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout "$TLS/ca.key.new" -out "$TLS/ca.pem.new" -days 3650 -sha256 2>/dev/null
  mv "$TLS/ca.key.new" "$TLS/ca.key"
  mv "$TLS/ca.pem.new" "$TLS/ca.pem"
  chmod 600 "$TLS/ca.key"
  chmod 644 "$TLS/ca.pem"
  rm -f "$TLS/cert.pem" "$TLS/key.pem"
}

leaf_ok() {
  [[ -s "$TLS/cert.pem" && -s "$TLS/key.pem" ]] || return 1
  openssl x509 -in "$TLS/cert.pem" -noout -checkend $((30 * 86400)) >/dev/null 2>&1 || return 1
  openssl verify -CAfile "$TLS/ca.pem" "$TLS/cert.pem" >/dev/null 2>&1 || return 1
  openssl x509 -in "$TLS/cert.pem" -noout -checkhost "$HOST" 2>/dev/null | grep -q "does match" || return 1
  local ip
  for ip in $(server_ips); do
    openssl x509 -in "$TLS/cert.pem" -noout -checkip "$ip" 2>/dev/null | grep -q "does match" || return 1
  done
  return 0
}

ensure_leaf() {
  leaf_ok && return 1   # 1 = nichts geändert
  log "Erstelle neues Zertifikat für die Oberfläche …"
  local san="" ip
  for ip in $(server_ips); do san+="IP:$ip,"; done
  san+="DNS:$HOST,DNS:$HOST.local"
  [[ "$FQDN" != "$HOST" ]] && san+=",DNS:$FQDN"
  cat > "$TLS/leaf.ext" <<EOF
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = $san
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
EOF
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout "$TLS/key.new" -out "$TLS/req.csr" -subj "/O=Proxmox Zentrale/CN=$HOST" 2>/dev/null
  # 397 Tage: maximal erlaubte Laufzeit, die alle Browser (auch Apple) akzeptieren
  openssl x509 -req -in "$TLS/req.csr" -CA "$TLS/ca.pem" -CAkey "$TLS/ca.key" \
    -set_serial "0x$(openssl rand -hex 16)" -days 397 -sha256 -extfile "$TLS/leaf.ext" -out "$TLS/cert.new" 2>/dev/null
  mv "$TLS/key.new" "$TLS/key.pem"
  mv "$TLS/cert.new" "$TLS/cert.pem"
  chmod 600 "$TLS/key.pem"
  rm -f "$TLS/req.csr"
  return 0              # 0 = neu erstellt
}

# Wenn Proxmox selbst unser Zertifikat nutzt: aktuell halten
sync_proxmox() {
  is_ours "$PVE_CUSTOM_CERT" || return 0
  if ! cmp -s "$TLS/cert.pem" "$PVE_CUSTOM_CERT"; then
    log "Aktualisiere das Zertifikat der Proxmox-Oberfläche …"
    cat "$TLS/cert.pem" > "$PVE_CUSTOM_CERT"
    cat "$TLS/key.pem" > "$PVE_CUSTOM_KEY"
    systemctl restart pveproxy 2>/dev/null || true
  fi
}

choose() {
  # 1) Eigenes Zertifikat in Proxmox (z. B. Let's Encrypt), das nicht von uns stammt → das nehmen
  if [[ -f "$PVE_CUSTOM_CERT" && -f "$PVE_CUSTOM_KEY" ]] && ! is_ours "$PVE_CUSTOM_CERT"; then
    echo "$PVE_CUSTOM_CERT $PVE_CUSTOM_KEY custom"
    return
  fi
  # 2) Unsere Heimnetz-CA
  if command -v openssl >/dev/null 2>&1 && ensure_ca; then
    ensure_leaf || true
    if leaf_ok; then
      sync_proxmox
      echo "$TLS/cert.pem $TLS/key.pem own"
      return
    fi
  fi
  # 3) Notlösung: Standard-Zertifikat von Proxmox
  log "Eigenes Zertifikat nicht möglich – nutze das Standard-Zertifikat von Proxmox."
  echo "$PVE_CERT $PVE_KEY pve"
}

fingerprint() { openssl x509 -in "$1" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2; }

case "${1:-}" in
  --renew)
    read -r CERT _KEY _MODE < <(choose)
    NOW="$(fingerprint "$CERT")"
    ACTIVE="$(cat "$TLS/active.sha" 2>/dev/null || true)"
    if [[ -n "$NOW" && "$NOW" != "$ACTIVE" ]]; then
      log "Zertifikat hat sich geändert – starte die Oberfläche neu."
      systemctl restart "$SERVICE" || true
    fi
    ;;
  --activate)
    # Von start.sh aufgerufen: Auswahl ausgeben und merken, welches Zertifikat jetzt aktiv ist
    read -r CERT KEY MODE < <(choose)
    fingerprint "$CERT" > "$TLS/active.sha" || true
    echo "$CERT $KEY $MODE"
    ;;
  *)
    choose
    ;;
esac
