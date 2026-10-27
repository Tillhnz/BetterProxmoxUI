# Proxmox Zentrale (BetterProxmoxUI)

Eine schöne, einfache Oberfläche für **Proxmox VE** – für alle, die ihren Server verwalten wollen, ohne sich mit Netzwerktechnik und Proxmox-Details auszukennen.

- **Gleiche Anmeldung wie Proxmox** – Benutzer, Passwort, Bereich (PAM/PVE), auch mit Zwei-Faktor-Code
- **Übersicht** – Auslastung, laufende Maschinen, Speicherplatz, Hinweise auf Updates und fehlende Sicherungen
- **Maschinen** – Starten, Herunterfahren, Neustart, Einstellungen, Festplatte vergrößern, Snapshots, Löschen, gesperrte Maschinen erkennen und entsperren
- **Neu anlegen** – Assistenten für Container (LXC) und VMs (inkl. Windows 11 mit TPM/UEFI), Vorlagen und ISOs per Klick laden
- **Apps** – über 600 Installationen aus den [Proxmox Community-Scripts](https://community-scripts.github.io/ProxmoxVE/) mit eingebautem Terminal
- **Speicher & NAS** – zeigt als Schaubild, welche NAS-Freigabe mit welcher App (Immich, Paperless, Jellyfin …) verbunden ist, warnt bei nicht erreichbarer NAS oder wenn eine App versehentlich auf die System-Festplatte schreibt; Assistenten zum Verbinden von SMB/NFS-Freigaben und zum Teilen von Ordnern mit Containern und VMs (VMs per virtiofs ab Proxmox 8.4 oder mit fertiger Anleitung für Linux, Windows und Home Assistant OS)
- **App-Logos** für erkannte Apps und den ganzen Katalog (Icons von [selfh.st](https://selfh.st/icons/))
- **Empfehlungen** – Gesundheits- und Sicherheits-Check mit Punktzahl: Sicherungen (fehlend, veraltet, nur lokal, ohne Aufbewahrung), Speicherplatz, defekte Festplatten, Updates, ausstehender Neustart, falsche Paketquellen, Zwei-Faktor, privilegierte Container, Autostart, QEMU-Agent u. v. m. – jeweils mit „Warum?“, „Was tun?“ und, wo möglich, Umsetzung per Klick
- **Größen-Empfehlungen** – wertet die Auslastung der letzten 7 Tage aus: welcher Dienst mehr Arbeitsspeicher, Kerne oder Festplatte braucht und wo sich etwas einsparen lässt; per Klick übernehmen
- **Statistik** – Diagramme für Server (CPU, RAM, Netzwerk, Last, Festplatte), Speicher und jede Maschine über Stunde/Tag/Woche/Monat/Jahr, Rangliste der größten Verbraucher
- **Server** – Systeminfos, Dienste (neu starten), Systemprotokoll mit Filter, Festplatten mit SMART-Werten, ZFS-Pools, Netzwerk-Übersicht, Host-Konsole
- **Benutzer** – Benutzer anlegen, verständliche Rollen (Administrator, Maschinen verwalten/bedienen, Nur ansehen), Passwort ändern, deaktivieren, Zwei-Faktor-Status
- **Maschinen-Details** – Verlaufsdiagramme, Hardware (CD/ISO wechseln, Festplatte und Netzwerkkarte hinzufügen), Start-Reihenfolge, Schlagwörter, Löschschutz, Klonen, Vorlage, Verschieben im Cluster, Aufgaben-Verlauf
- **Sicherungen** – jetzt sichern, automatische Zeitpläne, Wiederherstellen (als neue Maschine oder Original ersetzen), Sicherungsdateien herunterladen (nur root@pam, nicht bei Proxmox Backup Server)
- **Updates** – Proxmox-Updates prüfen und installieren, alle Container aktualisieren, Oberfläche selbst aktualisieren
- **Nur im Heimnetz erreichbar**, optimiert für Handy und Desktop, hell und dunkel

## Installation

Auf dem Proxmox-Server als `root` (z. B. über *Server → Shell* in Proxmox):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Tillhnz/BetterProxmoxUI/main/install.sh)"
```

Danach im Browser öffnen: `https://<IP-deines-Servers>:8443` – oder einfach nur die IP-Adresse eintippen, du wirst automatisch auf https:// weitergeleitet.

### HTTPS ohne Browser-Warnung

Die Oberfläche ist immer verschlüsselt. Damit der Browser nicht „Nicht sicher“ anzeigt, erstellt die Installation ein **eigenes Heimnetz-Zertifikat**. Das installierst du einmal pro Gerät (Anleitung für Windows, Mac, iPhone, Android und Linux direkt auf der Anmeldeseite unter „Browser zeigt Nicht sicher?“ und unter **Server → Sichere Verbindung**).

- Die Zertifizierungsstelle ist per *Name Constraints* auf private IP-Adressen und Heimnetz-Namen (`.local`, `.lan`, `.home.arpa`, `.internal`, Servername) beschränkt. Selbst mit ihrem Schlüssel ließen sich keine echten Webseiten fälschen.
- Das Zertifikat erneuert sich automatisch (täglicher Check), auch wenn sich die IP-Adresse ändert.
- Auf Wunsch nutzt auch die normale Proxmox-Oberfläche (Port 8006) dasselbe Zertifikat – ein Klick unter **Server**, jederzeit rückgängig.
- Hast du in Proxmox schon ein eigenes Zertifikat (z. B. Let's Encrypt über ACME), wird automatisch dieses verwendet.

> Das Repository muss öffentlich sein, damit der Server es ohne Zugangsdaten laden kann.

## Aktualisieren & Entfernen

- In der Oberfläche: **Updates → Oberfläche aktualisieren**
- Oder per Shell: `bash /opt/better-proxmox-ui/install.sh --update`
- Entfernen: `bash /opt/better-proxmox-ui/install.sh --uninstall` (Proxmox selbst bleibt unverändert)

## Einstellungen

Datei `/etc/better-proxmox-ui.env`, danach `systemctl restart better-proxmox-ui`:

| Einstellung | Bedeutung |
|---|---|
| `BPUI_BIND` / `BPUI_PORT` | IP-Adresse und Port (Standard: LAN-IP, 8443) |
| `BPUI_HTTP_PORT` | Port für die Weiterleitung von http:// auf https:// (Standard 80, `0` = aus) |
| `BPUI_ALLOW_NETS` | Zusätzliche erlaubte Netze, z. B. `100.64.0.0/10` für Tailscale |
| `BPUI_HOST_ACTIONS` | `0` schaltet Apps, Updates und Host-Konsole ab |
| `BPUI_HOST_ADMINS` | Wer Host-Aktionen ausführen darf (Standard `root@pam`) |

## Sicherheit

- Alle Aktionen laufen über die Proxmox-API **mit den Rechten des angemeldeten Benutzers** – die Oberfläche kann nichts, was der Benutzer in Proxmox nicht auch darf.
- Zugriff nur aus privaten Netzen (192.168.x.x, 10.x.x.x, 172.16–31.x.x); alles andere wird abgewiesen.
- Immer HTTPS – mit eigenem, auf das Heimnetz beschränktem Zertifikat; versehentliches http:// wird umgeleitet.
- Sitzungs-Cookie `HttpOnly`/`SameSite=Strict`, CSRF-Schutz, Sperre nach 10 Fehlversuchen.
- **Apps installieren, Proxmox-Updates und die Host-Konsole** brauchen Root-Rechte auf dem Server. Deshalb läuft der Dienst als root, und diese Funktionen sind – wie in Proxmox selbst – nur für `root@pam` freigeschaltet.
- Die App-Skripte stammen vom Community-Projekt *community-scripts*, nicht von Proxmox.

## Was bewusst in der Proxmox-Oberfläche bleibt

Cluster & Hochverfügbarkeit, Firewall-Regeln, Netzwerk ändern/SDN, Festplatten initialisieren (ZFS/LVM/Ceph), Replikation, Benachrichtigungen, Metrik-Server, ACME-Zertifikate, Pools und API-Tokens sowie USB-/PCI-Durchreichung. Unter **Server → Mehr** gibt es dafür Direktlinks.

## Sicherheitsempfehlungen für deinen Server

1. **Nichts ins Internet freigeben.** Port 8006 (Proxmox), 8443 (diese Oberfläche) und 22 (SSH) nie im Router weiterleiten. Für Zugriff von unterwegs ein VPN nutzen (WireGuard oder Tailscale – beides gibt es unter „Apps“).
2. **Zwei-Faktor-Anmeldung** für root einrichten (Proxmox → Rechenzentrum → Berechtigungen → Zwei-Faktor). Diese Oberfläche fragt den Code automatisch ab.
3. **Updates regelmäßig installieren** und nach Kernel-Updates neu starten. Ohne Abo die kostenlose „No-Subscription“-Paketquelle verwenden.
4. **Sicherungen nach der 3-2-1-Regel:** automatischer Zeitplan für alle Maschinen, gespeichert auf einer NAS oder einem Proxmox Backup Server – nicht nur auf dem Server selbst. Ab und zu eine Wiederherstellung testen.
5. **Container unprivilegiert anlegen** (Standard in dieser Oberfläche) und Apps aus dem Internet nur über einen Reverse-Proxy mit HTTPS erreichbar machen.
6. **Eigene, lange Passwörter** für Proxmox, NAS und jede App – am besten mit einem Passwort-Manager.
7. **System-Festplatte im Blick behalten:** Sicherungen und Mediendaten gehören auf die NAS. Die Seite „Speicher & NAS“ warnt, wenn eine App versehentlich auf die System-Festplatte schreibt.

## Aufbau

```
backend/app.py      Starlette-Server: Login, API-Weiterleitung, Skript-Katalog, Terminal-Jobs
frontend/           Oberfläche (reines JavaScript, kein Build-Schritt nötig)
bin/start.sh        Startet den Server (HTTPS, Weiterleitung von http://)
bin/cert.sh         Erstellt und erneuert das Heimnetz-Zertifikat
install.sh          Installation, Update, Deinstallation
```

Lokal entwickeln (gegen einen echten oder nachgebauten Proxmox):

```bash
pip install -r backend/requirements.txt
BPUI_PVE_URL=https://192.168.1.10:8006 BPUI_COOKIE_SECURE=0 uvicorn backend.app:app --port 8443
```
