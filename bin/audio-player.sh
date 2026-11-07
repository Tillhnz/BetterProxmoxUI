#!/usr/bin/env bash
# ===========================================================================
#  Proxmox Zentrale – Musik-Player für die Anlage
#
#  Richtet einen kleinen Container ein, der den Audio-Ausgang dieses Servers
#  nutzt und sich bei Music Assistant als Player (Squeezelite) meldet.
#
#  Aufrufe:
#    audio-player.sh setup  <name> <ausgang> <server|-> <bridge>
#    audio-player.sh test
#    audio-player.sh volume <0-100>
#    audio-player.sh restart
#    audio-player.sh remove
# ===========================================================================
set -uo pipefail

STATE="${BPUI_STATE_DIR:-/var/lib/better-proxmox-ui}"
CFG="$STATE/audio.json"
TAG="bpui-audio"
HOSTNAME_CT="musik-player"
mkdir -p "$STATE"

say()  { printf '\n\033[1;36m━━ %s ━━\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔\033[0m %s\n' "$*"; }
fail() { printf '\n\033[1;31m✘ %s\033[0m\n' "$*"; exit 1; }

cfg_get() { [[ -f "$CFG" ]] && python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$CFG" "$1" 2>/dev/null; }
cfg_write() {  # vmid name device server volume
  python3 - "$CFG" "$@" <<'PY'
import json, sys
p, vmid, name, dev, srv, vol = sys.argv[1:]
json.dump({"vmid": int(vmid), "name": name, "device": dev, "server": srv, "volume": int(vol)}, open(p, "w"))
PY
}

ct_exists()  { [[ -n "${1:-}" && -f "/etc/pve/lxc/$1.conf" ]]; }
ct_running() { pct status "$1" 2>/dev/null | grep -q running; }

# Mixer-Skript im Container: entstummt die Ausgänge und setzt die Lautstärke.
# Läuft bei jedem Start des Players, weil der Server die Mixer-Werte nach einem Neustart vergisst.
MIXER_SCRIPT="$(cat <<'EOF'
#!/bin/sh
. /etc/bpui-player.env
CARD="${PLAYER_DEVICE#*CARD=}"; CARD="${CARD%%,*}"
amixer -q -c "$CARD" sset "Auto-Mute Mode" Disabled 2>/dev/null
for c in PCM Front Headphone Speaker "Line Out" Line; do amixer -q -c "$CARD" sset "$c" 100% unmute 2>/dev/null; done
amixer -c "$CARD" scontrols 2>/dev/null | sed -n "s/^Simple mixer control '\(IEC958[^']*\)',\([0-9]*\)$/\1,\2/p" | while IFS= read -r c; do
  amixer -q -c "$CARD" sset "$c" on 2>/dev/null
done
amixer -q -c "$CARD" sset Master "${PLAYER_VOLUME:-85}%" unmute 2>/dev/null
exit 0
EOF
)"

PLAYER_SCRIPT="$(cat <<'EOF'
#!/bin/sh
. /etc/bpui-player.env
# -C 5: Ausgang nach 5 s Pause freigeben (Testton, andere Programme)
if [ -n "$PLAYER_SERVER" ]; then
  exec /usr/bin/squeezelite -n "$PLAYER_NAME" -o "$PLAYER_DEVICE" -C 5 -s "$PLAYER_SERVER"
fi
exec /usr/bin/squeezelite -n "$PLAYER_NAME" -o "$PLAYER_DEVICE" -C 5
EOF
)"

UNIT="$(cat <<'EOF'
[Unit]
Description=Musik-Player für Music Assistant (Squeezelite)
After=network-online.target sound.target
Wants=network-online.target

[Service]
ExecStartPre=-/usr/local/bin/bpui-mixer
ExecStart=/usr/local/bin/bpui-player
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
)"

push_text() {  # vmid ziel inhalt [modus]
  local tmp; tmp="$(mktemp)"; printf '%s' "$3" > "$tmp"
  pct push "$1" "$tmp" "$2" --perms "${4:-0644}" || { rm -f "$tmp"; fail "Datei $2 konnte nicht in den Container kopiert werden."; }
  rm -f "$tmp"
}

write_env() {  # vmid name device server volume
  push_text "$1" /etc/bpui-player.env "PLAYER_NAME='$2'
PLAYER_DEVICE='$3'
PLAYER_SERVER='$4'
PLAYER_VOLUME='$5'
"
}

attach_sound_devices() {  # vmid – alle /dev/snd-Knoten durchreichen (Gruppe audio = 29 im Container)
  local id="$1" key
  for key in $(grep -E '^dev[0-9]+: */dev/snd/' "/etc/pve/lxc/$id.conf" | cut -d: -f1); do
    pct set "$id" --delete "$key" >/dev/null
  done
  local used n=0 node
  used="$(grep -oE '^dev[0-9]+' "/etc/pve/lxc/$id.conf" | tr -d dev)"
  for node in /dev/snd/*; do
    [[ -c "$node" ]] || continue
    while grep -qx "$n" <<<"$used"; do n=$((n + 1)); done
    pct set "$id" "--dev$n" "$node,gid=29,mode=0660" >/dev/null || fail "Gerät $node konnte nicht durchgereicht werden."
    n=$((n + 1))
  done
  ok "Audio-Geräte an den Container durchgereicht"
}

cmd_setup() {
  local NAME="$1" DEVICE="$2" SERVER="$3" BRIDGE="$4"
  [[ "$SERVER" == "-" ]] && SERVER=""
  local VOL; VOL="$(cfg_get volume)"; VOL="${VOL:-85}"
  local CARD="${DEVICE#*CARD=}"; CARD="${CARD%%,*}"

  say "1/5  Voraussetzungen prüfen"
  local ver; ver="$(pveversion 2>/dev/null | sed -n 's#.*pve-manager/\([0-9]*\)\.\([0-9]*\).*#\1 \2#p')"
  read -r MAJ MIN <<<"${ver:-0 0}"
  if (( MAJ < 8 || (MAJ == 8 && MIN < 1) )); then
    fail "Dafür wird Proxmox VE 8.1 oder neuer gebraucht (gefunden: ${MAJ}.${MIN}). Bitte zuerst Updates installieren."
  fi
  if ! grep -q '\[' /proc/asound/cards 2>/dev/null; then
    echo "Kein Soundtreiber aktiv – lade snd_hda_intel …"
    modprobe snd_hda_intel 2>/dev/null; sleep 2
    grep -q '\[' /proc/asound/cards 2>/dev/null || fail "Es wurde keine Soundkarte gefunden. Ist der Audio-Chip evtl. an eine VM durchgereicht oder im BIOS abgeschaltet?"
    echo snd_hda_intel > /etc/modules-load.d/bpui-audio.conf
  fi
  grep -q "\[$CARD *\]" /proc/asound/cards || fail "Der gewählte Ausgang ($CARD) ist nicht mehr vorhanden."
  ok "Proxmox ${MAJ}.${MIN}, Soundkarte $CARD gefunden"

  local ID; ID="$(cfg_get vmid)"
  if ct_exists "$ID"; then
    say "2/5  Vorhandenen Player-Container $ID verwenden"
  else
    say "2/5  Kleinen Container anlegen"
    local TPL_STORE ROOT_STORE TPL
    TPL_STORE="$(pvesm status --content vztmpl 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}' | grep -x local || true)"
    [[ -n "$TPL_STORE" ]] || TPL_STORE="$(pvesm status --content vztmpl 2>/dev/null | awk 'NR>1 && $3=="active" {print $1; exit}')"
    [[ -n "$TPL_STORE" ]] || fail "Kein Speicher für Container-Vorlagen gefunden."
    ROOT_STORE="$(pvesm status --content rootdir 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}' | grep -xE 'local-lvm|local-zfs' | head -1 || true)"
    [[ -n "$ROOT_STORE" ]] || ROOT_STORE="$(pvesm status --content rootdir 2>/dev/null | awk 'NR>1 && $3=="active" {print $1; exit}')"
    [[ -n "$ROOT_STORE" ]] || fail "Kein Speicher für Container gefunden."

    TPL="$(pveam list "$TPL_STORE" 2>/dev/null | awk '{print $1}' | grep -E 'debian-12-standard' | sort -V | tail -1)"
    if [[ -z "$TPL" ]]; then
      echo "Lade Debian-Vorlage herunter …"
      pveam update >/dev/null 2>&1
      local name; name="$(pveam available --section system 2>/dev/null | awk '{print $2}' | grep -E '^debian-12-standard' | sort -V | tail -1)"
      [[ -n "$name" ]] || fail "Debian-Vorlage nicht gefunden (Internet?)."
      pveam download "$TPL_STORE" "$name" || fail "Download der Vorlage fehlgeschlagen."
      TPL="$TPL_STORE:vztmpl/$name"
    fi
    ID="$(pvesh get /cluster/nextid)"
    pct create "$ID" "$TPL" --hostname "$HOSTNAME_CT" --ostype debian --memory 256 --swap 256 --cores 1 \
      --rootfs "$ROOT_STORE:2" --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" --unprivileged 1 --features nesting=1 \
      --onboot 1 --tags "$TAG" --timezone host \
      --description "Musik-Player für Music Assistant (Squeezelite) – eingerichtet von Proxmox Zentrale. Gibt Musik über den Audio-Ausgang des Servers aus." \
      || fail "Container konnte nicht angelegt werden."
    ok "Container $ID ($HOSTNAME_CT) angelegt auf $ROOT_STORE"
  fi
  cfg_write "$ID" "$NAME" "$DEVICE" "$SERVER" "$VOL"

  say "3/5  Audio-Ausgang durchreichen"
  ct_running "$ID" && { pct stop "$ID" >/dev/null || true; }
  attach_sound_devices "$ID"
  pct start "$ID" || fail "Container startet nicht. Details oben."
  echo -n "Warte auf Netzwerk "
  local i
  for i in $(seq 1 60); do
    pct exec "$ID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break
    echo -n "."; sleep 2
  done; echo
  pct exec "$ID" -- getent hosts deb.debian.org >/dev/null 2>&1 || fail "Der Container bekommt kein Internet (DHCP auf $BRIDGE?)."

  say "4/5  Player-Software installieren"
  if ! pct exec "$ID" -- test -x /usr/bin/squeezelite; then
    pct exec "$ID" -- env DEBIAN_FRONTEND=noninteractive bash -c \
      'apt-get update -q && apt-get install -y -q --no-install-recommends squeezelite alsa-utils' \
      || fail "Installation fehlgeschlagen."
  fi
  pct exec "$ID" -- bash -c 'systemctl disable --now squeezelite >/dev/null 2>&1; true'
  write_env "$ID" "$NAME" "$DEVICE" "$SERVER" "$VOL"
  push_text "$ID" /usr/local/bin/bpui-mixer "$MIXER_SCRIPT" 0755
  push_text "$ID" /usr/local/bin/bpui-player "$PLAYER_SCRIPT" 0755
  push_text "$ID" /etc/systemd/system/bpui-player.service "$UNIT"
  pct exec "$ID" -- bash -c 'systemctl daemon-reload && systemctl enable bpui-player >/dev/null 2>&1 && systemctl restart bpui-player' \
    || fail "Player-Dienst startet nicht."

  say "5/5  Prüfen"
  sleep 3
  if pct exec "$ID" -- systemctl is-active --quiet bpui-player; then
    ok "Player „$NAME“ läuft und gibt über $DEVICE aus"
  else
    pct exec "$ID" -- journalctl -u bpui-player -n 20 --no-pager
    fail "Der Player läuft nicht. Protokoll siehe oben."
  fi
  printf '\n\033[1;32m✔ Fertig.\033[0m Jetzt in Music Assistant den Anbieter „Squeezelite“ hinzufügen – dann erscheint „%s“ als Player.\n' "$NAME"
}

need_ct() {
  ID="$(cfg_get vmid)"
  ct_exists "$ID" || fail "Es ist noch kein Musik-Player eingerichtet."
}

cmd_test() {
  need_ct
  ct_running "$ID" || pct start "$ID"
  local dev; dev="$(cfg_get device)"
  # Squeezelite gibt das Gerät nach 5 s Pause frei; zur Sicherheit kurz anhalten
  pct exec "$ID" -- bash -c "systemctl stop bpui-player; /usr/local/bin/bpui-mixer; timeout 20 speaker-test -D '$dev' -c 2 -t wav -l 1 >/dev/null 2>&1 || timeout 12 speaker-test -D '$dev' -c 2 -t sine -f 440 -l 1 >/dev/null 2>&1; rc=\$?; systemctl start bpui-player; exit \$rc"
}

cmd_volume() {
  need_ct
  local v="$1"
  python3 - "$CFG" "$v" <<'PY'
import json, sys
p, v = sys.argv[1], int(sys.argv[2]); d = json.load(open(p)); d["volume"] = v; json.dump(d, open(p, "w"))
PY
  ct_running "$ID" || exit 0
  pct exec "$ID" -- bash -c "sed -i \"s/^PLAYER_VOLUME=.*/PLAYER_VOLUME='$v'/\" /etc/bpui-player.env && /usr/local/bin/bpui-mixer"
}

cmd_restart() {
  need_ct
  ct_running "$ID" || { pct start "$ID"; exit $?; }
  pct exec "$ID" -- systemctl restart bpui-player
}

cmd_remove() {
  ID="$(cfg_get vmid)"
  if ct_exists "$ID"; then
    grep -q "^tags:.*$TAG" "/etc/pve/lxc/$ID.conf" || fail "Container $ID gehört nicht zum Musik-Player – wird nicht gelöscht."
    pct stop "$ID" >/dev/null 2>&1 || true
    pct destroy "$ID" --purge || fail "Container $ID konnte nicht gelöscht werden."
  fi
  rm -f "$CFG"
  ok "Musik-Player entfernt"
}

cmd_driver() {
  modprobe snd_hda_intel 2>/dev/null; modprobe snd_usb_audio 2>/dev/null; sleep 2
  grep -q '\[' /proc/asound/cards 2>/dev/null || fail "Auch mit Treiber wurde keine Soundkarte gefunden."
  printf 'snd_hda_intel\nsnd_usb_audio\n' > /etc/modules-load.d/bpui-audio.conf
  ok "Soundtreiber geladen"
}

case "${1:-}" in
  driver)  cmd_driver ;;
  setup)   [[ $# -eq 5 ]] || fail "Aufruf: $0 setup <name> <ausgang> <server|-> <bridge>"; cmd_setup "$2" "$3" "$4" "$5" ;;
  test)    cmd_test ;;
  volume)  [[ "${2:-}" =~ ^[0-9]{1,3}$ ]] || fail "Lautstärke 0–100"; cmd_volume "$2" ;;
  restart) cmd_restart ;;
  remove)  cmd_remove ;;
  *) echo "Aufruf: $0 setup|test|volume|restart|remove"; exit 2 ;;
esac
