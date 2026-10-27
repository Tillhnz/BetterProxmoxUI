// ===========================================================================
// Großes Upgrade (Proxmox VE 8 → 9) – geführter Assistent
// ===========================================================================
import {
  h, icon, clear, api, pve, state, bytes, nodePath, toast, errorToast, confirmDialog, withBusy, pageHead, callout, loader,
  toggle,
} from "../core.js";
import { backupNowSheet } from "./guests.js";
import { loadBackupItems } from "./backups.js";

const GB = 1024 ** 3;
const PHASES = [
  ["check-before", "Prüfung"], ["download", "Herunterladen"], ["install", "Installieren"], ["after", "Nacharbeiten"], ["ui", "Oberfläche anpassen"],
];

// Hilfen zu bekannten Meldungen der offiziellen Prüfung
const HINTS = [
  [/systemd-boot meta-package/i, "Das Paket „systemd-boot“ ist installiert, wird aber nicht genutzt. Entfernen mit:", "apt remove systemd-boot"],
  [/autoactivation/i, "Bei LVM-Festplatten soll die automatische Aktivierung abgeschaltet werden. Proxmox bringt dafür ein Skript mit:", "/usr/share/pve-manager/migrations/pve-lvm-disable-autoactivation"],
  [/sysctl\.conf/i, "Einstellungen aus /etc/sysctl.conf werden ab Proxmox 9 nicht mehr gelesen. Der Assistent übernimmt sie automatisch nach /etc/sysctl.d/."],
  [/cgroup.?v1|systemd.*(too old|older)/i, "Sehr alte Container (z. B. CentOS 7, Ubuntu 16.04) starten unter Proxmox 9 nicht mehr. Vorher aktualisieren oder ersetzen."],
  [/intel-microcode|amd64-microcode|microcode/i, "Für die Prozessor-Updates muss die Debian-Quelle „non-free-firmware“ aktiviert sein."],
  [/running kernel|reboot/i, "Vor dem Upgrade einmal neu starten, damit der aktuelle Kernel läuft."],
  [/(not|no) (up-to-date|latest)|package updates/i, "Zuerst alle Updates von Proxmox 8 installieren (Schritt 1)."],
];
const hintFor = (text) => HINTS.find(([re]) => re.test(text));

export async function upgradeAvailable() {
  if (!state.user?.host_admin) return null;
  try { const d = (await api("/upgrade")).data; return d.path ? d : null; } catch { return null; }
}

const statusIcon = (ok) => h("span", { style: { color: ok === true ? "var(--ok)" : ok === "warn" ? "var(--warn)" : ok === null ? "var(--muted)" : "var(--bad)", display: "flex" } },
  icon(ok === true ? "checkCircle" : ok === "warn" ? "alert" : ok === null ? "clock" : "xCircle"));

function stepCard(n, title, stateName, ...content) {
  const cls = stateName === "done" ? "ok" : stateName === "active" ? "accent" : "";
  return h("div", { class: `card upgrade-step ${stateName}`, style: { marginTop: "14px" } },
    h("div", { class: "row", style: { gap: "12px", marginBottom: stateName === "locked" ? 0 : "14px" } },
      h("div", { class: `step-num ${cls}` }, stateName === "done" ? icon("check", "sm") : String(n)),
      h("h3", { style: { margin: 0, fontSize: "16.5px" } }, title),
      stateName === "locked" ? h("span", { class: "muted small", style: { marginLeft: "auto" } }, "Nach dem vorherigen Schritt") : null),
    stateName === "locked" ? null : content);
}

export async function renderUpgrade({ page, el, go }) {
  el.append(h("a", { class: "back", href: "#/updates" }, icon("chevronLeft", "sm"), "Updates"));
  const body = h("div", null, loader());
  el.append(body);
  if (!state.user.host_admin) { clear(body).append(pageHead("Großes Upgrade", ""), callout("info", null, "Das große Upgrade darf nur root@pam durchführen.")); return; }

  let info, check = null, repoResult = null, ackAccess = false, ackBackup = false, backups = null, subscribed = false;
  let pollTimer = null;
  page.onLeave(() => clearTimeout(pollTimer));

  async function load() {
    try { info = (await api("/upgrade")).data; } catch (e) { clear(body).append(callout("bad", "Laden fehlgeschlagen", e.message)); return false; }
    try { subscribed = String((await pve("GET", nodePath("/subscription")))?.status || "").toLowerCase() === "active"; } catch { /* egal */ }
    return true;
  }

  async function loadBackups() {
    try {
      const [res, stores] = await Promise.all([pve("GET", "/cluster/resources", { type: "vm" }), pve("GET", nodePath("/storage"), { content: "backup", enabled: 1 })]);
      const guests = res.filter(g => g.node === state.node && !g.template);
      const items = await loadBackupItems(stores);
      const last = new Map();
      for (const b of items) if (!last.has(String(b.vmid))) last.set(String(b.vmid), b.ctime);
      const stale = guests.filter(g => !last.get(String(g.vmid)) || Date.now() / 1000 - last.get(String(g.vmid)) > 2 * 86400);
      backups = { guests, stale, last };
    } catch { backups = { guests: [], stale: [], last: new Map() }; }
  }

  function draw() {
    clear(body);
    const p = info.path;
    if (!p) {
      body.append(pageHead("Großes Upgrade", ""));
      if (info.latest_major) {
        body.append(callout("ok", `Du nutzt Proxmox VE ${info.version || "9"} – die neueste Hauptversion`, "Normale Updates findest du wie gewohnt unter „Updates“."));
        if (info.state?.state === "done") body.append(h("div", { class: "card", style: { marginTop: "14px" } },
          h("div", { class: "card-head" }, icon("checkCircle"), h("h3", null, "Upgrade abgeschlossen")),
          h("p", { class: "muted", style: { marginTop: 0 } }, "Ein paar Dinge lohnen sich jetzt noch: unter „Empfehlungen“ prüfen, ob alles grün ist, alle Maschinen einmal starten und testen und eine frische Sicherung erstellen."),
          h("button", { class: "btn", onclick: async () => { await api("/upgrade/reset", { method: "POST" }); load().then(ok => ok && draw()); } }, "Hinweis ausblenden")));
      } else body.append(callout("info", "Für diese Version gibt es keinen Assistenten", `Erkannt: Debian „${info.codename || "?"}“, Proxmox ${info.version || "?"}. Bitte die offizielle Anleitung von Proxmox nutzen.`));
      return;
    }

    body.append(pageHead(`Upgrade auf Proxmox VE ${p.to}`, `Von Version ${info.version} (Debian 12 „bookworm“) auf ${p.to} (Debian 13 „trixie“). Plane etwa 30–60 Minuten ein.`,
      [h("a", { class: "btn ghost", href: p.guide, target: "_blank", rel: "noopener" }, icon("external", "sm"), "Offizielle Anleitung")]));

    const st = info.state?.state;
    if (st === "running" || st === "done" || st === "failed") { drawProgress(); return; }

    // ---------- 1. Voraussetzungen ----------
    const free = info.root_free;
    const freeOk = free >= 10 * GB ? true : free >= 5 * GB ? "warn" : false;
    const backupsOk = backups ? (backups.stale.length === 0 ? true : ackBackup ? "warn" : false) : null;
    const blockers = [];
    if (!info.version_ok) blockers.push("version");
    if (freeOk === false) blockers.push("space");
    if (info.cluster) blockers.push("cluster");
    if (info.ceph) blockers.push("ceph");
    if (backupsOk === false) blockers.push("backup");
    if (!ackAccess) blockers.push("access");
    const pre = blockers.length === 0;

    const row = (ok, title, text, action) => h("div", { class: "list-item", style: { alignItems: "flex-start" } },
      h("div", { style: { paddingTop: "2px" } }, statusIcon(ok)),
      h("div", { class: "grow" }, h("div", { class: "title", style: { whiteSpace: "normal" } }, title), text ? h("div", { class: "meta", style: { whiteSpace: "normal" } }, text) : null,
        action ? h("div", { style: { marginTop: "8px" } }, action) : null));

    const upd = h("button", { class: "btn sm primary" }, icon("download", "sm"), `Auf die neueste ${p.from}.x aktualisieren`);
    upd.addEventListener("click", () => withBusy(upd, async () => {
      try { await pve("POST", nodePath("/apt/update")); const r = await api("/jobs", { method: "POST", body: { kind: "upgrade" } }); go(`job/${r.data.id}`); } catch (e) { errorToast(e); }
    }));
    const others = info.repos.filter(r => r.kind === "other" && r.suites.some(x => x.includes(info.codename)));
    const step1 = stepCard(1, "Voraussetzungen", pre ? "done" : "active",
      h("div", { class: "card pad-0 flat" }, h("div", { class: "list" },
        row(info.version_ok, `Proxmox ${info.version || "?"} ${info.version_ok ? "ist aktuell genug" : `– mindestens ${p.min} nötig`}`, info.version_ok ? null : "Erst alle Updates von Proxmox 8 installieren, dann geht es weiter.", info.version_ok ? null : upd),
        row(freeOk, `${bytes(free)} frei auf der System-Festplatte`, freeOk === true ? null : freeOk === "warn" ? "Reicht knapp. Empfohlen sind über 10 GB – alte Sicherungen und ISO-Dateien löschen hilft." : "Zu wenig Platz (mindestens 5 GB). Bitte zuerst aufräumen.",
          freeOk === true ? null : h("a", { class: "btn sm", href: "#/backups" }, "Sicherungen aufräumen")),
        row(!info.cluster, info.cluster ? "Cluster erkannt" : "Einzelner Server", info.cluster ? "Für Cluster unterstützt der Assistent das Upgrade nicht. Bitte jeden Server einzeln nach der offiziellen Anleitung aktualisieren." : null),
        row(!info.ceph, info.ceph ? "Ceph erkannt" : "Kein Ceph", info.ceph ? "Mit Ceph ist das Upgrade deutlich aufwendiger (zuerst Ceph auf „Squid“ aktualisieren). Bitte der offiziellen Anleitung folgen." : null),
        row(backupsOk, backups ? (backups.stale.length ? `${backups.stale.length} Maschine${backups.stale.length === 1 ? " hat" : "n haben"} keine frische Sicherung` : `Alle ${backups.guests.length} Maschinen sind frisch gesichert`) : "Sicherungen werden geprüft …",
          backups?.stale.length ? `${backups.stale.map(g => g.name).join(", ")} – älter als 2 Tage oder gar nicht gesichert. Proxmox schreibt vor dem Upgrade eine getestete Sicherung vor.` : null,
          backups?.stale.length ? h("div", { class: "row wrap" }, h("button", { class: "btn sm primary", onclick: () => backupNowSheet([], true) }, icon("archive", "sm"), "Jetzt alle sichern"),
            toggle("Ohne frische Sicherung fortfahren", null, ackBackup, (v) => { ackBackup = v; draw(); })) : null),
        row(ackAccess || false, "Notfall-Zugang", "Startet der Server nach dem Upgrade nicht mehr richtig, hilft keine Weboberfläche – dann brauchst du Bildschirm und Tastatur am Server (oder IPMI).",
          toggle("Ich komme notfalls direkt an den Server", null, ackAccess, (v) => { ackAccess = v; draw(); })),
        others.length ? row("warn", "Fremde Paketquellen", `${[...new Set(others.map(r => r.file))].join(", ")} – werden beim Umstellen abgeschaltet, weil sie für Debian 12 eingerichtet sind. Danach beim Anbieter nachsehen, ob es eine Version für Debian 13 gibt.`) : null,
        info.sysctl_custom ? row("warn", "Eigene Einstellungen in /etc/sysctl.conf", "Werden automatisch nach /etc/sysctl.d/ übernommen, da Proxmox 9 die alte Datei nicht mehr liest.") : null)));

    // ---------- 2. Offizielle Prüfung ----------
    const checkBtn = h("button", { class: `btn ${check ? "" : "primary"}` }, icon("shield", "sm"), check ? "Erneut prüfen" : "Prüfung starten");
    checkBtn.addEventListener("click", () => withBusy(checkBtn, async () => {
      try { check = (await api("/upgrade/check", { method: "POST" })).data; draw(); } catch (e) { errorToast(e); }
    }));
    const fails = check?.summary?.failures ?? check?.items.filter(i => i.level === "fail").length ?? null;
    const checkOk = check && fails === 0;
    const checkBody = [h("p", { class: "muted", style: { marginTop: 0 } }, `Proxmox bringt ein eigenes Prüfprogramm („${p.checker}“) mit. Es verändert nichts, sondern sagt nur, was vorher zu tun ist.`)];
    if (!info.checker) checkBody.push(callout("warn", null, `„${p.checker}“ ist noch nicht installiert – es kommt mit den neuesten Updates von Proxmox ${p.from}.`));
    if (check) checkBody.push(checkResult(check));
    checkBody.push(h("div", { class: "row wrap", style: { marginTop: "12px" } }, checkBtn));
    const step2 = stepCard(2, "Offizielle Prüfung", !pre ? "locked" : checkOk ? "done" : "active", ...checkBody);

    // ---------- 3. Paketquellen ----------
    let step3State = !pre || !checkOk ? "locked" : info.repos_switched && (!repoResult || repoResult.apt_ok) ? "done" : "active";
    const switchBtn = h("button", { class: "btn primary" }, icon("refresh", "sm"), "Paketquellen umstellen");
    switchBtn.addEventListener("click", () => withBusy(switchBtn, async () => {
      try { repoResult = (await api("/upgrade/repos", { method: "POST", body: { enterprise: subscribed } })).data; await load(); draw(); } catch (e) { errorToast(e); }
    }));
    const undoBtn = h("button", { class: "btn ghost" }, "Rückgängig machen");
    undoBtn.addEventListener("click", async () => {
      if (!await confirmDialog({ title: "Paketquellen zurücksetzen?", text: "Die Paketquellen werden wieder auf Proxmox 8 / Debian 12 gestellt – genau wie vorher.", confirmText: "Zurücksetzen" })) return;
      await withBusy(undoBtn, async () => { try { await api("/upgrade/repos", { method: "DELETE" }); repoResult = null; await load(); draw(); toast("Paketquellen zurückgesetzt"); } catch (e) { errorToast(e); } });
    });
    const step3 = stepCard(3, "Paketquellen umstellen", step3State,
      h("p", { class: "muted", style: { marginTop: 0 } }, "Dein Server holt seine Programme aus „Paketquellen“. Die werden jetzt auf die neuen Versionen umgestellt – installiert wird dabei noch nichts. Rückgängig machen geht jederzeit vor dem Upgrade."),
      h("ul", { class: "plain-list" },
        h("li", null, "Debian: „bookworm“ (12) → „trixie“ (13)"),
        h("li", null, `Proxmox: Version ${p.from} → ${p.to} (${subscribed ? "Enterprise – du hast ein Abo" : "kostenlose No-Subscription-Quelle"})`),
        info.repos.some(r => r.kind === "ceph") ? h("li", null, "Ceph-Programme: auf „Squid“") : null,
        others.length ? h("li", null, `Abgeschaltet: ${[...new Set(others.map(r => r.file))].join(", ")}`) : null),
      repoResult ? (repoResult.apt_ok ? callout("ok", "Paketquellen umgestellt", "Die neuen Paketlisten wurden erfolgreich geladen.")
        : h("div", null, callout("bad", "Paketlisten konnten nicht geladen werden", "Das Upgrade kann so nicht starten. Oft ist es nur ein vorübergehender Netzwerkfehler – erneut versuchen oder rückgängig machen."),
          h("div", { class: "log", style: { marginTop: "10px", maxHeight: "200px" } }, (repoResult.apt_errors || []).join("\n") || repoResult.apt_output))) : null,
      h("div", { class: "row wrap", style: { marginTop: "12px" } }, info.repos_switched ? null : switchBtn, info.repos_switched || info.backup_available ? undoBtn : null,
        info.repos_switched && repoResult && !repoResult.apt_ok ? h("button", { class: "btn", onclick: () => switchBtn.click() }, "Erneut versuchen") : null));

    // ---------- 4. Upgrade ----------
    const ready = step3State === "done";
    const startBtn = h("button", { class: "btn primary lg" }, icon("download", "sm"), `Upgrade auf Proxmox ${p.to} starten`);
    startBtn.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: `Jetzt auf Proxmox ${p.to} aktualisieren?`,
        text: "Das Upgrade läuft selbstständig auf dem Server weiter – auch wenn du die Seite schließt. Deine Maschinen laufen zunächst weiter, nach dem Neustart des Servers sind sie kurz aus. Nicht während des Upgrades den Server ausschalten!",
        confirmText: "Upgrade starten", danger: true, typeToConfirm: state.node,
      });
      if (!ok) return;
      await withBusy(startBtn, async () => { try { await api("/upgrade/start", { method: "POST" }); await load(); draw(); } catch (e) { errorToast(e); } });
    });
    const step4 = stepCard(4, "Upgrade durchführen", ready ? "active" : "locked",
      h("p", { class: "muted", style: { marginTop: 0 } }, "Lädt alle Pakete herunter, installiert sie und prüft danach erneut. Bei Rückfragen zu Konfigurationsdateien gilt: Von dir geänderte Dateien bleiben erhalten, unveränderte bekommen die neue Fassung."),
      startBtn);
    const step5 = stepCard(5, "Neu starten", "locked");

    body.append(step1, step2, step3, step4, step5);
  }

  function checkResult(c) {
    const s = c.summary || {};
    const group = (lvl, title, cls) => {
      const items = c.items.filter(i => i.level === lvl);
      if (!items.length) return null;
      return h("div", { style: { marginTop: "12px" } }, h("div", { class: "label", style: { marginBottom: "6px", color: `var(--${cls})` } }, `${title} (${items.length})`),
        h("div", { class: "card pad-0 flat" }, h("div", { class: "list" }, items.map(i => {
          const hint = hintFor(i.text);
          return h("div", { class: "list-item", style: { alignItems: "flex-start" } },
            h("div", { class: "grow" }, h("div", { class: "mono small", style: { whiteSpace: "normal" } }, i.text),
              hint ? h("div", { class: "small", style: { marginTop: "6px" } }, hint[1], hint[2] ? h("pre", { class: "log", style: { margin: "6px 0 0", userSelect: "all" } }, hint[2]) : null) : null,
              hint?.[2] ? h("div", { class: "muted small", style: { marginTop: "4px" } }, "Befehl in der Host-Konsole (Server → Host-Konsole) ausführen, dann erneut prüfen.") : null));
        }))));
    };
    return h("div", null,
      h("div", { class: "row wrap", style: { gap: "8px" } },
        h("span", { class: `badge ${s.failures ? "bad" : "ok"}` }, `${s.failures || 0} Fehler`),
        h("span", { class: `badge ${s.warnings ? "warn" : "ok"}` }, `${s.warnings || 0} Warnungen`),
        h("span", { class: "badge" }, `${s.passed || 0} in Ordnung`)),
      s.failures ? callout("bad", "Erst die Fehler beheben", "Solange die Prüfung Fehler meldet, startet das Upgrade nicht.") : s.warnings ? callout("warn", null, "Warnungen solltest du dir ansehen – sie verhindern das Upgrade aber nicht.") : callout("ok", null, "Alles bereit."),
      group("fail", "Fehler – müssen behoben werden", "bad"),
      group("warn", "Warnungen", "warn"),
      group("notice", "Hinweise", "info"),
      h("details", { style: { marginTop: "10px" } }, h("summary", { style: { cursor: "pointer" } }, "Komplette Ausgabe"), h("div", { class: "log", style: { marginTop: "8px" } }, c.raw || "")));
  }

  // ---------- Fortschritt / Ergebnis ----------
  let offset = 0;
  function drawProgress() {
    const st = info.state;
    const logEl = h("div", { class: "log", style: { maxHeight: "55vh", minHeight: "200px" } });
    const phaseBar = h("div", { class: "upgrade-phases" });
    const head = h("div");
    const actions = h("div", { class: "row wrap", style: { marginTop: "14px" } });
    body.append(h("div", { class: "card", style: { marginTop: "14px" } }, head, phaseBar, h("div", { style: { marginTop: "14px" } }, logEl), actions));
    offset = 0;

    function drawHead(s) {
      const idx = PHASES.findIndex(([k]) => k === s.phase);
      clear(phaseBar).append(PHASES.map(([k, label], i) => {
        const done = s.state === "done" || i < idx;
        const now = s.state === "running" && i === idx;
        const bad = s.state === "failed" && i === idx;
        return h("div", { class: `phase ${done ? "done" : ""} ${now ? "now" : ""} ${bad ? "bad" : ""}` },
          h("span", { class: "dot" }, done ? icon("check", "sm") : now ? icon("spinner", "spin sm") : bad ? icon("x", "sm") : String(i + 1)), h("span", null, label));
      }));
      clear(head).append(
        s.state === "running" ? callout("info", "Upgrade läuft …", "Du kannst diese Seite schließen – das Upgrade läuft auf dem Server weiter. Den Server jetzt bitte nicht ausschalten oder neu starten.", "spinner")
          : s.state === "done" ? callout("ok", `Upgrade installiert – fast geschafft!`, "Jetzt den Server neu starten. Danach läuft Proxmox in der neuen Version.")
            : callout("bad", "Upgrade nicht vollständig", "Bitte den Server NICHT neu starten. Das Protokoll unten zeigt, wo es hakt. Oft hilft es, das Upgrade erneut zu starten – oder in der Host-Konsole „apt -f install“ und „apt dist-upgrade“ auszuführen."));
      clear(actions);
      if (s.state === "done") {
        const rb = h("button", { class: "btn primary lg" }, icon("restart", "sm"), "Server jetzt neu starten");
        rb.addEventListener("click", async () => {
          if (!await confirmDialog({ title: "Server neu starten?", text: "Alle Maschinen werden heruntergefahren und nach dem Start (mit Autostart) wieder gestartet. Der erste Start mit dem neuen Kernel kann etwas länger dauern.", confirmText: "Neu starten", danger: true, typeToConfirm: state.node })) return;
          try { await pve("POST", nodePath("/status"), { command: "reboot" }); waitForReboot(); } catch (e) { errorToast(e); }
        });
        actions.append(rb);
      }
      if (s.state === "failed") {
        actions.append(
          h("button", { class: "btn primary", onclick: async () => {
            if (!await confirmDialog({ title: "Upgrade erneut starten?", text: "Das Upgrade setzt dort an, wo es aufgehört hat.", confirmText: "Erneut starten" })) return;
            try { await api("/upgrade/start", { method: "POST" }); await load(); draw(); } catch (e) { errorToast(e); }
          } }, icon("restart", "sm"), "Erneut versuchen"),
          h("a", { class: "btn", href: "#/node" }, icon("terminal", "sm"), "Host-Konsole"),
          s.phase === "check-before" ? h("button", { class: "btn ghost", onclick: async () => { await api("/upgrade/reset", { method: "POST" }); await load(); draw(); } }, "Zurück zum Assistenten") : null);
      }
    }

    async function poll() {
      try {
        const r = (await api("/upgrade/status", { query: { offset } })).data;
        if (r.offset < offset) logEl.textContent = "";
        if (r.log) { logEl.textContent += r.log; logEl.scrollTop = logEl.scrollHeight; }
        offset = r.offset;
        drawHead(r);
        if (r.state === "running") pollTimer = setTimeout(poll, 2000);
      } catch {
        clear(head).append(callout("info", "Die Oberfläche wird gerade angepasst …", "Kurz warten – die Seite verbindet sich gleich wieder.", "spinner"));
        pollTimer = setTimeout(poll, 4000);
      }
    }
    drawHead(st);
    poll();
  }

  function waitForReboot() {
    clear(body).append(pageHead("Server startet neu …", ""), callout("info", "Bitte warten", "Das dauert meist 2–5 Minuten. Die Seite lädt automatisch neu, sobald der Server wieder da ist.", "spinner"));
    let seenDown = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/health", { cache: "no-store" });
        if (r.ok && seenDown) { location.hash = "#/upgrade"; location.reload(); return; }
      } catch { seenDown = true; }
      pollTimer = setTimeout(tick, 5000);
    };
    setTimeout(tick, 15000);
    setTimeout(() => { if (!seenDown) seenDown = true; }, 120000);
  }

  if (!await load()) return;
  draw();
  loadBackups().then(() => { if (!["running", "done", "failed"].includes(info.state?.state)) draw(); });
}

/** Karte für die Seite „Updates“. */
export function upgradeCard(go) {
  const box = h("div");
  upgradeAvailable().then(d => {
    if (!d) return;
    const running = ["running", "done", "failed"].includes(d.state?.state);
    box.append(h("div", { class: "card upgrade-teaser", style: { marginBottom: "14px" } },
      h("div", { class: "row wrap", style: { gap: "14px" } },
        h("div", { class: "guest-icon ct", style: { width: "48px", height: "48px" } }, icon("sparkle", "lg")),
        h("div", { style: { flex: 1, minWidth: "200px" } },
          h("h3", { style: { fontSize: "17px" } }, running ? `Upgrade auf Proxmox ${d.path.to}: ${d.state.state === "running" ? "läuft" : d.state.state === "done" ? "Neustart nötig" : "unterbrochen"}` : `Neue Hauptversion: Proxmox VE ${d.path.to}`),
          h("div", { class: "muted small" }, running ? "Fortschritt ansehen" : `Du nutzt ${d.version}. Ein Assistent führt Schritt für Schritt durch das Upgrade – mit Prüfung, Sicherung und Rückweg.`)),
        h("button", { class: "btn primary", onclick: () => go("upgrade") }, running ? "Öffnen" : "Upgrade-Assistent", icon("chevronRight", "sm")))));
  });
  return box;
}

