// ===========================================================================
// Speicher & NAS: Wer greift worauf zu? + Assistenten für Freigaben
// ===========================================================================
import {
  h, icon, clear, api, pve, state, bytes, pct, meter, nodePath, enc, toast, errorToast, trackTask, openSheet, confirmDialog,
  field, input, select, toggle, segmented, withBusy, pageHead, callout, loader, empty, detectApp, appAvatar, guestIcon,
} from "../core.js";

const NET_TYPES = new Set(["cifs", "nfs", "pbs", "cephfs", "glusterfs"]);
const TYPE_LABEL = { cifs: "SMB", nfs: "NFS", pbs: "Backup-Server", cephfs: "CephFS", glusterfs: "GlusterFS", "fuse.sshfs": "SSHFS", smb3: "SMB", nfs4: "NFS" };
const COLORS = ["#ff7a45", "#6f9bff", "#34c784", "#c77dff", "#e8b23a", "#2ec4c4", "#ff5c8a"];

// App-spezifische Tipps, wo ein geteilter Ordner eingetragen wird
const APP_TIPS = {
  "immich": { path: "/mnt/nas", tip: "In Immich unter Administration → Externe Bibliotheken diesen Pfad eintragen. So erscheinen die Fotos der NAS in Immich." },
  "paperless-ngx": { path: "/mnt/nas", tip: "Als Eingangsordner: In der Paperless-Konfiguration PAPERLESS_CONSUMPTION_DIR auf diesen Pfad setzen. Alles, was auf der NAS in den Ordner gelegt wird, landet dann automatisch in Paperless." },
  "jellyfin": { path: "/mnt/medien", tip: "In Jellyfin unter Dashboard → Bibliotheken → Ordner hinzufügen diesen Pfad wählen." },
  "plex": { path: "/mnt/medien", tip: "In Plex unter Einstellungen → Bibliotheken diesen Ordner hinzufügen." },
  "nextcloud": { path: "/mnt/nas", tip: "In Nextcloud die App „External storage“ aktivieren und den Pfad als lokalen Speicher hinzufügen." },
  "nextcloudpi": { path: "/mnt/nas", tip: "In Nextcloud die App „External storage“ aktivieren und den Pfad als lokalen Speicher hinzufügen." },
  "syncthing": { path: "/mnt/nas", tip: "In Syncthing einen neuen Ordner mit diesem Pfad anlegen." },
  "audiobookshelf": { path: "/mnt/hoerbuecher", tip: "In Audiobookshelf beim Anlegen der Bibliothek diesen Ordner auswählen." },
  "navidrome": { path: "/mnt/musik", tip: "Den Musikordner in der Navidrome-Konfiguration (MusicFolder) auf diesen Pfad setzen." },
  "frigate": { path: "/mnt/aufnahmen", tip: "In der Frigate-Konfiguration den Aufnahme-Speicher auf diesen Pfad legen." },
};

// ---------------------------------------------------------------------------
// Daten zusammenführen
// ---------------------------------------------------------------------------
function parseConfigValue(v) {
  const parts = String(v).split(",");
  const out = { src: parts[0] };
  for (const p of parts.slice(1)) { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i)] = p.slice(i + 1); }
  return out;
}

function shareLabel(src, type) {
  if (!src) return "";
  if (type === "cifs" || src.startsWith("//")) return src.replace(/^\/\//, "\\\\").replace(/\//g, "\\");
  return src;
}

async function loadModel() {
  const admin = state.user.host_admin;
  const [cfgR, nodeR, resR, jobsR, hostR] = await Promise.allSettled([
    pve("GET", "/storage"),
    pve("GET", nodePath("/storage")),
    pve("GET", "/cluster/resources", { type: "vm" }),
    pve("GET", "/cluster/backup"),
    admin ? api("/host/mounts") : Promise.resolve(null),
  ]);
  if (cfgR.status === "rejected") throw cfgR.reason;
  const cfg = cfgR.value || [];
  const nodeSt = new Map((nodeR.value || []).map(s => [s.storage, s]));
  const guests = (resR.value || []).filter(g => g.node === state.node && !g.template).sort((a, b) => a.vmid - b.vmid);
  const jobs = jobsR.value || [];
  const host = hostR.value?.data || null;

  const sources = [];
  const byId = new Map();
  const addSource = (s) => { s.color = COLORS[sources.length % COLORS.length]; sources.push(s); byId.set(s.id, s); return s; };

  // Netzwerk-Speicher, die in Proxmox eingerichtet sind
  for (const s of cfg) {
    if (!NET_TYPES.has(s.type)) continue;
    if (s.nodes && !String(s.nodes).split(",").includes(state.node)) continue;
    const st = nodeSt.get(s.storage);
    const path = s.type === "pbs" ? null : (s.path || `/mnt/pve/${s.storage}`);
    const mount = host?.mounts?.find(m => m.target === path);
    addSource({
      id: `pve:${s.storage}`, kind: "pve", storage: s.storage, type: s.type, title: s.storage,
      server: s.server, share: s.type === "cifs" ? `//${s.server}/${s.share}` : s.type === "nfs" ? `${s.server}:${s.export}` : s.server,
      path, content: (s.content || "").split(",").filter(Boolean), disabled: !!s.disable,
      active: !s.disable && st ? st.active !== 0 : false, stale: !!mount?.stale,
      usage: st?.total ? { used: st.used, total: st.total } : (mount?.usage || null),
      unprivWritable: /uid=100000/.test(s.options || ""),
    });
  }
  // Von Hand eingebundene Netzlaufwerke (z. B. über /etc/fstab)
  if (host) {
    for (const m of host.mounts.filter(m => m.network && !m.target.startsWith("/mnt/pve/"))) {
      addSource({ id: `mount:${m.target}`, kind: "mount", type: m.fstype, title: m.target.split("/").pop() || m.target, share: m.source,
        path: m.target, active: !m.stale, stale: !!m.stale, usage: m.usage, content: [], manual: true });
    }
    for (const f of host.fstab.filter(f => !f.mounted && !byId.has(`mount:${f.target}`))) {
      addSource({ id: `mount:${f.target}`, kind: "mount", type: f.fstype, title: f.target.split("/").pop() || f.target, share: f.source,
        path: f.target, active: false, usage: null, content: [], manual: true, notMounted: true });
    }
  }

  const pathSources = sources.filter(s => s.path).sort((a, b) => b.path.length - a.path.length);
  const findByPath = (p) => pathSources.find(s => p === s.path || p.startsWith(s.path + "/"));
  let local = null;
  const getLocal = () => local || (local = addSource({ id: "local", kind: "local", type: "local", title: "System-Festplatte", share: state.node,
    path: "/", active: true, usage: host?.root || null, content: [] }));

  const links = [];
  const problems = [];

  // Container: Einhängepunkte (Bind-Mounts und Laufwerke auf Netzwerkspeicher)
  const lxcs = guests.filter(g => g.type === "lxc");
  const qemus = guests.filter(g => g.type === "qemu");
  const configs = new Map();
  await Promise.all(guests.map(async g => {
    try { configs.set(g.vmid, await pve("GET", nodePath(`/${g.type}/${g.vmid}/config`))); } catch { /* keine Rechte */ }
  }));

  for (const g of lxcs) {
    const conf = configs.get(g.vmid);
    if (!conf) continue;
    for (const [key, val] of Object.entries(conf)) {
      if (!/^mp\d+$/.test(key)) continue;
      const v = parseConfigValue(val);
      const target = v.mp || "?";
      const ro = v.ro === "1";
      if (v.src.startsWith("/")) {
        let src = findByPath(v.src);
        if (!src) {
          src = getLocal();
          if (host && /^\/(mnt|media)\//.test(v.src)) {
            problems.push({ level: "warn", title: `„${g.name}“ schreibt auf die System-Festplatte`,
              text: `Der Ordner ${v.src} ist mit keiner NAS verbunden. Daten, die ${g.name} dort speichert, landen auf der System-Festplatte und können sie volllaufen lassen.` });
          }
        }
        links.push({ source: src, guest: g, conf, key, label: target, hostPath: v.src, ro, kind: "bind" });
      } else {
        const sid = v.src.split(":")[0];
        const src = byId.get(`pve:${sid}`);
        if (src) links.push({ source: src, guest: g, conf, key, label: target, ro, kind: "volume" });
      }
    }
  }
  // VMs: Festplatten auf Netzwerkspeicher
  for (const g of qemus) {
    const conf = configs.get(g.vmid);
    if (!conf) continue;
    for (const [key, val] of Object.entries(conf)) {
      if (!/^(scsi|virtio|sata|ide|efidisk|tpmstate)\d+$/.test(key) || /media=cdrom/.test(val)) continue;
      const src = byId.get(`pve:${String(val).split(":")[0]}`);
      if (src) links.push({ source: src, guest: g, conf, key, label: `Festplatte ${key}`, kind: "volume" });
    }
  }
  // Sicherungs-Zeitpläne
  for (const j of jobs) {
    const src = byId.get(`pve:${j.storage}`);
    if (src) links.push({ source: src, job: j, label: j.schedule || "", kind: "backup" });
  }

  // Probleme
  for (const s of sources) {
    if (s.kind === "local") continue;
    const users = links.filter(l => l.source === s && l.guest).map(l => l.guest.name);
    const uniq = [...new Set(users)];
    if (s.disabled) continue;
    if (s.notMounted) problems.unshift({ level: "bad", title: `Laufwerk ${s.path} ist nicht eingebunden`, text: `Es steht in /etc/fstab, ist aber gerade nicht verbunden.${uniq.length ? ` Betroffen: ${uniq.join(", ")}.` : ""}` });
    else if (s.stale) problems.unshift({ level: "bad", title: `NAS-Freigabe „${s.title}“ antwortet nicht`, text: `Die Verbindung hängt. Prüfe, ob die NAS eingeschaltet und im Netz erreichbar ist.${uniq.length ? ` Betroffen: ${uniq.join(", ")}.` : ""}` });
    else if (!s.active) problems.unshift({ level: "bad", title: `NAS-Freigabe „${s.title}“ ist nicht erreichbar`, text: `Prüfe, ob die NAS eingeschaltet ist und Benutzername/Passwort noch stimmen.${uniq.length ? ` Apps, die darauf zugreifen (${uniq.join(", ")}), sehen gerade keine Daten.` : ""}` });
  }
  const rootP = host?.root ? pct(host.root.used, host.root.total) : null;
  const localBackups = jobs.filter(j => !byId.has(`pve:${j.storage}`) && /^local/.test(j.storage) && j.storage !== "local-zfs");
  if (rootP !== null && rootP > 85) {
    problems.unshift({ level: "bad", title: `System-Festplatte ist zu ${Math.round(rootP)} % voll`,
      text: localBackups.length ? "Deine Sicherungen werden auf der System-Festplatte gespeichert. Stell sie auf die NAS um und lösche alte Sicherungen." : "Lösche alte Sicherungen oder ISO-Dateien, damit Proxmox weiter funktioniert.",
      action: localBackups.length && sources.some(s => s.kind === "pve" && s.content.includes("backup") && s.active) ? { label: "Sicherungen auf NAS umstellen", fn: "moveBackups" } : { label: "Zu den Sicherungen", href: "#/backups" } });
  } else if (localBackups.length && sources.some(s => s.kind === "pve" && s.content.includes("backup") && s.active)) {
    problems.push({ level: "info", title: "Sicherungen liegen auf dem Server selbst", text: "Wenn der Server kaputtgeht, sind auch die Sicherungen weg. Besser auf der NAS speichern.",
      action: { label: "Sicherungen auf NAS umstellen", fn: "moveBackups" } });
  }

  return { sources, links, problems, guests, configs, jobs, host, admin, localBackups };
}

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------
export async function renderStorage({ page, el, go }) {
  const connectBtn = h("button", { class: "btn primary" }, icon("plus", "sm"), "NAS-Freigabe verbinden");
  const shareBtn = h("button", { class: "btn" }, icon("network", "sm"), "Ordner mit App teilen");
  el.append(pageHead("Speicher & NAS", "Wo deine Daten liegen – und welche App worauf zugreift.", [connectBtn, shareBtn]));
  const body = h("div", null, loader());
  el.append(body);
  let model = null;

  async function reload() {
    try { model = await loadModel(); draw(); }
    catch (e) { clear(body).append(callout("bad", "Laden fehlgeschlagen", e.message)); }
  }
  connectBtn.addEventListener("click", () => connectShareSheet(reload, () => model && shareFolderSheet(model, null, reload)));
  shareBtn.addEventListener("click", () => model && shareFolderSheet(model, null, reload));

  function draw() {
    clear(body);
    if (!model.admin) body.append(h("div", { style: { marginBottom: "16px" } }, callout("warn", "Eingeschränkte Ansicht", "Ordner einbinden und von Hand verbundene Laufwerke sehen kann nur root@pam – genau wie in Proxmox.")));

    // Probleme
    if (model.problems.length) {
      body.append(h("div", { class: "stack", style: { marginBottom: "18px" } }, model.problems.map(p => {
        const c = callout(p.level, p.title, p.text);
        if (p.action) {
          const b = p.action.href ? h("a", { class: "btn sm", href: p.action.href }, p.action.label)
            : h("button", { class: "btn sm", onclick: () => moveBackupsSheet(model, reload) }, p.action.label);
          c.querySelector("div").append(h("div", { style: { marginTop: "10px" } }, b));
        }
        return c;
      })));
    }

    const net = model.sources.filter(s => s.kind !== "local");
    if (!net.length && !model.links.length) {
      body.append(h("div", { class: "card" }, empty("network", "Noch keine NAS verbunden",
        "Verbinde eine Freigabe deiner NAS (z. B. Synology, QNAP, FritzBox). Danach kannst du Ordner mit Apps wie Immich oder Paperless teilen – mit ein paar Klicks.",
        h("button", { class: "btn primary", onclick: () => connectBtn.click() }, icon("plus", "sm"), "NAS-Freigabe verbinden"))));
      body.append(explainCard());
      return;
    }

    // Diagramm (nur auf größeren Bildschirmen)
    if (model.links.some(l => l.guest || l.job)) body.append(h("h2", { class: "section hide-sm-block", style: { marginTop: "6px" } }, "Verbindungen"), diagram(model, page, go));

    // Karten je Quelle
    body.append(h("h2", { class: "section" }, "Freigaben & Laufwerke"));
    body.append(h("div", { class: "grid cols-2" }, model.sources.filter(s => s.kind !== "local" || model.links.some(l => l.source === s)).map(s => sourceCard(s, model, reload, go))));
    body.append(explainCard());
  }

  await reload();
  page.on("bpui:refresh", () => { if (model) draw(); });
}

function sourceIcon(s, size = 44) {
  if (s.kind === "local") return h("div", { class: "guest-icon", style: { width: `${size}px`, height: `${size}px` } }, icon("disk"));
  if (s.type === "pbs") return appAvatar("proxmox", "PBS", { size });
  return h("div", { class: "guest-icon", style: { width: `${size}px`, height: `${size}px`, background: `color-mix(in srgb, ${s.color} 16%, transparent)`, color: s.color } }, icon("server"));
}

function statusOf(s) {
  if (s.kind === "local") return h("span", { class: "badge" }, "Lokal");
  if (s.disabled) return h("span", { class: "badge" }, "Deaktiviert");
  if (s.notMounted) return h("span", { class: "badge bad" }, "Nicht eingebunden");
  if (s.stale) return h("span", { class: "badge bad" }, "Hängt");
  return s.active ? h("span", { class: "badge ok" }, "Verbunden") : h("span", { class: "badge bad" }, "Nicht erreichbar");
}

function sourceCard(s, model, reload, go) {
  const links = model.links.filter(l => l.source === s);
  const card = h("div", { class: "card", style: { borderTop: `3px solid ${s.color}` } });
  const uses = [];
  if (s.content.includes("backup")) uses.push("Sicherungen");
  if (s.content.includes("iso")) uses.push("ISO-Dateien");
  if (s.content.includes("images") || s.content.includes("rootdir")) uses.push("Festplatten");

  card.append(
    h("div", { class: "row", style: { gap: "12px", alignItems: "flex-start" } }, sourceIcon(s),
      h("div", { style: { flex: 1, minWidth: 0 } },
        h("div", { class: "row wrap", style: { gap: "6px" } }, h("strong", { style: { fontSize: "16px" } }, s.title), statusOf(s),
          s.kind !== "local" ? h("span", { class: "badge" }, TYPE_LABEL[s.type] || s.type) : null, s.manual ? h("span", { class: "badge" }, "von Hand") : null),
        h("div", { class: "muted small mono", style: { marginTop: "4px", wordBreak: "break-all" } }, shareLabel(s.share, s.type)),
        s.path && s.kind !== "local" ? h("div", { class: "muted small", style: { marginTop: "2px" } }, "Auf dem Server unter ", h("span", { class: "mono" }, s.path)) : null)),
    s.usage?.total ? h("div", { style: { marginTop: "14px" } },
      h("div", { class: "row small muted", style: { marginBottom: "6px" } }, h("span", null, `${bytes(s.usage.used)} belegt`), h("span", { class: "spacer" }), h("span", null, `${bytes(s.usage.total)} gesamt`)),
      meter(pct(s.usage.used, s.usage.total))) : null,
    uses.length ? h("div", { class: "row wrap", style: { gap: "6px", marginTop: "12px" } }, h("span", { class: "muted small" }, "Proxmox nutzt es für:"), uses.map(u => h("span", { class: "badge info" }, u))) : null,
  );

  const list = h("div", { class: "card pad-0 flat", style: { marginTop: "14px" } });
  if (!links.length) list.append(h("div", { class: "muted small", style: { padding: "14px 16px" } }, "Noch von keiner App genutzt."));
  for (const l of links) {
    if (l.job) {
      list.append(h("div", { class: "list-item", style: { minHeight: "56px" } },
        h("div", { class: "guest-icon" }, icon("archive")),
        h("div", { class: "grow" }, h("div", { class: "title" }, "Automatische Sicherung"), h("div", { class: "meta" }, l.job.all ? "Alle Maschinen" : `Maschinen ${l.job.vmid || ""}`)),
        h("a", { class: "btn sm ghost", href: "#/backups" }, icon("chevronRight", "sm"))));
      continue;
    }
    const app = detectApp(l.guest.name);
    const rm = l.kind === "bind" && model.admin ? h("button", { class: "btn sm icon ghost", title: "Verbindung entfernen", onclick: () => removeLink(l, reload) }, icon("x", "sm")) : null;
    list.append(h("div", { class: "list-item", style: { minHeight: "60px" } },
      guestIcon(l.guest.type, l.guest.status, l.guest.name),
      h("div", { class: "grow", style: { cursor: "pointer" }, onclick: () => go(`guest/${l.guest.type}/${l.guest.vmid}`) },
        h("div", { class: "title" }, app?.title && !l.guest.name.toLowerCase().includes(app.title.toLowerCase().split(" ")[0]) ? `${l.guest.name} (${app.title})` : l.guest.name),
        h("div", { class: "meta", style: { whiteSpace: "normal" } }, l.kind === "bind"
          ? h("span", null, l.hostPath !== s.path ? h("span", { class: "mono" }, l.hostPath.slice(s.path === "/" ? 0 : s.path.length) || "/") : "Ganze Freigabe", " → in der App als ", h("span", { class: "mono" }, l.label))
          : l.label)),
      l.ro ? h("span", { class: "badge" }, "nur lesen") : null, rm));
  }
  card.append(list);
  if (s.kind !== "local" && s.path && model.admin) {
    card.append(h("div", { class: "row wrap", style: { marginTop: "12px" } },
      h("button", { class: "btn sm", disabled: !s.active, onclick: () => shareFolderSheet(model, s, reload) }, icon("plus", "sm"), "Ordner mit App teilen"),
      s.kind === "pve" ? h("button", { class: "btn sm ghost", onclick: () => removeStorage(s, links, reload) }, icon("trash", "sm"), "Entfernen") : null));
  }
  return card;
}

function explainCard() {
  const step = (n, t, d) => h("div", { class: "row", style: { alignItems: "flex-start", gap: "12px" } },
    h("div", { class: "avatar", style: { background: "var(--accent-soft)", color: "var(--accent)", width: "30px", height: "30px", fontSize: "13px" } }, n),
    h("div", null, h("strong", null, t), h("div", { class: "muted small" }, d)));
  return h("details", { class: "card", style: { marginTop: "18px" } },
    h("summary", { style: { cursor: "pointer", fontWeight: 650 } }, "So hängt alles zusammen"),
    h("div", { class: "stack", style: { marginTop: "14px", gap: "14px" } },
      step("1", "NAS-Freigabe verbinden", "Proxmox meldet sich bei deiner NAS an und hängt die Freigabe auf dem Server ein (unter /mnt/pve/…)."),
      step("2", "Ordner mit App teilen", "Ein Ordner davon wird an einen Container weitergereicht. Die App sieht ihn wie einen eigenen Ordner, z. B. /mnt/nas."),
      step("3", "In der App eintragen", "Diesen Pfad trägst du einmal in der App ein – etwa in Immich als externe Bibliothek oder in Paperless als Eingangsordner.")));
}

// ---------------------------------------------------------------------------
// Diagramm mit Verbindungslinien
// ---------------------------------------------------------------------------
function svgEl(tag, attrs) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  return e;
}

function diagram(model, page, go) {
  const links = model.links.filter(l => l.guest || l.job);
  const srcs = model.sources.filter(s => links.some(l => l.source === s));
  const targets = [];
  const tIndex = new Map();
  for (const l of links) {
    const id = l.guest ? `g${l.guest.vmid}` : "backup";
    if (!tIndex.has(id)) { tIndex.set(id, { id, guest: l.guest, backup: !!l.job, labels: [] }); targets.push(tIndex.get(id)); }
    const t = tIndex.get(id);
    if (l.guest && l.kind === "bind" && !t.labels.includes(l.label)) t.labels.push(l.label);
  }

  const svg = svgEl("svg", { class: "flow-lines" });
  const left = h("div", { class: "flow-col" }, h("div", { class: "flow-head" }, "Speicher"), srcs.map(s => h("div", { class: "flow-node", "data-id": s.id },
    sourceIcon(s, 36), h("div", { style: { minWidth: 0 } }, h("div", { class: "title" }, s.title),
      h("div", { class: "meta mono" }, s.kind === "local" ? "auf dem Server" : shareLabel(s.share, s.type))),
    h("span", { class: `status-dot ${s.active && !s.stale && !s.notMounted ? "running" : ""}`, style: s.active && !s.stale ? null : { background: "var(--bad)" } }))));
  const right = h("div", { class: "flow-col" }, h("div", { class: "flow-head" }, "Apps & Maschinen"), targets.map(t => h("div", {
    class: "flow-node clickable", "data-id": t.id, onclick: () => (t.guest ? go(`guest/${t.guest.type}/${t.guest.vmid}`) : go("backups")) },
    t.guest ? guestIcon(t.guest.type, t.guest.status, t.guest.name) : h("div", { class: "guest-icon" }, icon("archive")),
    h("div", { style: { minWidth: 0 } }, h("div", { class: "title" }, t.guest ? t.guest.name : "Automatische Sicherung"),
      h("div", { class: "meta mono" }, t.backup ? "Zeitplan" : t.labels.join(", ") || "Festplatte")))));
  const wrap = h("div", { class: "card flow hide-sm-block" }, svg, left, h("div"), right);

  function drawLines() {
    if (!wrap.isConnected) return;
    const box = wrap.getBoundingClientRect();
    svg.setAttribute("width", box.width); svg.setAttribute("height", box.height);
    svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    for (const l of links) {
      const a = wrap.querySelector(`.flow-node[data-id="${CSS.escape(l.source.id)}"]`);
      const b = wrap.querySelector(`.flow-node[data-id="${l.guest ? `g${l.guest.vmid}` : "backup"}"]`);
      if (!a || !b) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const x1 = ra.right - box.left, y1 = ra.top + ra.height / 2 - box.top;
      const x2 = rb.left - box.left, y2 = rb.top + rb.height / 2 - box.top;
      const dx = (x2 - x1) * 0.5;
      const broken = !l.source.active || l.source.stale || l.source.notMounted;
      svg.append(svgEl("path", { d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, fill: "none",
        stroke: broken ? "var(--bad)" : l.source.color, "stroke-width": 2.5, "stroke-linecap": "round", opacity: 0.85,
        "stroke-dasharray": broken || l.kind === "backup" ? "6 6" : "" }));
      svg.append(svgEl("circle", { cx: x1, cy: y1, r: 4, fill: broken ? "var(--bad)" : l.source.color }));
      svg.append(svgEl("circle", { cx: x2, cy: y2, r: 4, fill: broken ? "var(--bad)" : l.source.color }));
    }
  }
  const ro = new ResizeObserver(() => requestAnimationFrame(drawLines));
  ro.observe(wrap);
  page.onLeave(() => ro.disconnect());
  setTimeout(drawLines, 50);
  return wrap;
}

// ---------------------------------------------------------------------------
// Assistent: NAS-Freigabe verbinden
// ---------------------------------------------------------------------------
function connectShareSheet(onDone, openShare) {
  openSheet((sheet, close) => {
    const d = { proto: "cifs", server: "", username: "", password: "", share: "", id: "", forBackup: false, forIso: false, writable: true, manual: false, found: null };
    const content = h("div");
    sheet.append(h("h2", null, "NAS-Freigabe verbinden"), h("p", { class: "sheet-sub" }, "Proxmox meldet sich bei deiner NAS an. Danach kannst du die Ordner für Apps und Sicherungen nutzen."), content);

    function slugFor(share) {
      const base = String(share).split("/").filter(Boolean).pop() || "freigabe";
      return ("nas-" + base.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")).slice(0, 40);
    }

    function step1() {
      clear(content);
      const srv = input({ value: d.server, placeholder: "192.168.1.20", inputmode: "decimal", autocapitalize: "off", oninput: (e) => { d.server = e.target.value.trim(); } });
      const user = input({ value: d.username, placeholder: "Benutzer auf der NAS", autocapitalize: "off", autocomplete: "off", oninput: (e) => { d.username = e.target.value.trim(); } });
      const pass = input({ type: "password", value: d.password, autocomplete: "new-password", oninput: (e) => { d.password = e.target.value; } });
      const creds = h("div", { class: "form-grid" }, field("Benutzername", user), field("Passwort", pass));
      const results = h("div");
      const scanBtn = h("button", { class: "btn primary block" }, icon("search", "sm"), "Freigaben suchen");
      scanBtn.addEventListener("click", () => withBusy(scanBtn, async () => {
        if (!/^[A-Za-z0-9.:-]+$/.test(d.server)) return toast("Bitte die IP-Adresse oder den Namen der NAS eingeben", "", "bad");
        try {
          if (d.proto === "cifs") {
            const list = await pve("GET", nodePath("/scan/cifs"), { server: d.server, username: d.username || undefined, password: d.password || undefined });
            d.found = list.map(x => ({ value: x.share, label: x.share, sub: x.description }));
          } else {
            const list = await pve("GET", nodePath("/scan/nfs"), { server: d.server });
            d.found = list.map(x => ({ value: x.path, label: x.path, sub: x.options }));
          }
          drawResults();
        } catch (e) {
          clear(results).append(callout("bad", "Keine Verbindung zur NAS", `${e.message}. Prüfe IP-Adresse, Benutzername und Passwort${d.proto === "nfs" ? " und ob NFS auf der NAS aktiviert ist" : ""}.`),
            h("button", { class: "btn sm", style: { marginTop: "10px" }, onclick: () => { d.manual = true; drawResults(); } }, "Freigabe von Hand eingeben"));
        }
      }));
      function drawResults() {
        clear(results);
        if (d.manual) {
          results.append(field(d.proto === "cifs" ? "Name der Freigabe" : "Export-Pfad", input({ placeholder: d.proto === "cifs" ? "fotos" : "/volume1/fotos", oninput: (e) => { d.share = e.target.value.trim(); } })),
            h("button", { class: "btn primary block", style: { marginTop: "12px" }, onclick: () => { if (!d.share) return toast("Bitte die Freigabe eingeben", "", "bad"); d.id = slugFor(d.share); step2(); } }, "Weiter"));
          return;
        }
        if (!d.found?.length) { results.append(callout("warn", "Keine Freigaben gefunden", "Hat der Benutzer Zugriff auf mindestens eine Freigabe?")); return; }
        results.append(h("div", { class: "label", style: { margin: "4px 0 8px" } }, "Welche Freigabe?"),
          h("div", { class: "choice-grid" }, d.found.map(f => h("button", { type: "button", class: "choice", onclick: () => { d.share = f.value; d.id = slugFor(f.value); step2(); } },
            h("strong", null, f.label), f.sub ? h("span", null, f.sub) : null))));
      }
      content.append(h("div", { class: "stack", style: { gap: "16px" } },
        field("Art der Freigabe", segmented([{ value: "cifs", label: "SMB (empfohlen)" }, { value: "nfs", label: "NFS" }], d.proto, (v) => { d.proto = v; creds.classList.toggle("hidden", v !== "cifs"); clear(results); }),
          "SMB ist die normale Windows-Dateifreigabe – das können alle NAS (Synology, QNAP, FritzBox, TrueNAS). NFS nur, wenn du es auf der NAS eingerichtet hast."),
        field("Adresse der NAS", srv, "Die IP-Adresse findest du in deinem Router oder in der NAS-Oberfläche."),
        creds, scanBtn, results));
    }

    function step2() {
      clear(content);
      const idIn = input({ value: d.id, autocapitalize: "off", oninput: (e) => { d.id = e.target.value.trim(); } });
      const saveBtn = h("button", { class: "btn primary" }, icon("check", "sm"), "Verbinden");
      content.append(h("div", { class: "stack", style: { gap: "16px" } },
        h("div", { class: "card flat", style: { padding: "12px 14px" } }, h("div", { class: "muted small" }, "Freigabe"),
          h("div", { class: "mono", style: { fontWeight: 600 } }, d.proto === "cifs" ? `\\\\${d.server}\\${d.share}` : `${d.server}:${d.share}`)),
        field("Name in Proxmox", idIn, "Kleinbuchstaben, Zahlen und Bindestriche. Die Freigabe liegt dann auf dem Server unter /mnt/pve/" + (d.id || "name") + "."),
        h("div", null, h("div", { class: "label", style: { marginBottom: "6px" } }, "Wofür soll Proxmox sie nutzen?"),
          toggle("Ordner für Apps", "Z. B. Fotos für Immich oder Dokumente für Paperless. Geht immer.", true, () => {}),
          toggle("Sicherungen hier speichern", "Empfohlen: So belegen Sicherungen nicht die System-Festplatte.", d.forBackup, (v) => { d.forBackup = v; }),
          toggle("ISO-Dateien und Vorlagen", null, d.forIso, (v) => { d.forIso = v; })),
        d.proto === "cifs" ? toggle("Für Container beschreibbar machen (empfohlen)", "Sonst dürfen Apps in Containern meist nur lesen, aber nichts speichern.", d.writable, (v) => { d.writable = v; })
          : callout("info", "Rechte bei NFS", "Damit Apps in Containern schreiben dürfen, stelle in der NFS-Freigabe der NAS „Alle Benutzer zu admin zuordnen“ (Squash) ein."),
        h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: step1 }, "Zurück"), saveBtn)));

      saveBtn.addEventListener("click", () => withBusy(saveBtn, async () => {
        if (!/^[a-z][a-z0-9._-]{1,39}$/.test(d.id)) return toast("Ungültiger Name", "Mit einem Buchstaben beginnen, nur a–z, 0–9, - und _.", "bad");
        const cont = [];
        if (d.forBackup) cont.push("backup");
        if (d.forIso) cont.push("iso", "vztmpl");
        if (!cont.length) cont.push("snippets");
        const body = { storage: d.id, type: d.proto, server: d.server, content: cont.join(",") };
        if (d.proto === "cifs") {
          Object.assign(body, { share: d.share, username: d.username || undefined, password: d.password || undefined });
          if (d.writable) body.options = "uid=100000,gid=100000,file_mode=0777,dir_mode=0777";
        } else body.export = d.share;
        if (d.forBackup) body["prune-backups"] = "keep-last=7";
        try {
          await pve("POST", "/storage", body);
        } catch (e) {
          if (body.options && /options/i.test(e.message)) {
            delete body.options;
            await pve("POST", "/storage", body);
            toast("Hinweis", "Deine Proxmox-Version kann die Schreibrechte für Container nicht automatisch setzen.", "info", { timeout: 8000 });
          } else return errorToast(e, "Verbinden fehlgeschlagen");
        }
        close();
        toast("NAS verbunden", `„${d.id}“ ist jetzt unter /mnt/pve/${d.id} eingebunden.`, "ok", { timeout: 8000, actions: openShare ? [{ label: "Ordner mit App teilen", onClick: () => setTimeout(openShare, 600) }] : [] });
        setTimeout(onDone, 300);
      }));
    }
    step1();
  }, { wide: false });
}

// ---------------------------------------------------------------------------
// Assistent: Ordner mit einer App teilen (Bind-Mount in einen Container)
// ---------------------------------------------------------------------------
function shareFolderSheet(model, presetSource, onDone) {
  if (!model.admin) return toast("Nur für root@pam", "Ordner in Container einbinden darf in Proxmox nur root.", "bad");
  const sources = model.sources.filter(s => s.kind !== "local" && s.path && s.active && !s.stale);
  if (!sources.length) return toast("Keine NAS verbunden", "Verbinde zuerst eine NAS-Freigabe.", "info");
  const lxcs = model.guests.filter(g => g.type === "lxc");
  if (!lxcs.length) return toast("Keine Container vorhanden", "Ordner lassen sich nur mit Containern (LXC) teilen.", "info");

  openSheet((sheet, close) => {
    const d = { guest: null, source: presetSource && sources.includes(presetSource) ? presetSource : sources[0], path: null, target: "", ro: false };
    d.path = d.source.path;
    const content = h("div");
    sheet.append(h("h2", null, "Ordner mit App teilen"), content);

    // Schritt 1: App wählen
    function step1() {
      clear(content);
      content.append(h("p", { class: "sheet-sub" }, "Welche App soll auf die NAS zugreifen?"),
        h("div", { class: "card pad-0 flat" }, h("div", { class: "list" }, lxcs.map(g => {
          const app = detectApp(g.name);
          return h("div", { class: "list-item clickable", onclick: () => { d.guest = g; const tip = APP_TIPS[app?.logo]; d.target = tip?.path || `/mnt/${d.source.title.replace(/^nas-/, "")}`; step2(); } },
            guestIcon("lxc", g.status, g.name),
            h("div", { class: "grow" }, h("div", { class: "title" }, g.name), h("div", { class: "meta" }, app ? `${app.title} · Container #${g.vmid}` : `Container #${g.vmid}`)),
            icon("chevronRight", "sm"));
        }))),
        model.guests.some(g => g.type === "qemu") ? h("p", { class: "muted small", style: { marginTop: "12px" } },
          "VMs sind nicht aufgeführt: Sie verbinden sich selbst mit der NAS – z. B. in Windows als Netzlaufwerk oder in Home Assistant unter Einstellungen → System → Speicher.") : null,
        h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Abbrechen")));
    }

    // Schritt 2: Ordner auf der NAS wählen
    function step2() {
      clear(content);
      const browser = h("div");
      const srcSel = select(sources.map(s => ({ value: s.id, label: `${s.title} (${shareLabel(s.share, s.type)})` })), d.source.id, {
        onchange: (e) => { d.source = sources.find(s => s.id === e.target.value); d.path = d.source.path; browse(); } });
      async function browse() {
        clear(browser).append(loader());
        let res;
        try { res = (await api("/host/ls", { query: { path: d.path } })).data; }
        catch (e) { clear(browser).append(callout("bad", null, e.message)); return; }
        const rel = d.path.slice(d.source.path.length) || "/";
        const newName = input({ placeholder: "Neuer Ordner, z. B. fotos", autocapitalize: "off" });
        const mk = h("button", { class: "btn sm" }, icon("plus", "sm"), "Anlegen");
        mk.addEventListener("click", () => withBusy(mk, async () => {
          const n = newName.value.trim();
          if (!/^[A-Za-z0-9._-]{1,80}$/.test(n)) return toast("Ungültiger Name", "Bitte nur Buchstaben, Zahlen, Punkt, - und _ (keine Leerzeichen).", "bad");
          try { await api("/host/mkdir", { method: "POST", body: { path: `${d.path}/${n}` } }); d.path = `${d.path}/${n}`; browse(); }
          catch (e) { errorToast(e); }
        }));
        clear(browser).append(
          h("div", { class: "row", style: { gap: "8px", marginBottom: "8px" } }, icon("folder", "sm"), h("span", { class: "mono", style: { fontWeight: 600, wordBreak: "break-all" } }, rel)),
          h("div", { class: "card pad-0 flat", style: { maxHeight: "260px", overflow: "auto" } }, h("div", { class: "list" },
            d.path !== d.source.path ? h("div", { class: "list-item clickable", style: { minHeight: "48px" }, onclick: () => { d.path = d.path.slice(0, d.path.lastIndexOf("/")); browse(); } },
              icon("chevronLeft", "sm"), h("div", { class: "grow" }, "Eine Ebene höher")) : null,
            res.dirs.length ? res.dirs.map(n => h("div", { class: "list-item clickable", style: { minHeight: "48px" }, onclick: () => { d.path = `${d.path}/${n}`; browse(); } },
              h("div", { class: "guest-icon", style: { width: "32px", height: "32px" } }, icon("folder", "sm")), h("div", { class: "grow title", style: { fontWeight: 560 } }, n), icon("chevronRight", "sm")))
              : h("div", { class: "muted small", style: { padding: "12px 16px" } }, "Keine Unterordner."))),
          h("div", { class: "row", style: { marginTop: "10px", gap: "8px" } }, newName, mk));
      }
      content.append(h("p", { class: "sheet-sub" }, `Welchen Ordner soll „${d.guest.name}“ sehen? Tippe auf einen Ordner, um hineinzugehen.`),
        h("div", { class: "stack" }, sources.length > 1 ? field("NAS-Freigabe", srcSel) : null, browser),
        h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: step1 }, "Zurück"),
          h("button", { class: "btn primary", onclick: () => {
            if (/[\s,=]/.test(d.path)) return toast("Ordnername nicht möglich", "Proxmox kann keine Ordner mit Leerzeichen oder Kommas einbinden. Bitte einen anderen Ordner wählen.", "bad");
            step3();
          } }, "Diesen Ordner nehmen")));
      browse();
    }

    // Schritt 3: Pfad in der App
    function step3() {
      clear(content);
      const app = detectApp(d.guest.name);
      const tip = APP_TIPS[app?.logo];
      const conf = model.configs.get(d.guest.vmid) || {};
      const unpriv = conf.unprivileged === 1 || conf.unprivileged === "1";
      const tIn = input({ value: d.target, autocapitalize: "off", oninput: (e) => { d.target = e.target.value.trim(); } });
      const saveBtn = h("button", { class: "btn primary" }, icon("check", "sm"), "Teilen");
      content.append(h("p", { class: "sheet-sub" }, "Unter welchem Pfad soll die App den Ordner sehen?"),
        h("div", { class: "stack", style: { gap: "16px" } },
          h("div", { class: "card flat", style: { padding: "12px 14px" } },
            h("div", { class: "row", style: { gap: "10px" } }, sourceIcon(d.source, 32), h("span", { class: "mono small", style: { wordBreak: "break-all" } }, d.path),
              icon("chevronRight", "sm"), guestIcon("lxc", d.guest.status, d.guest.name), h("strong", null, d.guest.name))),
          field("Pfad in der App", tIn, "So heißt der Ordner im Container. Muss mit / beginnen."),
          toggle("Nur lesen", "Die App kann die Dateien sehen, aber nichts ändern oder löschen.", d.ro, (v) => { d.ro = v; }),
          tip ? callout("info", `Danach in ${app.title}`, tip.tip) : null,
          unpriv && d.source.type === "nfs" ? callout("warn", "Schreibrechte", "Der Container ist unprivilegiert. Damit er auf die NFS-Freigabe schreiben darf, muss die NAS alle Benutzer auf admin abbilden (Squash).") : null,
          unpriv && d.source.type === "cifs" && !d.source.unprivWritable ? callout("warn", "Schreibrechte", "Diese Freigabe wurde ohne Container-Schreibrechte eingebunden. Die App kann vermutlich nur lesen. Lösung: Freigabe entfernen und hier neu verbinden.") : null,
          d.guest.status === "running" ? callout("info", null, "Der Container wird dafür kurz neu gestartet.") : null),
        h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: step2 }, "Zurück"), saveBtn));

      saveBtn.addEventListener("click", () => withBusy(saveBtn, async () => {
        if (!/^\/[A-Za-z0-9._/-]+$/.test(d.target) || d.target.includes("..") || d.target === "/") return toast("Ungültiger Pfad", "Beispiel: /mnt/fotos (keine Leerzeichen).", "bad");
        let fresh;
        try { fresh = await pve("GET", nodePath(`/lxc/${d.guest.vmid}/config`)); } catch (e) { return errorToast(e); }
        if (Object.entries(fresh).some(([k, v]) => /^mp\d+$/.test(k) && parseConfigValue(v).mp === d.target)) return toast("Pfad schon belegt", "In diesem Container ist unter dem Pfad schon etwas eingebunden.", "bad");
        let n = 0; while (fresh[`mp${n}`] !== undefined) n++;
        if (n > 255) return toast("Zu viele Einhängepunkte", "", "bad");
        try {
          await pve("PUT", nodePath(`/lxc/${d.guest.vmid}/config`), { [`mp${n}`]: `${d.path},mp=${d.target}${d.ro ? ",ro=1" : ""}` });
          close();
          if (d.guest.status === "running") {
            const upid = await pve("POST", nodePath(`/lxc/${d.guest.vmid}/status/reboot`));
            trackTask(upid, `${d.guest.name} neu starten`, { onDone: onDone });
          } else onDone();
          toast("Ordner geteilt", `${d.guest.name} sieht den Ordner jetzt unter ${d.target}.`, "ok", { timeout: 8000 });
        } catch (e) { errorToast(e, "Teilen fehlgeschlagen"); }
      }));
    }

    step1();
  });
}

async function removeLink(l, reload) {
  const running = l.guest.status === "running";
  if (!await confirmDialog({ title: "Verbindung entfernen?", text: `${l.guest.name} sieht ${l.label} danach nicht mehr. Die Dateien auf der NAS bleiben erhalten.${running ? " Der Container wird dafür neu gestartet." : ""}`, confirmText: "Entfernen", danger: true })) return;
  try {
    await pve("PUT", nodePath(`/lxc/${l.guest.vmid}/config`), { delete: l.key });
    if (running) trackTask(await pve("POST", nodePath(`/lxc/${l.guest.vmid}/status/reboot`)), `${l.guest.name} neu starten`, { onDone: reload });
    else reload();
    toast("Verbindung entfernt");
  } catch (e) { errorToast(e); }
}

async function removeStorage(s, links, reload) {
  const used = links.filter(l => l.guest);
  if (used.length) return toast("Wird noch benutzt", `Entferne zuerst die Verbindungen zu: ${[...new Set(used.map(l => l.guest.name))].join(", ")}.`, "bad", { timeout: 8000 });
  if (!await confirmDialog({ title: `„${s.title}“ entfernen?`, text: "Proxmox trennt die Verbindung zur NAS. Die Dateien auf der NAS bleiben unverändert.", confirmText: "Entfernen", danger: true })) return;
  try { await pve("DELETE", `/storage/${enc(s.storage)}`); toast("Freigabe entfernt"); reload(); } catch (e) { errorToast(e); }
}

function moveBackupsSheet(model, reload) {
  const targets = model.sources.filter(s => s.kind === "pve" && s.content.includes("backup") && s.active);
  openSheet((sheet, close) => {
    const sel = select(targets.map(s => ({ value: s.storage, label: `${s.storage} (${shareLabel(s.share, s.type)})` })), targets[0]?.storage);
    const btn = h("button", { class: "btn primary" }, "Umstellen");
    btn.addEventListener("click", () => withBusy(btn, async () => {
      try {
        for (const j of model.localBackups) await pve("PUT", `/cluster/backup/${enc(j.id)}`, { storage: sel.value });
        close(); toast("Sicherungen umgestellt", `Neue Sicherungen landen ab jetzt auf „${sel.value}“.`); reload();
      } catch (e) { errorToast(e); }
    }));
    sheet.append(h("h2", null, "Sicherungen auf die NAS umstellen"),
      h("p", { class: "sheet-sub" }, `${model.localBackups.length} Zeitplan${model.localBackups.length === 1 ? "" : "e"} speichert gerade auf der System-Festplatte.`),
      field("Neuer Speicherort", sel),
      h("div", { style: { marginTop: "14px" } }, callout("info", null, "Vorhandene alte Sicherungen bleiben, wo sie sind. Du kannst sie unter „Sicherungen“ löschen, um Platz zu schaffen.")),
      h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Abbrechen"), btn));
  });
}
