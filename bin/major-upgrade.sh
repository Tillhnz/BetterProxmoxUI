#!/usr/bin/env bash
# ===========================================================================
#  Proxmox Zentrale – großes Proxmox-Upgrade (z. B. 8 → 9)
#
#  Wird von der Oberfläche über `systemd-run` als eigenständiger Dienst gestartet,
#  damit es weder vom Browser noch von der Oberfläche selbst abhängt.
#  Fortschritt: $STATE/major-upgrade.json, Protokoll: $STATE/major-upgrade.log
#
#  Aufruf: major-upgrade.sh run <checker>    (z. B. pve8to9)
# ===========================================================================
set -uo pipefail

STATE="${BPUI_STATE_DIR:-/var/lib/better-proxmox-ui}"
INSTALL_DIR="${BPUI_INSTALL_DIR:-/opt/better-proxmox-ui}"
LOG="$STATE/major-upgrade.log"
STATUS="$STATE/major-upgrade.json"
CHECKER="${2:-pve8to9}"
STARTED="$(date +%s)"
mkdir -p "$STATE"

status() {  # status <state> <phase> [exit]
  printf '{"state":"%s","phase":"%s","started":%s,"ended":%s,"exit":%s,"checker":"%s"}\n' \
    "$1" "$2" "$STARTED" "$([[ $1 == running ]] && echo null || date +%s)" "${3:-null}" "$CHECKER" > "$STATUS.tmp"
  mv "$STATUS.tmp" "$STATUS"
}
say() { printf '\n\033[1;36m━━ %s ━━\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m✘ %s\033[0m\n' "$*"; status failed "$PHASE" 1; exit 1; }

[[ "${1:-}" == "run" ]] || { echo "Aufruf: $0 run <checker>"; exit 2; }
exec >>"$LOG" 2>&1
echo "=== Großes Upgrade gestartet: $(date) ==="

export DEBIAN_FRONTEND=noninteractive APT_LISTCHANGES_FRONTEND=none NEEDRESTART_MODE=a
# Geänderte Konfigurationsdateien behalten, unveränderte durch die neue Fassung ersetzen
APT_OPTS=(-y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold -o APT::Get::Assume-Yes=true)

PHASE="check-before"; status running "$PHASE"
say "1/5  Offizielle Prüfung ($CHECKER) vorher"
"$CHECKER" --full | tee "$STATE/major-upgrade-check-before.txt" || true
if grep -qE "^FAILURES:\s*[1-9]" "$STATE/major-upgrade-check-before.txt"; then
  fail "Die Prüfung meldet Fehler. Upgrade abgebrochen – es wurde nichts verändert."
fi

PHASE="download"; status running "$PHASE"
say "2/5  Paketlisten laden und Pakete herunterladen"
apt-get update || fail "Paketlisten konnten nicht geladen werden (Internet? Paketquellen?)."
apt-get "${APT_OPTS[@]}" --download-only dist-upgrade || fail "Herunterladen fehlgeschlagen. Es wurde noch nichts installiert."

PHASE="install"; status running "$PHASE"
say "3/5  Upgrade installieren (das dauert eine Weile – nicht ausschalten!)"
if ! apt-get "${APT_OPTS[@]}" dist-upgrade; then
  echo "Erster Durchlauf mit Fehlern – versuche Reparatur …"
  dpkg --configure -a
  apt-get "${APT_OPTS[@]}" -f install
  apt-get "${APT_OPTS[@]}" dist-upgrade || fail "Das Upgrade ist nicht vollständig durchgelaufen. NICHT neu starten – Protokoll prüfen."
fi

PHASE="after"; status running "$PHASE"
say "4/5  Nacharbeiten"
# /etc/sysctl.conf wird ab Debian 13 nicht mehr gelesen → eigene Einstellungen übernehmen
if [[ -f /etc/sysctl.conf ]] && grep -qvE '^\s*(#|$)' /etc/sysctl.conf && [[ ! -f /etc/sysctl.d/99-aus-sysctl-conf.conf ]]; then
  grep -vE '^\s*(#|$)' /etc/sysctl.conf > /etc/sysctl.d/99-aus-sysctl-conf.conf
  echo "Eigene Einstellungen aus /etc/sysctl.conf nach /etc/sysctl.d/99-aus-sysctl-conf.conf übernommen."
fi
"$CHECKER" --full | tee "$STATE/major-upgrade-check-after.txt" || true

PHASE="ui"; status running "$PHASE"
say "5/5  Proxmox Zentrale an das neue System anpassen"
if [[ -f "$INSTALL_DIR/install.sh" ]]; then
  bash "$INSTALL_DIR/install.sh" --update || echo "Hinweis: Die Oberfläche konnte nicht sofort angepasst werden – nach dem Neustart erneut „install.sh --update“ ausführen."
fi

PHASE="reboot"
status done "$PHASE" 0
printf '\n\033[1;32m✔ Upgrade installiert. Jetzt den Server neu starten.\033[0m\n'
echo "=== Fertig: $(date) ==="
