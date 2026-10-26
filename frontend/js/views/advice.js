// ===========================================================================
// Empfehlungen: Gesundheits- und Sicherheits-Check mit klaren Handlungsschritten
// ===========================================================================
import {
  h, icon, clear, api, pve, state, bytes, pct, nodePath, enc, toast, errorToast, confirmDialog, withBusy, pageHead, callout,
  relTime, guestIcon, LOCK_TEXT,
} from "../core.js";
import { unlockFlow } from "./guests.js";
import { analyzeAll, applySizing } from "../sizing.js";

const LEVELS = {
  bad: { label: "Dringend", order: 0, cls: "bad", ico: "alert" },
  warn: { label: "Empfohlen", order: 1, cls: "warn", ico: "info" },
  info: { label: "Gut zu wissen", order: 2, cls: "info", ico: "info" },
  ok: { label: "Alles in Ordnung", order: 3, cls: "ok", ico: "checkCircle" },
};
const CATS = { daten: "Datensicherheit", sicherheit: "Sicherheit", system: "System", speicher: "Speicher", leistung: "Leistung" };

function dismissed() { try { return new Set(JSON.parse(localStorage.getItem("bpui-dismissed") || "[]")); } catch { return new Set(); } }
function setDismissed(set) { try { localStorage.setItem("bpui-dismissed", JSON.stringify([...set])); } catch { /* egal */ } }

const settle = (p) => p.then(v => v, () => null);

// ---------------------------------------------------------------------------
// Alle Prüfungen
// ---------------------------------------------------------------------------
let cache = null;
export async function runChecks({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.time < 60000) return cache.items;
  const admin = state.user.host_admin;
  const node = state.node;
  const [res, nodeStatus, updates, jobs, nodeStores, repos, sub, tfa, certs, disks, zfs, fw, host] = await Promise.all([
    settle(pve("GET", "/cluster/resources")),
    settle(pve("GET", nodePath("/status"))),
    settle(pve("GET", nodePath("/apt/update"))),
    settle(pve("GET", "/cluster/backup")),
    settle(pve("GET", nodePath("/storage"))),
    settle(pve("GET", nodePath("/apt/repositories"))),
    settle(pve("GET", nodePath("/subscription"))),
    settle(pve("GET", `/access/tfa/${enc(state.user.username)}`)),
    settle(pve("GET", nodePath("/certificates/info"))),
    settle(pve("GET", nodePath("/disks/list"))),
    settle(pve("GET", nodePath("/disks/zfs"))),
    settle(pve("GET", "/cluster/firewall/options")),
    admin ? settle(api("/host/checks").then(r => r.data)) : Promise.resolve(null),
  ]);
  const items = [];
  const add = (it) => items.push(it);
  const guests = (res || []).filter(r => (r.type === "qemu" || r.type === "lxc") && r.node === node && !r.template);
  const nodeRes = (res || []).find(r => r.type === "node" && r.node === node) || {};

  // Konfigurationen der Maschinen (für Autostart, Agent, privilegierte Container)
  const configs = new Map();
  await Promise.all(guests.map(async g => { const c = await settle(pve("GET", nodePath(`/${g.type}/${g.vmid}/config`))); if (c) configs.set(g.vmid, c); }));

  // ---------- Datensicherheit: Sicherungen ----------
  if (jobs) {
    const active = jobs.filter(j => !(j.enabled === 0 || j.enabled === "0"));
    if (!jobs.length) {
      add({ id: "backup-none", level: "bad", cat: "daten", title: "Keine automatische Sicherung eingerichtet",
        why: "Geht eine Festplatte kaputt oder läuft ein Update schief, sind deine Daten in den Maschinen weg.",
        todo: "Richte einen täglichen Zeitplan ein, der alle Maschinen sichert – am besten auf eine NAS.",
        actions: [{ label: "Zeitplan einrichten", href: "#/backups" }] });
    } else if (!active.length) {
      add({ id: "backup-disabled", level: "bad", cat: "daten", title: "Alle Sicherungs-Zeitpläne sind pausiert",
        why: "Es werden gerade keine neuen Sicherungen erstellt.", todo: "Aktiviere den Zeitplan wieder.",
        actions: [{ label: "Zu den Sicherungen", href: "#/backups" }] });
    } else {
      const covered = new Set();
      let allCovered = false;
      for (const j of active) {
        if (j.all) {
          const ex = new Set(String(j.exclude || "").split(",").filter(Boolean));
          guests.forEach(g => { if (!ex.has(String(g.vmid))) covered.add(g.vmid); });
          if (!ex.size) allCovered = true;
        } else if (j.vmid) String(j.vmid).split(",").forEach(v => covered.add(Number(v)));
        else if (j.pool) allCovered = true; // Pools prüfen wir nicht im Detail
      }
      const missing = allCovered ? [] : guests.filter(g => !covered.has(g.vmid));
      if (missing.length) {
        add({ id: `backup-missing-${missing.map(g => g.vmid).join("-")}`, level: "warn", cat: "daten",
          title: `${missing.length} Maschine${missing.length === 1 ? " wird" : "n werden"} nicht gesichert`,
          why: `Nicht in einem Zeitplan: ${missing.map(g => g.name).join(", ")}.`,
          todo: "Stelle den Zeitplan auf „Alle Maschinen“ – dann sind auch künftige Maschinen automatisch dabei.",
          guests: missing, actions: [{ label: "Zu den Sicherungen", href: "#/backups" }] });
      } else add({ id: "backup-ok", level: "ok", cat: "daten", title: "Alle Maschinen sind in einem Sicherungs-Zeitplan" });

      // Wo landen die Sicherungen?
      const storeType = new Map((nodeStores || []).map(s => [s.storage, s.type]));
      const onlyLocal = active.every(j => ["dir", "lvmthin", "lvm", "zfspool", "btrfs"].includes(storeType.get(j.storage)) && !String(j.storage).includes("nas"));
      if (onlyLocal && (nodeStores || []).length) {
        const hasNasBackup = (nodeStores || []).some(s => ["cifs", "nfs", "pbs"].includes(s.type) && String(s.content).includes("backup") && s.active);
        add({ id: "backup-local", level: "warn", cat: "daten", title: "Sicherungen liegen auf demselben Server",
          why: "Fällt der Server aus (Defekt, Diebstahl, Überspannung), sind die Sicherungen mit weg. Außerdem belegen sie die System-Festplatte.",
          todo: hasNasBackup ? "Stelle den Zeitplan auf deine NAS um." : "Verbinde eine NAS-Freigabe für Sicherungen und stelle den Zeitplan darauf um. Ideal ist die 3-2-1-Regel: 3 Kopien, 2 Speichermedien, 1 außer Haus.",
          actions: [{ label: hasNasBackup ? "Auf NAS umstellen" : "NAS verbinden", href: "#/storage" }] });
      }
      // Aufbewahrung
      const noPrune = active.filter(j => !j["prune-backups"] && !j.maxfiles);
      if (noPrune.length) {
        const stCfg = await settle(pve("GET", "/storage"));
        const storPrune = new Map((stCfg || []).map(s => [s.storage, s["prune-backups"]]));
        const reallyNone = noPrune.filter(j => !storPrune.get(j.storage) || /keep-all=1/.test(storPrune.get(j.storage)));
        if (reallyNone.length) add({ id: "backup-noprune", level: "warn", cat: "speicher", title: "Alte Sicherungen werden nie gelöscht",
          why: "Ohne Aufbewahrungsregel wächst der Speicher immer weiter, bis er voll ist.",
          todo: "Lege fest, wie viele Sicherungen behalten werden (z. B. die letzten 7).",
          actions: [{ label: "Regel auf 7 setzen", run: async () => { for (const j of reallyNone) await pve("PUT", `/cluster/backup/${enc(j.id)}`, { "prune-backups": "keep-last=7" }); toast("Aufbewahrung gesetzt", "Es werden jetzt die letzten 7 Sicherungen behalten."); } }] });
      }
      // Alter der letzten Sicherung
      const backupStores = (nodeStores || []).filter(s => String(s.content).includes("backup") && s.active);
      const last = new Map();
      await Promise.all(backupStores.map(async s => {
        const list = await settle(pve("GET", nodePath(`/storage/${enc(s.storage)}/content`), { content: "backup" }));
        for (const b of list || []) if (b.vmid && (!last.get(b.vmid) || b.ctime > last.get(b.vmid))) last.set(b.vmid, b.ctime);
      }));
      const old = guests.filter(g => covered.has(g.vmid) || allCovered).filter(g => !last.get(g.vmid) || Date.now() / 1000 - last.get(g.vmid) > 8 * 86400);
      if (old.length) add({ id: "backup-old", level: "warn", cat: "daten", title: "Sicherungen sind veraltet oder fehlen",
        why: old.map(g => `${g.name}: ${last.get(g.vmid) ? "letzte " + relTime(last.get(g.vmid)) : "noch nie gesichert"}`).join(" · "),
        todo: "Prüfe unter „Aktivität“, ob die Sicherungen fehlschlagen (z. B. weil der Speicher voll oder die NAS aus ist), und starte eine Sicherung von Hand.",
        guests: old, actions: [{ label: "Aktivität ansehen", href: "#/tasks" }, { label: "Jetzt sichern", href: "#/backups" }] });
    }
  }

  // ---------- Leistung: passt die Größe der Dienste? ----------
  const nodeCores = nodeStatus?.cpuinfo?.cpus || nodeRes.maxcpu || 4;
  const sizing = await analyzeAll(guests, configs, nodeCores).catch(() => []);
  for (const sz of sizing) {
    add({ id: `${sz.id}-${Math.round((sz.to || 0) / 1e6)}`, level: sz.level, cat: "leistung", title: sz.title, why: sz.why, todo: sz.todo, guests: [sz.guest],
      sizing: sz, actions: [{ label: sz.dir === "up" ? "Erhöhen" : "Reduzieren", run: () => applySizing(sz) }] });
  }
  const savings = sizing.filter(sz => sz.kind === "mem" && sz.dir === "down").reduce((a, sz) => a + (sz.from - sz.to), 0);
  const needs = sizing.filter(sz => sz.kind === "mem" && sz.dir === "up").reduce((a, sz) => a + (sz.to - sz.from), 0);
  if (savings && needs) add({ id: "size-balance", level: "info", cat: "leistung", title: "Arbeitsspeicher umverteilen",
    why: `Einige Dienste brauchen zusammen ${bytes(needs)} mehr, andere könnten ${bytes(savings)} abgeben.`,
    todo: "Erst die Einsparungen übernehmen, dann die Erhöhungen – so bleibt der Server im grünen Bereich." });
  if (guests.some(g => g.status === "running") && !sizing.length) add({ id: "size-ok", level: "ok", cat: "leistung", title: "Alle laufenden Dienste sind passend dimensioniert" });

  // ---------- Gesperrte Maschinen ----------
  const locked = guests.filter(g => g.lock);
  if (locked.length) add({ id: `locked-${locked.map(g => g.vmid + g.lock).join("-")}`, level: "warn", cat: "system",
    title: `${locked.length} Maschine${locked.length === 1 ? " ist" : "n sind"} gesperrt`,
    why: locked.map(g => `${g.name}: ${LOCK_TEXT[g.lock] || g.lock}`).join(" · ") + ". Gesperrte Maschinen lassen sich nicht starten, ändern oder sichern.",
    todo: "Läuft keine Aufgabe mehr für die Maschine, ist die Sperre ein Überbleibsel (z. B. von einer abgebrochenen Sicherung) und kann entfernt werden.",
    guests: locked, actions: admin ? locked.map(g => ({ label: `${g.name} entsperren`, run: () => new Promise(res => unlockFlow(g.type, g.vmid, g.name, g.lock, res).then(() => setTimeout(res, 300))) })) : [] });

  // ---------- Speicher ----------
  const root = nodeStatus?.rootfs;
  if (root?.total) {
    const p = pct(root.used, root.total);
    if (p > 90) add({ id: "disk-root", level: "bad", cat: "speicher", title: `System-Festplatte ist zu ${Math.round(p)} % voll`,
      why: "Bei voller Festplatte funktionieren Updates, Sicherungen und teils Proxmox selbst nicht mehr.",
      todo: "Lösche alte Sicherungen und ISO-Dateien und prüfe unter „Speicher & NAS“, ob eine App auf die System-Festplatte schreibt.",
      actions: [{ label: "Sicherungen aufräumen", href: "#/backups" }, { label: "Speicher prüfen", href: "#/storage" }] });
    else if (p > 80) add({ id: "disk-root", level: "warn", cat: "speicher", title: `System-Festplatte ist zu ${Math.round(p)} % voll`,
      why: "Es wird langsam eng.", todo: "Räume alte Sicherungen und ISO-Dateien auf.", actions: [{ label: "Sicherungen", href: "#/backups" }] });
    else add({ id: "disk-root-ok", level: "ok", cat: "speicher", title: `System-Festplatte hat genug Platz (${bytes(root.total - root.used)} frei)` });
  }
  for (const s of nodeStores || []) {
    if (!s.enabled && s.enabled !== undefined) continue;
    if (s.active === 0) {
      add({ id: `store-off-${s.storage}`, level: "bad", cat: "speicher", title: `Speicher „${s.storage}“ ist nicht erreichbar`,
        why: "Apps oder Sicherungen, die ihn nutzen, funktionieren gerade nicht.", todo: "Prüfe, ob die NAS eingeschaltet ist und die Zugangsdaten noch stimmen.",
        actions: [{ label: "Speicher & NAS", href: "#/storage" }] });
    } else if (s.total && pct(s.used, s.total) > 90 && s.storage !== "local") {
      add({ id: `store-full-${s.storage}`, level: "warn", cat: "speicher", title: `Speicher „${s.storage}“ ist fast voll (${Math.round(pct(s.used, s.total))} %)`,
        why: "Läuft er voll, können Maschinen hängen bleiben oder Sicherungen fehlschlagen.", todo: "Schaffe Platz oder vergrößere den Speicher." });
    }
  }
  for (const d of disks || []) {
    if (String(d.health || "").toUpperCase() === "FAILED") add({ id: `disk-fail-${d.devpath}`, level: "bad", cat: "speicher",
      title: `Festplatte ${d.model || d.devpath} meldet einen Defekt`, why: "Die SMART-Werte der Festplatte zeigen einen Fehler. Sie kann jederzeit ausfallen.",
      todo: "Sichere sofort alles und tausche die Festplatte aus." });
  }
  for (const z of zfs || []) {
    if (z.health && z.health !== "ONLINE") add({ id: `zfs-${z.name}`, level: "bad", cat: "speicher", title: `ZFS-Pool „${z.name}“ ist ${z.health}`,
      why: "Mindestens eine Festplatte im Pool hat ein Problem.", todo: "Prüfe die Festplatten und ersetze die defekte." });
  }

  // ---------- System ----------
  if (updates) {
    if (updates.length) {
      const kernel = updates.some(u => /^(proxmox-kernel|pve-kernel)/.test(u.Package));
      add({ id: "updates", level: updates.length > 20 ? "bad" : "warn", cat: "sicherheit", title: `${updates.length} Update${updates.length === 1 ? "" : "s"} nicht installiert`,
        why: "Updates schließen Sicherheitslücken und beheben Fehler.", todo: `Installiere die Updates – deine Maschinen laufen dabei weiter.${kernel ? " Danach ist ein Neustart nötig." : ""}`,
        actions: [{ label: "Updates ansehen", href: "#/updates" }] });
    } else add({ id: "updates-ok", level: "ok", cat: "sicherheit", title: "Proxmox ist auf dem neuesten Stand" });
  }
  if (host?.kernel?.reboot_needed) add({ id: `reboot-${host.kernel.latest}`, level: "warn", cat: "sicherheit", title: "Neustart für neuen Kernel ausstehend",
    why: `Installiert ist ${host.kernel.latest}, es läuft aber noch ${host.kernel.running}. Sicherheitsfixes im Kernel wirken erst nach einem Neustart.`,
    todo: "Starte den Server zu einer ruhigen Zeit neu.", actions: [{ label: "Zum Neustart", href: "#/updates" }] });

  if (repos) {
    const subActive = String(sub?.status || "").toLowerCase() === "active";
    const enterprise = [];
    for (const f of repos.files || []) (f.repositories || []).forEach((r, i) => {
      if (r.Enabled && (r.URIs || []).some(u => /enterprise\.proxmox\.com/.test(u))) enterprise.push({ path: f.path, index: i });
    });
    const std = repos["standard-repos"] || [];
    const noSub = std.find(r => r.handle === "no-subscription");
    if (!subActive && enterprise.length) {
      add({ id: "repo-enterprise", level: "bad", cat: "sicherheit", title: "Updates kommen nicht an (Enterprise-Paketquelle ohne Abo)",
        why: "Die Enterprise-Paketquelle funktioniert nur mit einem bezahlten Abo. Ohne Abo schlägt die Update-Suche fehl – du bekommst keine Sicherheitsupdates.",
        todo: "Enterprise-Quelle abschalten und die kostenlose „No-Subscription“-Quelle aktivieren. Für Heim-Server ist das der übliche Weg.",
        actions: admin ? [{ label: "Jetzt umstellen", confirm: "Die Enterprise-Paketquellen werden deaktiviert und die kostenlose No-Subscription-Quelle wird hinzugefügt.", run: async () => {
          let cur = repos;
          for (const e of enterprise) {
            await pve("POST", nodePath("/apt/repositories"), { path: e.path, index: e.index, enabled: 0, digest: cur.digest });
            cur = await pve("GET", nodePath("/apt/repositories"));
          }
          const ns = (cur["standard-repos"] || []).find(r => r.handle === "no-subscription");
          if (!ns || ns.status !== 1) await pve("PUT", nodePath("/apt/repositories"), { handle: "no-subscription", digest: cur.digest });
          const upid = await pve("POST", nodePath("/apt/update"));
          toast("Paketquellen umgestellt", "Proxmox sucht jetzt nach Updates.");
          return upid;
        } }] : [] });
    } else if (!subActive && noSub && noSub.status !== 1 && !enterprise.length) {
      add({ id: "repo-none", level: "warn", cat: "sicherheit", title: "Keine Proxmox-Paketquelle aktiv",
        why: "Ohne Paketquelle bekommt Proxmox selbst keine Updates.", todo: "Aktiviere die kostenlose No-Subscription-Quelle.",
        actions: admin ? [{ label: "Aktivieren", run: async () => { await pve("PUT", nodePath("/apt/repositories"), { handle: "no-subscription", digest: repos.digest }); toast("Paketquelle aktiviert"); } }] : [] });
    } else add({ id: "repo-ok", level: "ok", cat: "sicherheit", title: "Paketquellen sind richtig eingerichtet" });
  }

  const memP = pct(nodeRes.mem, nodeRes.maxmem);
  const assigned = guests.filter(g => g.status === "running").reduce((a, g) => a + (g.maxmem || 0), 0);
  if (memP > 90) add({ id: "mem-high", level: "warn", cat: "system", title: `Arbeitsspeicher ist zu ${Math.round(memP)} % belegt`,
    why: "Wird der Speicher knapp, beendet Linux Programme oder der Server wird sehr langsam.", todo: "Gib Maschinen weniger RAM oder schalte ungenutzte aus." });
  else if (nodeRes.maxmem && assigned > nodeRes.maxmem * 1.1) add({ id: "mem-over", level: "info", cat: "system", title: "Mehr Arbeitsspeicher vergeben als vorhanden",
    why: `Laufende Maschinen dürfen zusammen ${bytes(assigned)} nutzen, der Server hat ${bytes(nodeRes.maxmem)}. Das geht gut, solange nicht alle gleichzeitig viel brauchen.`,
    todo: "Behalte die Auslastung im Blick." });

  const noBoot = guests.filter(g => g.status === "running" && configs.get(g.vmid) && !(configs.get(g.vmid).onboot === 1 || configs.get(g.vmid).onboot === "1"));
  if (noBoot.length) add({ id: `onboot-${noBoot.map(g => g.vmid).join("-")}`, level: "warn", cat: "system",
    title: `${noBoot.length} laufende Maschine${noBoot.length === 1 ? " startet" : "n starten"} nach einem Neustart nicht automatisch`,
    why: `Nach einem Stromausfall oder Update-Neustart bleiben aus: ${noBoot.map(g => g.name).join(", ")}.`,
    todo: "Autostart einschalten.", guests: noBoot,
    actions: [{ label: "Autostart für alle einschalten", run: async () => { for (const g of noBoot) await pve("PUT", nodePath(`/${g.type}/${g.vmid}/config`), { onboot: 1 }); toast("Autostart eingeschaltet"); } }] });

  const noAgent = guests.filter(g => g.type === "qemu" && configs.get(g.vmid) && !/^1|enabled=1/.test(String(configs.get(g.vmid).agent || "")));
  if (noAgent.length) add({ id: `agent-${noAgent.map(g => g.vmid).join("-")}`, level: "info", cat: "system", title: "QEMU-Gast-Agent ist bei VMs aus",
    why: `Betrifft: ${noAgent.map(g => g.name).join(", ")}. Ohne Agent sieht Proxmox die IP-Adresse nicht, kann VMs schlechter sauber herunterfahren und Sicherungen sind weniger konsistent.`,
    todo: "Agent einschalten und in der VM das Paket installieren (Linux: „qemu-guest-agent“, Windows: VirtIO-Treiber). Wirkt nach dem nächsten Neustart der VM.",
    guests: noAgent, actions: [{ label: "Agent einschalten", run: async () => { for (const g of noAgent) await pve("PUT", nodePath(`/qemu/${g.vmid}/config`), { agent: "enabled=1" }); toast("Agent eingeschaltet", "Jetzt noch in der VM installieren und die VM neu starten."); } }] });

  // ---------- Sicherheit ----------
  if (Array.isArray(tfa)) {
    const enabled = tfa.filter(t => t.enable !== false && t.enable !== 0);
    if (!enabled.length) add({ id: "tfa", level: "warn", cat: "sicherheit", title: `Zwei-Faktor-Anmeldung für ${state.user.username} ist aus`,
      why: "Wer dein Passwort errät oder abfängt, hat sonst sofort volle Kontrolle über alle Maschinen.",
      todo: "In Proxmox unter Rechenzentrum → Berechtigungen → Zwei-Faktor eine Authenticator-App (TOTP) hinzufügen. Diese Oberfläche fragt den Code danach automatisch ab.",
      actions: [{ label: "Proxmox öffnen", external: `https://${location.hostname}:8006/` }] });
    else add({ id: "tfa-ok", level: "ok", cat: "sicherheit", title: "Zwei-Faktor-Anmeldung ist aktiv" });
  }
  const privileged = guests.filter(g => g.type === "lxc" && configs.get(g.vmid) && !(configs.get(g.vmid).unprivileged === 1 || configs.get(g.vmid).unprivileged === "1"));
  if (privileged.length) add({ id: `priv-${privileged.map(g => g.vmid).join("-")}`, level: "warn", cat: "sicherheit", title: `${privileged.length} privilegierte${privileged.length === 1 ? "r Container" : " Container"}`,
    why: `Betrifft: ${privileged.map(g => g.name).join(", ")}. Wird eine App darin gehackt, kann der Angreifer leichter auf den ganzen Server durchgreifen.`,
    todo: "Neue Container immer unprivilegiert anlegen (Standard in dieser Oberfläche). Bestehende lassen sich per Sicherung und Wiederherstellung umstellen – das ist aber Handarbeit, nur bei Internet-erreichbaren Apps wirklich wichtig.",
    guests: privileged });
  if (certs) {
    const c = certs.find(x => x.filename === "pveproxy-ssl.pem") || certs.find(x => x.filename === "pve-ssl.pem");
    if (c?.notafter) {
      const days = Math.floor((c.notafter * 1000 - Date.now()) / 86400000);
      if (days < 14) add({ id: "cert", level: days < 0 ? "bad" : "warn", cat: "sicherheit", title: days < 0 ? "HTTPS-Zertifikat ist abgelaufen" : `HTTPS-Zertifikat läuft in ${days} Tagen ab`,
        why: "Browser zeigen dann Warnungen, automatische Verbindungen können fehlschlagen.", todo: "In Proxmox unter Server → Zertifikate erneuern (z. B. „pvecm updatecerts --force“ für das Standardzertifikat)." });
    }
  }
  if (fw && !fw.enable) add({ id: "firewall", level: "info", cat: "sicherheit", title: "Proxmox-Firewall ist ausgeschaltet",
    why: "Im Heimnetz hinter einem Router ist das üblich. Wichtig wird sie, wenn der Server aus dem Internet erreichbar ist.",
    todo: "Leite niemals Port 8006 oder 8443 im Router ins Internet weiter. Für Zugriff von unterwegs besser ein VPN wie WireGuard oder Tailscale nutzen. Die Firewall nur einschalten, wenn du weißt, welche Regeln nötig sind – sonst sperrst du dich aus." });
  if (host) {
    if (host.bpui.public_nets.length) add({ id: "bpui-public", level: "bad", cat: "sicherheit", title: "Diese Oberfläche ist für öffentliche Netze freigegeben",
      why: `In /etc/better-proxmox-ui.env stehen öffentliche Netze: ${host.bpui.public_nets.join(", ")}. Damit wäre die Oberfläche womöglich aus dem Internet erreichbar.`,
      todo: "BPUI_ALLOW_NETS auf private Netze oder dein VPN-Netz beschränken und den Dienst neu starten." });
    if (host.ssh.installed && host.ssh.permit_root_login === "yes" && host.ssh.password_auth !== "no") {
      add({ id: "ssh-root-pw", level: host.fail2ban ? "info" : "warn", cat: "sicherheit", title: "SSH erlaubt root-Anmeldung mit Passwort",
        why: "Ist SSH aus dem Internet erreichbar, probieren Angreifer automatisiert Passwörter durch.",
        todo: `Ein langes, einzigartiges root-Passwort verwenden und SSH nie ins Internet freigeben.${host.fail2ban ? "" : " Optional fail2ban installieren, das wiederholte Fehlversuche sperrt."} Für Fortgeschrittene: Anmeldung per SSH-Schlüssel und PasswordAuthentication no.` });
    }
  }
  add({ id: "tip-passwords", level: "info", cat: "sicherheit", title: "Starke, einzigartige Passwörter",
    why: "Proxmox, NAS und Apps sollten jeweils ein eigenes Passwort haben – wird eins bekannt, bleiben die anderen sicher.",
    todo: "Einen Passwort-Manager nutzen – z. B. Vaultwarden, den du über „Apps“ selbst hosten kannst.", actions: [{ label: "Vaultwarden ansehen", href: "#/apps" }] });

  items.sort((a, b) => LEVELS[a.level].order - LEVELS[b.level].order);
  cache = { time: Date.now(), items };
  return items;
}

export function openIssues(items) {
  const dis = dismissed();
  return items.filter(i => (i.level === "bad" || i.level === "warn") && !dis.has(i.id));
}

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------
export async function renderAdvice({ page, el, go }) {
  const refresh = h("button", { class: "btn" }, icon("refresh", "sm"), "Neu prüfen");
  el.append(pageHead("Empfehlungen", "Was du tun solltest, damit dein Server sicher läuft und deine Daten geschützt sind.", [refresh]));
  const body = h("div", null, h("div", { class: "card" }, h("div", { class: "row" }, icon("spinner", "spin"), "Prüfe deinen Server …")));
  el.append(body);

  async function load(force) {
    let items;
    try { items = await runChecks({ force }); } catch (e) { clear(body).append(callout("bad", "Prüfung fehlgeschlagen", e.message)); return; }
    draw(items);
  }
  refresh.addEventListener("click", () => withBusy(refresh, () => load(true)));

  function draw(items) {
    clear(body);
    const dis = dismissed();
    const visible = items.filter(i => !dis.has(i.id));
    const hidden = items.filter(i => dis.has(i.id));
    const bad = visible.filter(i => i.level === "bad").length;
    const warn = visible.filter(i => i.level === "warn").length;
    const ok = visible.filter(i => i.level === "ok").length;
    const score = Math.max(0, Math.min(100, 100 - bad * 20 - warn * 7));

    // Kopf mit Bewertung
    const c = score >= 85 ? "var(--ok)" : score >= 60 ? "var(--warn)" : "var(--bad)";
    body.append(h("div", { class: "card", style: { marginBottom: "18px" } }, h("div", { class: "row wrap", style: { gap: "18px" } },
      h("div", { class: "ring", style: { "--p": score, "--c": c, width: "84px", height: "84px" } }, h("span", { style: { fontSize: "20px" } }, score)),
      h("div", { style: { flex: 1, minWidth: "200px" } },
        h("h3", { style: { fontSize: "18px" } }, bad ? "Bitte kümmere dich um die dringenden Punkte" : warn ? "Gut – mit ein paar Verbesserungen" : "Sehr gut – alles im grünen Bereich"),
        h("div", { class: "row wrap", style: { gap: "8px", marginTop: "8px" } },
          bad ? h("span", { class: "badge bad" }, `${bad} dringend`) : null,
          warn ? h("span", { class: "badge warn" }, `${warn} empfohlen`) : null,
          h("span", { class: "badge ok" }, `${ok} in Ordnung`))))));

    for (const lvl of ["bad", "warn", "info"]) {
      const list = visible.filter(i => i.level === lvl);
      if (!list.length) continue;
      body.append(h("h2", { class: "section" }, LEVELS[lvl].label, h("span", { class: "muted" }, String(list.length))),
        h("div", { class: "stack" }, list.map(i => adviceCard(i, () => load(true), go))));
    }
    const oks = visible.filter(i => i.level === "ok");
    if (oks.length) body.append(h("h2", { class: "section" }, LEVELS.ok.label),
      h("div", { class: "card pad-0" }, h("div", { class: "list" }, oks.map(i => h("div", { class: "list-item", style: { minHeight: "52px" } },
        h("span", { style: { color: "var(--ok)", display: "flex" } }, icon("checkCircle")), h("div", { class: "grow" }, h("div", { class: "title", style: { whiteSpace: "normal" } }, i.title)))))));
    if (hidden.length) body.append(h("details", { class: "card", style: { marginTop: "18px" } },
      h("summary", { style: { cursor: "pointer", fontWeight: 620 } }, `${hidden.length} ausgeblendete Empfehlung${hidden.length === 1 ? "" : "en"}`),
      h("div", { class: "list", style: { marginTop: "10px" } }, hidden.map(i => h("div", { class: "list-item", style: { padding: "10px 0", minHeight: 0 } },
        h("div", { class: "grow title", style: { fontWeight: 560, whiteSpace: "normal" } }, i.title),
        h("button", { class: "btn sm", onclick: () => { const d = dismissed(); d.delete(i.id); setDismissed(d); draw(items); } }, "Wieder anzeigen"))))));
    body.append(h("p", { class: "muted small", style: { marginTop: "20px" } }, "Die Prüfung läuft nur auf deinem Server – es werden keine Daten nach außen geschickt."));
  }
  await load(false);
  page.on("bpui:refresh", () => {});
}

function adviceCard(i, reload, go) {
  const L = LEVELS[i.level];
  const card = h("div", { class: "card", style: { borderLeft: `4px solid var(--${L.cls === "info" ? "info" : L.cls})` } });
  const actions = h("div", { class: "row wrap", style: { gap: "8px", marginTop: "14px" } });
  for (const a of i.actions || []) {
    if (a.href) actions.append(h("a", { class: "btn sm", href: a.href }, a.label, icon("chevronRight", "sm")));
    else if (a.external) actions.append(h("a", { class: "btn sm", href: a.external, target: "_blank", rel: "noopener" }, a.label, icon("external", "sm")));
    else if (a.run) {
      const b = h("button", { class: "btn sm primary" }, icon("check", "sm"), a.label);
      b.addEventListener("click", async () => {
        if (a.confirm && !await confirmDialog({ title: a.label, text: a.confirm, confirmText: "Ausführen" })) return;
        await withBusy(b, async () => { try { await a.run(); setTimeout(reload, 800); } catch (e) { errorToast(e); } });
      });
      actions.append(b);
    }
  }
  if (i.level !== "bad") actions.append(h("button", { class: "btn sm ghost", title: "Diese Empfehlung nicht mehr anzeigen", onclick: () => {
    const d = dismissed(); d.add(i.id); setDismissed(d); reload();
  } }, "Ausblenden"));

  card.append(
    h("div", { class: "row", style: { gap: "10px", alignItems: "flex-start" } },
      h("span", { style: { color: `var(--${L.cls})`, display: "flex", marginTop: "1px" } }, icon(L.ico)),
      h("div", { style: { flex: 1, minWidth: 0 } },
        h("div", { class: "row wrap", style: { gap: "8px" } }, h("strong", { style: { fontSize: "15.5px" } }, i.title), h("span", { class: "badge" }, CATS[i.cat] || "")),
        i.why ? h("p", { style: { margin: "6px 0 0", color: "var(--text-2)" } }, h("strong", null, "Warum? "), i.why) : null,
        i.todo ? h("p", { style: { margin: "6px 0 0", color: "var(--text-2)" } }, h("strong", null, "Was tun? "), i.todo) : null,
        i.guests?.length ? h("div", { class: "row wrap", style: { gap: "6px", marginTop: "10px" } }, i.guests.slice(0, 8).map(g =>
          h("button", { class: "chip", style: { display: "inline-flex", alignItems: "center", gap: "6px", padding: "4px 10px 4px 4px" }, onclick: () => go(`guest/${g.type}/${g.vmid}`) },
            h("span", { style: { transform: "scale(.62)", margin: "-8px -6px", display: "inline-flex" } }, guestIcon(g.type, g.status, g.name)), g.name))) : null,
        (i.actions?.length || i.level !== "bad") ? actions : null)));
  return card;
}
