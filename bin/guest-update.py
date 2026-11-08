#!/usr/bin/env python3
"""Proxmox Zentrale – eine Maschine (Container oder VM) aktualisieren.

Aufruf: guest-update.py <lxc|qemu> <vmid> <system|app> <snapshot:0|1>

* Container: Befehle laufen per `pct exec` direkt im Container (mit Terminal, also auch interaktiv).
* VMs: Befehle laufen über den QEMU-Gast-Agenten; die Ausgabe wird aus einer Protokolldatei
  in der VM nachgelesen, damit man den Fortschritt live sieht.
"""
import base64
import json
import os
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


def lxc_running(vmid):
    return "running" in run(["pct", "status", vmid]).stdout


def update_lxc(vmid, action):
    if not lxc_running(vmid):
        print("Der Container ist ausgeschaltet – bitte zuerst starten."); return 1
    if action == "app":
        say("App aktualisieren (Update-Skript der Community-Scripts)")
        print("Falls Fragen kommen: meist einfach mit Enter bestätigen.\n", flush=True)
        return subprocess.call(["pct", "exec", vmid, "--", "bash", "-lc", "update"])
    say("System-Pakete aktualisieren")
    return subprocess.call(["pct", "exec", vmid, "--", "sh", "-c", INNER])


def agent(vmid, *args, timeout=60):
    r = run(["qm", "guest", "exec", vmid, "--timeout", str(timeout), "--", *args])
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or r.stdout.strip())
    return json.loads(r.stdout or "{}")


def update_qemu(vmid):
    say("System-Pakete aktualisieren (über den QEMU-Gast-Agenten)")
    try:
        agent(vmid, "sh", "-c", f"rm -f {LOG} {RC}")
        # Im Hintergrund starten; Ausgabe landet in einer Datei in der VM
        r = run(["qm", "guest", "exec", vmid, "--synchronous", "0", "--", "sh", "-c",
                 f"( {INNER} ) >{LOG} 2>&1; echo $? >{RC}"])
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
    if len(sys.argv) != 5 or sys.argv[1] not in ("lxc", "qemu") or not sys.argv[2].isdigit() \
            or sys.argv[3] not in ("system", "app") or sys.argv[4] not in ("0", "1"):
        print(__doc__); return 2
    kind, vmid, action, snap = sys.argv[1:]
    if snap == "1":
        snapshot(kind, vmid)
    rc = update_lxc(vmid, action) if kind == "lxc" else update_qemu(vmid)
    return rc


if __name__ == "__main__":
    sys.exit(main())
