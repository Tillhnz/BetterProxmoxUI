// ===========================================================================
// HTTPS: Zertifikat einmal installieren – danach keine Browser-Warnung mehr
// ===========================================================================
import { h, icon, clear, api, openSheet, segmented, callout, toast, errorToast, confirmDialog, withBusy, dateTime, loader } from "../core.js";

function detectPlatform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Mac OS X/.test(ua)) return "mac";
  if (/Windows/.test(ua)) return "windows";
  return "linux";
}
const isFirefox = () => /Firefox\//.test(navigator.userAgent);

const step = (n, ...content) => h("div", { class: "row", style: { alignItems: "flex-start", gap: "12px" } },
  h("div", { class: "avatar", style: { background: "var(--accent-soft)", color: "var(--accent)", width: "28px", height: "28px", fontSize: "13px", flex: "none" } }, String(n)),
  h("div", { style: { flex: 1, minWidth: 0, paddingTop: "3px" } }, ...content));

const code = (text) => h("pre", { class: "log", style: { margin: "8px 0 0", userSelect: "all", maxHeight: "none" } }, text);

function instructions(platform) {
  // Bausteine als Funktionen: ein DOM-Element kann nur an einer Stelle hängen
  const dl = () => h("a", { class: "btn primary sm", href: "/api/tls/ca.crt", download: "proxmox-zentrale-ca.crt" }, icon("download", "sm"), "Zertifikat herunterladen");
  const firefoxNote = () => callout("info", "Firefox", "Firefox hat eine eigene Zertifikatsliste: Einstellungen → Datenschutz & Sicherheit → ganz unten „Zertifikate anzeigen“ → Reiter „Zertifizierungsstellen“ → „Importieren“ → Datei wählen → Haken bei „Dieser CA vertrauen, um Websites zu identifizieren“.");
  const steps = {
    windows: [
      step(1, "Zertifikat herunterladen:", h("div", { style: { marginTop: "8px" } }, dl())),
      step(2, "Die heruntergeladene Datei öffnen → „Zertifikat installieren …“."),
      step(3, "„Lokaler Computer“ wählen → Weiter → „Alle Zertifikate in folgendem Speicher speichern“ → Durchsuchen → ", h("strong", null, "Vertrauenswürdige Stammzertifizierungsstellen"), " → OK → Weiter → Fertig stellen."),
      step(4, "Browser komplett schließen und neu öffnen. Chrome und Edge vertrauen der Oberfläche jetzt."),
      isFirefox() ? firefoxNote() : null,
    ],
    mac: [
      step(1, "Zertifikat herunterladen:", h("div", { style: { marginTop: "8px" } }, dl())),
      step(2, "Die Datei doppelklicken. Die Schlüsselbundverwaltung öffnet sich – als Schlüsselbund „System“ wählen und mit deinem Mac-Passwort bestätigen."),
      step(3, "In der Schlüsselbundverwaltung links „System“ wählen, das Zertifikat „Proxmox Zentrale CA“ doppelklicken → „Vertrauen“ aufklappen → „Bei Verwendung dieses Zertifikats“ auf ", h("strong", null, "Immer vertrauen"), " stellen. Fenster schließen und erneut bestätigen."),
      step(4, "Safari und Chrome neu starten."),
      isFirefox() ? firefoxNote() : null,
    ],
    ios: [
      step(1, "Diese Seite in ", h("strong", null, "Safari"), " öffnen (nicht in Chrome) und tippen:", h("div", { style: { marginTop: "8px" } }, dl()), h("div", { class: "muted small", style: { marginTop: "6px" } }, "Bei der Frage „Konfigurationsprofil laden?“ auf „Erlauben“ tippen.")),
      step(2, "Einstellungen öffnen → oben „Profil geladen“ (oder Allgemein → VPN & Geräteverwaltung) → „Proxmox Zentrale CA“ → ", h("strong", null, "Installieren"), " → Code eingeben."),
      step(3, "Einstellungen → Allgemein → Info → ganz unten ", h("strong", null, "Zertifikatsvertrauenseinstellungen"), " → Schalter bei „Proxmox Zentrale CA“ einschalten."),
      step(4, "Safari schließen und die Seite neu öffnen."),
    ],
    android: [
      step(1, "Zertifikat herunterladen:", h("div", { style: { marginTop: "8px" } }, dl())),
      step(2, "Einstellungen → Sicherheit & Datenschutz → Weitere Sicherheitseinstellungen → Verschlüsselung & Anmeldedaten → Zertifikat installieren → ", h("strong", null, "CA-Zertifikat"), " → „Trotzdem installieren“ → die heruntergeladene Datei wählen."),
      h("div", { class: "muted small" }, "Die Menünamen unterscheiden sich je nach Hersteller. Am schnellsten: in den Einstellungen nach „Zertifikat“ suchen."),
      step(3, "Chrome schließen und neu öffnen."),
    ],
    linux: [
      step(1, "Zertifikat herunterladen:", h("div", { style: { marginTop: "8px" } }, dl())),
      step(2, "Im Terminal (Debian/Ubuntu):", code("sudo cp ~/Downloads/proxmox-zentrale-ca.crt /usr/local/share/ca-certificates/\nsudo update-ca-certificates")),
      step(3, "Chrome/Chromium nutzen unter Linux eine eigene Liste:", code("certutil -d sql:$HOME/.pki/nssdb -A -t \"C,,\" -n \"Proxmox Zentrale CA\" -i ~/Downloads/proxmox-zentrale-ca.crt"), h("div", { class: "muted small", style: { marginTop: "4px" } }, "certutil steckt im Paket „libnss3-tools“.")),
      firefoxNote(),
    ],
  };
  return h("div", { class: "stack", style: { gap: "14px" } }, steps[platform]);
}

/** Die Anleitung als Sheet (auch vor der Anmeldung nutzbar). */
export function tlsGuideSheet() {
  openSheet((sheet, close) => {
    let platform = detectPlatform();
    const body = h("div");
    const draw = () => clear(body).append(instructions(platform));
    sheet.append(
      h("h2", null, "Browser-Warnung abschalten"),
      h("p", { class: "sheet-sub" }, "Die Verbindung ist schon verschlüsselt. Der Browser warnt nur, weil er dein Heimnetz-Zertifikat noch nicht kennt. Einmal pro Gerät installieren – danach erscheint das Schloss ohne Warnung."),
      h("div", { style: { overflowX: "auto", marginBottom: "16px" } }, segmented([
        { value: "windows", label: "Windows" }, { value: "mac", label: "Mac" }, { value: "ios", label: "iPhone/iPad" },
        { value: "android", label: "Android" }, { value: "linux", label: "Linux" }], platform, (v) => { platform = v; draw(); })),
      body,
      h("details", { class: "card flat", style: { marginTop: "18px", padding: "12px 14px" } },
        h("summary", { style: { cursor: "pointer", fontWeight: 620 } }, "Ist das sicher?"),
        h("p", { class: "muted small", style: { margin: "10px 0 0" } },
          "Das Zertifikat stammt von deinem eigenen Server und ist absichtlich eingeschränkt: Es gilt nur für private IP-Adressen (192.168.x.x, 10.x.x.x, …) und Heimnetz-Namen. "
          + "Selbst wenn jemand den Schlüssel von deinem Server stehlen würde, könnte er damit keine echten Webseiten wie deine Bank oder Google fälschen – der Browser würde das ablehnen. "
          + "Du kannst es jederzeit wieder entfernen.")),
      h("div", { class: "sheet-foot" }, h("button", { class: "btn primary", onclick: () => close() }, "Fertig")));
    draw();
  }, { wide: true });
}

/** Karte auf der Server-Seite: Zustand und Aktionen. */
export function tlsCard() {
  const card = h("div", { class: "card", style: { marginTop: "14px" } }, loader());
  async function load() {
    let t;
    try { t = (await api("/tls")).data; } catch (e) { clear(card).append(callout("warn", null, e.message)); return; }
    const secure = location.protocol === "https:";
    const days = t.cert?.not_after ? Math.floor((t.cert.not_after * 1000 - Date.now()) / 86400000) : null;
    const status = t.mode === "own" ? callout("ok", "Verschlüsselt mit deinem Heimnetz-Zertifikat",
      `Gültig für ${(t.cert?.names || []).join(", ")}${days !== null ? ` · erneuert sich automatisch (läuft noch ${days} Tage)` : ""}.`, "lock")
      : t.mode === "custom" ? callout("ok", "Verschlüsselt mit deinem eigenen Zertifikat", `Ausgestellt von ${t.cert?.issuer || "?"} – z. B. Let's Encrypt über Proxmox. Hier ist nichts zu tun.`, "lock")
        : t.mode === "pve" ? callout("warn", "Verschlüsselt mit dem Standard-Zertifikat von Proxmox", "Ein eigenes Heimnetz-Zertifikat konnte nicht erstellt werden (fehlt openssl?). Die Verbindung ist trotzdem verschlüsselt.")
          : callout("info", null, "Entwicklungsmodus.");
    const actions = h("div", { class: "row wrap", style: { marginTop: "12px" } });
    if (t.mode === "own") actions.append(h("button", { class: "btn primary", onclick: tlsGuideSheet }, icon("shield", "sm"), "Auf meinen Geräten einrichten"));
    if (t.mode === "own" && t.host_admin && t.proxmox !== "custom") {
      const using = t.proxmox === "ours";
      const b = h("button", { class: "btn" }, icon("lock", "sm"), using ? "Proxmox-Oberfläche: Standard wiederherstellen" : "Auch für die Proxmox-Oberfläche nutzen");
      b.addEventListener("click", async () => {
        if (!await confirmDialog(using
          ? { title: "Standard-Zertifikat für Proxmox?", text: "Die Proxmox-Oberfläche (Port 8006) nutzt danach wieder ihr eigenes Zertifikat, und der Browser warnt dort wieder.", confirmText: "Wiederherstellen" }
          : { title: "Auch für die Proxmox-Oberfläche?", text: "Die normale Proxmox-Seite (Port 8006) bekommt dasselbe Heimnetz-Zertifikat. Auf Geräten, auf denen du es installiert hast, verschwindet die Warnung dann auch dort. Die Proxmox-Oberfläche startet dafür kurz neu. Rückgängig machen geht jederzeit hier.", confirmText: "Übernehmen" })) return;
        await withBusy(b, async () => {
          try { await api("/tls/proxmox", { method: using ? "DELETE" : "POST" }); toast(using ? "Proxmox nutzt wieder das Standard-Zertifikat" : "Proxmox nutzt jetzt das Heimnetz-Zertifikat", "Die Proxmox-Oberfläche war kurz nicht erreichbar."); load(); }
          catch (e) { errorToast(e); }
        });
      });
      actions.append(b);
    }
    clear(card).append(
      h("div", { class: "card-head" }, icon("lock"), h("h3", null, "Sichere Verbindung (HTTPS)")),
      !secure ? callout("bad", "Diese Seite ist gerade unverschlüsselt", "Bitte über https:// aufrufen.") : status,
      t.mode === "own" ? h("p", { class: "muted small", style: { margin: "10px 0 0" } }, `Zeigt dein Browser „Nicht sicher“? Dann einmal das Heimnetz-Zertifikat auf dem Gerät installieren. ${t.http_port ? `Übrigens: Die nackte Adresse ohne https:// und ohne :${t.port} funktioniert auch – sie wird automatisch umgeleitet.` : ""}`) : null,
      t.ca?.not_after ? h("p", { class: "muted small", style: { margin: "4px 0 0" } }, `Heimnetz-Zertifizierungsstelle gültig bis ${dateTime(t.ca.not_after).split(",")[0]}.`) : null,
      actions);
  }
  load();
  return card;
}
