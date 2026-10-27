import {
  h, icon, clear, pve, state, bytes, pct, uptime, meter, num, guestIcon, statusBadge, callout, loader, nodePath, enc,
  toast, errorToast, trackTask, confirmDialog, openSheet, field, input, select, toggle, withBusy, pageHead, empty, relTime,
  guestTypeLabel, dateTime, api, lockBadge, LOCK_TEXT, taskName, parseUpid,
  backupDownloadBtn,
} from "../core.js";
import { statsSection, sizingSection, hardwareCard, optionsCard, actionsCard, historyCard } from "./guestExtra.js";

// ---------------------------------------------------------------------------
// Liste
// ---------------------------------------------------------------------------
export async function renderGuests({ page, el, go }) {
  let filter = "all";
  let query = "";
  const search = h("div", { class: "input-wrap", style: { flex: "1", minWidth: "200px" } }, icon("search", "sm"),
    input({ placeholder: "Suchen nach Name oder Nummer …", oninput: (e) => { query = e.target.value.toLowerCase(); draw(); } }));
  const chips = h("div", { class: "chips" });
  const listCard = h("div", { class: "card pad-0" }, loader());
  el.append(
    pageHead("Maschinen", "Alle Container und virtuellen Maschinen auf deinem Server.",
      [h("a", { class: "btn primary", href: "#/new" }, icon("plus", "sm"), "Neu anlegen")]),
    h("div", { class: "row wrap", style: { marginBottom: "14px", gap: "12px" } }, search),
    chips, h("div", { style: { height: "12px" } }), listCard);

  let guests = [];
  function drawChips() {
    clear(chips);
    const counts = { all: guests.length, running: guests.filter(g => g.status === "running").length,
      stopped: guests.filter(g => g.status !== "running").length, lxc: guests.filter(g => g.type === "lxc").length,
      qemu: guests.filter(g => g.type === "qemu").length };
    for (const [k, label] of [["all", "Alle"], ["running", "Laufen"], ["stopped", "Aus"], ["lxc", "Container"], ["qemu", "VMs"]]) {
      chips.append(h("button", { class: `chip ${filter === k ? "active" : ""}`, onclick: () => { filter = k; drawChips(); draw(); } }, `${label} · ${counts[k]}`));
    }
  }

  function draw() {
    clear(listCard);
    let list = guests.filter(g =>
      (filter === "all" || (filter === "running" && g.status === "running") || (filter === "stopped" && g.status !== "running") || g.type === filter) &&
      (!query || String(g.vmid).includes(query) || (g.name || "").toLowerCase().includes(query) || (g.tags || "").toLowerCase().includes(query)));
    if (!guests.length) {
      listCard.append(empty("server", "Noch keine Maschinen", "Leg einen Container oder eine VM an – oder installiere direkt eine App.",
        h("div", { class: "row", style: { justifyContent: "center" } }, h("a", { class: "btn primary", href: "#/new" }, "Neu anlegen"), h("a", { class: "btn", href: "#/apps" }, "Apps ansehen"))));
      return;
    }
    if (!list.length) { listCard.append(empty("search", "Nichts gefunden", "Versuche einen anderen Suchbegriff.")); return; }
    list.sort((a, b) => a.vmid - b.vmid);
    listCard.append(h("div", { class: "list" }, list.map(g => guestRow(g, go))));
  }

  async function load() {
    try {
      const res = await pve("GET", "/cluster/resources", { type: "vm" });
      guests = res.filter(r => r.node === state.node && !r.template);
      drawChips(); draw();
    } catch (e) { clear(listCard).append(h("div", { style: { padding: "18px" } }, callout("bad", "Laden fehlgeschlagen", e.message))); }
  }
  await load();
  page.every(5000, load);
  page.on("bpui:refresh", load);
}

function guestRow(g, go) {
  const running = g.status === "running";
  const powerBtn = h("button", { class: `btn sm ${running ? "" : "primary"}`, title: running ? "Herunterfahren" : "Starten",
    onclick: async (e) => {
      e.stopPropagation();
      if (running) {
        if (!await confirmDialog({ title: `„${g.name}“ herunterfahren?`, text: "Die Maschine wird sauber beendet – wie beim normalen Ausschalten am PC.", confirmText: "Herunterfahren" })) return;
      }
      await powerAction(g.type, g.vmid, running ? "shutdown" : "start", g.name, powerBtn);
    } }, icon(running ? "power" : "play", "sm"), h("span", { class: "hide-sm" }, running ? "Aus" : "Start"));
  return h("div", { class: "list-item clickable", onclick: () => go(`guest/${g.type}/${g.vmid}`) },
    guestIcon(g.type, g.status, g.name),
    h("div", { class: "grow" },
      h("div", { class: "row", style: { gap: "8px" } }, h("div", { class: "title" }, g.name || `#${g.vmid}`), h("span", { class: "badge" }, `#${g.vmid}`), lockBadge(g.lock)),
      h("div", { class: "meta" }, running
        ? `${guestTypeLabel(g.type)} · CPU ${num((g.cpu || 0) * 100, 0)} % · RAM ${bytes(g.mem)} von ${bytes(g.maxmem)} · läuft seit ${uptime(g.uptime)}`
        : `${guestTypeLabel(g.type)} · ausgeschaltet`)),
    h("div", { class: "end" }, powerBtn));
}

const ACTION_TEXT = { start: "Wird gestartet", shutdown: "Wird heruntergefahren", reboot: "Wird neu gestartet", stop: "Wird ausgeschaltet", suspend: "Wird pausiert", resume: "Wird fortgesetzt" };

export async function powerAction(type, vmid, action, name, btn) {
  const run = async () => {
    try {
      const upid = await pve("POST", nodePath(`/${type}/${vmid}/status/${action}`));
      trackTask(upid, `${name || vmid}: ${ACTION_TEXT[action] || action}`);
    } catch (e) { errorToast(e); }
  };
  if (btn) await withBusy(btn, run); else await run();
}

// ---------------------------------------------------------------------------
// Detailansicht
// ---------------------------------------------------------------------------
export async function renderGuestDetail({ page, el, go }, type, vmid) {
  if (!["qemu", "lxc"].includes(type) || !/^\d+$/.test(vmid || "")) return go("guests");
  const base = nodePath(`/${type}/${vmid}`);
  el.append(h("a", { class: "back", href: "#/guests" }, icon("chevronLeft", "sm"), "Maschinen"));
  const hero = h("div", { class: "card" }, loader());
  const live = h("div", { class: "grid cols-4", style: { marginTop: "14px" } });
  const body = h("div");
  el.append(hero, live, body);

  let config, status;
  try {
    [config, status] = await Promise.all([pve("GET", `${base}/config`), pve("GET", `${base}/status/current`)]);
  } catch (e) {
    clear(hero).append(callout("bad", "Maschine nicht gefunden", e.message));
    return;
  }
  const name = config.hostname || config.name || `#${vmid}`;

  function drawHero() {
    const running = status.status === "running";
    const actions = h("div", { class: "action-bar" });
    if (!running) {
      actions.append(btnAction("play", "Starten", "primary", (b) => powerAction(type, vmid, "start", name, b)));
    } else {
      actions.append(
        btnAction("power", "Herunterfahren", "", async (b) => {
          if (await confirmDialog({ title: "Herunterfahren?", text: `„${name}“ wird sauber beendet.`, confirmText: "Herunterfahren" })) powerAction(type, vmid, "shutdown", name, b);
        }),
        btnAction("restart", "Neu starten", "", async (b) => {
          if (await confirmDialog({ title: "Neu starten?", text: `„${name}“ wird neu gestartet.`, confirmText: "Neu starten" })) powerAction(type, vmid, "reboot", name, b);
        }),
        btnAction("stop", "Hart ausschalten", "danger-ghost", async (b) => {
          if (await confirmDialog({ title: "Hart ausschalten?", text: "Wie Stecker ziehen: Nicht gespeicherte Daten in der Maschine können verloren gehen. Nur nutzen, wenn sie nicht mehr reagiert.", confirmText: "Ausschalten", danger: true }))
            powerAction(type, vmid, "stop", name, b);
        }),
      );
    }
    const consoleUrl = `https://${location.hostname}:8006/?console=${type === "qemu" ? "kvm" : "lxc"}&novnc=1&vmid=${vmid}&vmname=${enc(name)}&node=${enc(state.node)}&resize=off&cmd=`;
    actions.append(h("a", { class: "btn", href: consoleUrl, target: "_blank", rel: "noopener" }, icon("terminal", "sm"), "Konsole"));

    clear(hero).append(
      h("div", { class: "detail-hero" }, guestIcon(type, status.status, name),
        h("div", { style: { flex: 1, minWidth: "200px" } },
          h("div", { class: "row wrap", style: { gap: "8px" } }, h("h1", { style: { margin: 0, fontSize: "24px", letterSpacing: "-.02em" } }, name), statusBadge(status.status)),
          h("div", { class: "muted", style: { marginTop: "2px" } }, `${guestTypeLabel(type)} #${vmid}`, h("span", { id: "ip-line" })))),
      config.lock ? h("div", { style: { marginTop: "16px" } }, lockCallout(type, vmid, name, config.lock, async () => {
        try { config = await pve("GET", `${base}/config`); status = await pve("GET", `${base}/status/current`); drawHero(); } catch { /* egal */ }
      })) : null,
      h("div", { style: { marginTop: "16px" } }, actions),
      h("div", { class: "muted small", style: { marginTop: "10px" } }, "Die Konsole öffnet sich in der Proxmox-Oberfläche (eventuell dort einmal anmelden)."),
    );
    loadIp();
  }

  async function loadIp() {
    if (status.status !== "running") return;
    try {
      let ips = [];
      if (type === "lxc") {
        const ifs = await pve("GET", `${base}/interfaces`);
        ips = (ifs || []).filter(i => i.name !== "lo" && i.inet).map(i => i.inet.split("/")[0]);
      } else if (/enabled=1|^1/.test(config.agent || "")) {
        const res = await pve("GET", `${base}/agent/network-get-interfaces`);
        for (const i of res?.result || []) {
          if (i.name === "lo") continue;
          for (const a of i["ip-addresses"] || []) if (a["ip-address-type"] === "ipv4") ips.push(a["ip-address"]);
        }
      }
      const line = document.getElementById("ip-line");
      if (line && ips.length) line.replaceChildren(" · IP ", h("strong", { class: "mono" }, ips.join(", ")));
    } catch { /* Agent fehlt o. ä. */ }
  }

  function drawLive() {
    const running = status.status === "running";
    const cpuP = (status.cpu || 0) * 100;
    const memP = pct(status.mem, status.maxmem);
    clear(live).append(
      liveCard("cpu", "Prozessor", running ? `${num(cpuP, 0)} %` : "–", `${status.cpus || config.cores || 1} Kern(e)`, running ? cpuP : 0),
      liveCard("memory", "Arbeitsspeicher", running ? bytes(status.mem) : "–", `von ${bytes(status.maxmem)}`, running ? memP : 0),
      liveCard("disk", "Festplatte", type === "lxc" && status.disk ? bytes(status.disk) : bytes(status.maxdisk), type === "lxc" && status.disk ? `von ${bytes(status.maxdisk)}` : "Größe", type === "lxc" ? pct(status.disk, status.maxdisk) : null),
      liveCard("clock", "Laufzeit", running ? uptime(status.uptime) : "Aus", running ? "seit dem letzten Start" : "", null),
    );
  }

  drawHero(); drawLive();
  const reload = () => window.dispatchEvent(new HashChangeEvent("hashchange"));
  body.append(
    sizingSection({ type, vmid: Number(vmid), name, status: status.status, maxcpu: status.cpus }, config, reload),
    statsSection(type, vmid),
    settingsCard(type, vmid, base, config, name),
    hardwareCard(type, vmid, base, config, name, reload),
    optionsCard(type, base, config, reload),
    snapshotsCard(type, base, name, page),
    backupCard(type, vmid, name),
    actionsCard(type, vmid, base, config, name, () => status, go),
    historyCard(vmid),
    dangerCard(type, vmid, base, name, () => status, go),
  );

  page.every(4000, async () => {
    try {
      const old = status.status, oldLock = status.lock;
      status = await pve("GET", `${base}/status/current`);
      if (oldLock !== status.lock) { config = await pve("GET", `${base}/config`); drawHero(); }
      else if (old !== status.status) drawHero();
      drawLive();
    } catch { /* ignorieren */ }
  });
  page.on("bpui:refresh", async () => { try { status = await pve("GET", `${base}/status/current`); drawHero(); drawLive(); } catch { /* egal */ } });
}

function btnAction(ico, label, cls, fn) {
  const b = h("button", { class: `btn ${cls}` }, icon(ico, "sm"), label);
  b.addEventListener("click", () => fn(b));
  return b;
}

function liveCard(ico, label, value, sub, p) {
  return h("div", { class: "card" }, h("div", { class: "stat" }, h("div", { class: "label" }, icon(ico, "sm"), label),
    h("div", { class: "value", style: { fontSize: "22px" } }, value), h("div", { class: "sub" }, sub),
    p !== null && p !== undefined ? meter(p, "thin") : null));
}

// ---------- Einstellungen ----------
function settingsCard(type, vmid, base, config, name) {
  const card = h("div", { class: "card", style: { marginTop: "14px" } });
  const nameIn = input({ value: name });
  const cores = input({ type: "number", min: 1, max: 128, value: config.cores || 1 });
  const mem = input({ type: "number", min: 128, step: 128, value: config.memory || 512 });
  let onboot = config.onboot === 1 || config.onboot === "1";
  const desc = h("textarea", { class: "input", rows: 3, placeholder: "Notizen zu dieser Maschine (optional)" });
  desc.value = config.description || "";
  const saveBtn = h("button", { class: "btn primary" }, "Speichern");
  saveBtn.addEventListener("click", () => withBusy(saveBtn, async () => {
    const body = { cores: Number(cores.value), memory: Number(mem.value), onboot: onboot ? 1 : 0, description: desc.value };
    const n = nameIn.value.trim();
    if (n && n !== name) body[type === "lxc" ? "hostname" : "name"] = n;
    try {
      const upid = await pve("PUT", `${base}/config`, body);
      if (upid) trackTask(upid, "Einstellungen speichern");
      toast("Gespeichert", type === "qemu" ? "Änderungen an CPU oder RAM wirken bei VMs teils erst nach einem Neustart." : "");
    } catch (e) { errorToast(e); }
  }));

  // Festplatten, die vergrößert werden können
  const disks = Object.entries(config).filter(([k, v]) =>
    (type === "lxc" ? /^(rootfs|mp\d+)$/.test(k) : /^(scsi|virtio|sata|ide)\d+$/.test(k)) && typeof v === "string" && !/media=cdrom/.test(v) && !/^none/.test(v))
    .map(([k, v]) => ({ key: k, size: (v.match(/size=([^,]+)/) || [])[1] || "?" }));

  card.append(
    h("div", { class: "card-head" }, icon("settings"), h("h3", null, "Einstellungen")),
    h("div", { class: "form-grid" },
      field(type === "lxc" ? "Name" : "Name", nameIn),
      field("Prozessorkerne", cores),
      field("Arbeitsspeicher (MB)", mem, "1024 MB = 1 GB"),
      h("div", { class: "field" }, h("label", null, "Autostart"), toggle("Mit dem Server starten", "Startet automatisch, wenn Proxmox hochfährt.", onboot, (v) => { onboot = v; }))),
    h("div", { style: { marginTop: "16px" } }, field("Notizen", desc)),
    h("div", { class: "row wrap", style: { marginTop: "16px" } }, saveBtn,
      disks.length ? h("button", { class: "btn", onclick: () => resizeSheet(base, disks, name) }, icon("disk", "sm"), "Festplatte vergrößern") : null),
  );
  return card;
}

function resizeSheet(base, disks, name) {
  openSheet((sheet, close) => {
    const diskSel = select(disks.map(d => ({ value: d.key, label: `${d.key} (aktuell ${d.size})` })), disks[0].key);
    const add = input({ type: "number", min: 1, value: 8 });
    const btn = h("button", { class: "btn primary" }, "Vergrößern");
    btn.addEventListener("click", () => withBusy(btn, async () => {
      const n = Number(add.value);
      if (!(n > 0)) return toast("Bitte eine Zahl größer 0 eingeben", "", "bad");
      try {
        const upid = await pve("PUT", `${base}/resize`, { disk: diskSel.value, size: `+${n}G` });
        close(); trackTask(upid, `${name}: Festplatte vergrößern`);
        if (!upid) toast("Festplatte vergrößert");
      } catch (e) { errorToast(e); }
    }));
    sheet.append(h("h2", null, "Festplatte vergrößern"),
      h("p", { class: "sheet-sub" }, "Mehr Platz für die Maschine. Verkleinern ist nicht möglich."),
      h("div", { class: "stack" }, field("Festplatte", diskSel), field("Zusätzlicher Platz (GB)", add)),
      callout("info", null, "Bei VMs muss die Partition im Betriebssystem eventuell noch erweitert werden. Bei Containern passiert das automatisch."),
      h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Abbrechen"), btn));
  });
}

// ---------- Snapshots ----------
function snapshotsCard(type, base, name) {
  const card = h("div", { class: "card", style: { marginTop: "14px" } });
  const listEl = h("div");
  const addBtn = h("button", { class: "btn sm", onclick: () => createSnapshot() }, icon("camera", "sm"), "Snapshot erstellen");
  card.append(h("div", { class: "card-head" }, icon("camera"), h("h3", null, "Snapshots"), h("span", { class: "spacer" }), addBtn),
    h("p", { class: "muted small", style: { marginTop: "-6px" } }, "Ein Snapshot ist ein schneller Sicherungspunkt – ideal vor Updates oder Experimenten. Er ersetzt keine richtige Sicherung."),
    listEl);

  async function load() {
    clear(listEl).append(loader());
    try {
      const snaps = (await pve("GET", `${base}/snapshot`)).filter(s => s.name !== "current").sort((a, b) => (b.snaptime || 0) - (a.snaptime || 0));
      clear(listEl);
      if (!snaps.length) { listEl.append(h("div", { class: "muted", style: { padding: "8px 0" } }, "Noch keine Snapshots.")); return; }
      listEl.append(h("div", { class: "card pad-0 flat" }, h("div", { class: "list" }, snaps.map(s =>
        h("div", { class: "list-item" },
          h("div", { class: "grow" }, h("div", { class: "title" }, s.name), h("div", { class: "meta" }, `${s.snaptime ? dateTime(s.snaptime) : ""}${s.description ? " · " + s.description.trim() : ""}`)),
          h("div", { class: "end" },
            h("button", { class: "btn sm", onclick: async () => {
              if (!await confirmDialog({ title: `Zu „${s.name}“ zurückkehren?`, text: "Alle Änderungen seit diesem Snapshot gehen verloren. Die Maschine wird dabei angehalten.", confirmText: "Zurückspielen", danger: true })) return;
              try { trackTask(await pve("POST", `${base}/snapshot/${enc(s.name)}/rollback`), `${name}: Snapshot zurückspielen`, { onDone: load }); } catch (e) { errorToast(e); }
            } }, icon("restart", "sm"), "Zurück"),
            h("button", { class: "btn sm icon danger-ghost", title: "Löschen", onclick: async () => {
              if (!await confirmDialog({ title: `Snapshot „${s.name}“ löschen?`, confirmText: "Löschen", danger: true })) return;
              try { trackTask(await pve("DELETE", `${base}/snapshot/${enc(s.name)}`), `${name}: Snapshot löschen`, { onDone: load }); } catch (e) { errorToast(e); }
            } }, icon("trash", "sm")))),
      ))));
    } catch (e) { clear(listEl).append(callout("warn", null, `Snapshots nicht verfügbar: ${e.message}`)); }
  }

  function createSnapshot() {
    openSheet((sheet, close) => {
      const d = new Date();
      const def = `snap_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
      const n = input({ value: def });
      const desc = input({ placeholder: "z. B. Vor dem Update" });
      let ram = false;
      const btn = h("button", { class: "btn primary" }, "Erstellen");
      btn.addEventListener("click", () => withBusy(btn, async () => {
        if (!/^[A-Za-z][A-Za-z0-9_-]{1,39}$/.test(n.value)) return toast("Ungültiger Name", "Nur Buchstaben, Zahlen, - und _. Muss mit einem Buchstaben beginnen.", "bad");
        try {
          const body = { snapname: n.value, description: desc.value };
          if (type === "qemu" && ram) body.vmstate = 1;
          const upid = await pve("POST", `${base}/snapshot`, body);
          close(); trackTask(upid, `${name}: Snapshot erstellen`, { onDone: load });
        } catch (e) { errorToast(e); }
      }));
      sheet.append(h("h2", null, "Snapshot erstellen"), h("p", { class: "sheet-sub" }, `Sicherungspunkt für „${name}“.`),
        h("div", { class: "stack" }, field("Name", n), field("Beschreibung", desc),
          type === "qemu" ? toggle("Arbeitsspeicher mitsichern", "Laufende Programme werden mitgesichert. Dauert länger.", false, (v) => { ram = v; }) : null),
        h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Abbrechen"), btn));
    });
  }
  load();
  return card;
}

// ---------- Sicherung ----------
function backupCard(type, vmid, name) {
  const card = h("div", { class: "card", style: { marginTop: "14px" } });
  const listEl = h("div", { class: "muted small" }, "Lade …");
  card.append(h("div", { class: "card-head" }, icon("archive"), h("h3", null, "Sicherungen"), h("span", { class: "spacer" }),
    h("button", { class: "btn sm primary", onclick: () => backupNowSheet([{ vmid, name }]) }, "Jetzt sichern")), listEl);
  (async () => {
    try {
      const stores = await pve("GET", nodePath("/storage"), { content: "backup", enabled: 1 });
      let all = [];
      for (const s of stores) {
        try { all = all.concat((await pve("GET", nodePath(`/storage/${enc(s.storage)}/content`), { content: "backup", vmid })).map(b => ({ ...b, storeType: s.type }))); } catch { /* egal */ }
      }
      all.sort((a, b) => (b.ctime || 0) - (a.ctime || 0));
      clear(listEl).append(all.length
        ? h("div", null, h("div", null, `${all.length} Sicherung${all.length === 1 ? "" : "en"} vorhanden · letzte ${relTime(all[0].ctime)} (${bytes(all[0].size)}). `, h("a", { href: "#/backups" }, "Verwalten")),
            h("div", { style: { marginTop: "10px" } }, backupDownloadBtn(all[0], all[0].storeType, { label: "Neueste herunterladen" })))
        : "Für diese Maschine gibt es noch keine Sicherung.");
    } catch (e) { clear(listEl).append(e.message); }
  })();
  return card;
}

export function backupNowSheet(guests, allGuests = false) {
  openSheet(async (sheet, close) => {
    const storeSel = select([{ value: "", label: "Lade …" }], "");
    const btn = h("button", { class: "btn primary" }, "Sicherung starten");
    let mode = "snapshot";
    sheet.append(h("h2", null, "Jetzt sichern"),
      h("p", { class: "sheet-sub" }, allGuests ? "Alle Maschinen werden gesichert." : `Gesichert wird: ${guests.map(g => g.name || g.vmid).join(", ")}`),
      h("div", { class: "stack" },
        field("Speicherort", storeSel, "Wohin die Sicherung geschrieben wird."),
        field("Art", select([
          { value: "snapshot", label: "Im laufenden Betrieb (empfohlen)" },
          { value: "suspend", label: "Kurz pausieren" },
          { value: "stop", label: "Ausschalten während der Sicherung (am sichersten)" }], mode, { onchange: (e) => { mode = e.target.value; } }))),
      h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Abbrechen"), btn));
    try {
      const stores = await pve("GET", nodePath("/storage"), { content: "backup", enabled: 1 });
      clear(storeSel);
      if (!stores.length) storeSel.append(h("option", { value: "" }, "Kein Speicher für Sicherungen vorhanden"));
      for (const s of stores) storeSel.append(h("option", { value: s.storage }, `${s.storage} · ${bytes(s.avail)} frei`));
      const pbs = stores.find(s => s.type === "pbs");
      if (pbs) storeSel.value = pbs.storage;
    } catch (e) { errorToast(e); }
    btn.addEventListener("click", () => withBusy(btn, async () => {
      if (!storeSel.value) return toast("Bitte Speicherort wählen", "", "bad");
      const body = { storage: storeSel.value, mode, compress: "zstd" };
      if (allGuests) body.all = 1; else body.vmid = guests.map(g => g.vmid).join(",");
      try {
        const upid = await pve("POST", nodePath("/vzdump"), body);
        close(); trackTask(upid, "Sicherung");
      } catch (e) { errorToast(e); }
    }));
  });
}

// ---------- Gefahrenzone ----------
function dangerCard(type, vmid, base, name, getStatus, go) {
  const btn = h("button", { class: "btn danger-ghost" }, icon("trash", "sm"), "Maschine löschen");
  btn.addEventListener("click", async () => {
    if (getStatus().status === "running") return toast("Bitte zuerst ausschalten", "Laufende Maschinen können nicht gelöscht werden.", "bad");
    const ok = await confirmDialog({
      title: `„${name}“ endgültig löschen?`,
      text: "Die Maschine und ihre Festplatten werden gelöscht. Vorhandene Sicherungen bleiben erhalten. Das kann nicht rückgängig gemacht werden.",
      confirmText: "Endgültig löschen", danger: true, typeToConfirm: name,
    });
    if (!ok) return;
    try {
      const upid = await pve("DELETE", base, { purge: 1, "destroy-unreferenced-disks": 1 });
      trackTask(upid, `${name} löschen`);
      go("guests");
    } catch (e) { errorToast(e); }
  });
  return h("div", { class: "card danger-zone", style: { marginTop: "14px" } },
    h("div", { class: "card-head" }, icon("alert"), h("h3", null, "Gefahrenzone")),
    h("p", { class: "muted small", style: { marginTop: "-6px" } }, "Vorsicht: Diese Aktionen lassen sich nicht rückgängig machen."),
    btn);
}

// ---------------------------------------------------------------------------
// Entsperren
// ---------------------------------------------------------------------------
function lockCallout(type, vmid, name, lock, onDone) {
  const btn = h("button", { class: "btn sm" }, icon("lock", "sm"), "Entsperren");
  btn.addEventListener("click", () => unlockFlow(type, vmid, name, lock, onDone));
  const c = callout("warn", `Gesperrt: ${LOCK_TEXT[lock] || lock}`,
    "Solange die Sperre besteht, lässt sich die Maschine nicht starten, ändern oder sichern. Das passiert z. B., wenn eine Sicherung abbricht.");
  c.querySelector("div").append(h("div", { style: { marginTop: "10px" } }, btn));
  return c;
}

/** Entsperrt eine Maschine. Prüft vorher, ob noch eine Aufgabe für sie läuft. */
export async function unlockFlow(type, vmid, name, lock, onDone) {
  if (!state.user.host_admin) return toast("Nur für root@pam", "Entsperren darf – wie in Proxmox – nur root.", "bad");
  let running = [];
  try { running = (await pve("GET", nodePath("/tasks"), { vmid, source: "active" })).filter(t => !t.endtime); } catch { /* egal */ }
  const doUnlock = async () => {
    try {
      await api(`/guests/${type}/${vmid}/unlock`, { method: "POST" });
      toast(`${name} entsperrt`, "Die Maschine kann wieder normal genutzt werden.");
      window.dispatchEvent(new Event("bpui:refresh"));
      onDone && onDone();
    } catch (e) { errorToast(e, "Entsperren fehlgeschlagen"); }
  };
  if (running.length) {
    openSheet((sheet, close) => {
      const stopBtn = h("button", { class: "btn danger" }, "Aufgabe abbrechen und entsperren");
      stopBtn.addEventListener("click", () => withBusy(stopBtn, async () => {
        try {
          for (const t of running) await pve("DELETE", `/nodes/${enc(parseUpid(t.upid).node)}/tasks/${enc(t.upid)}`);
          await new Promise(r => setTimeout(r, 2500));
          close(); await doUnlock();
        } catch (e) { errorToast(e); }
      }));
      sheet.append(h("h2", null, "Es läuft noch etwas"),
        h("p", { class: "sheet-sub" }, `Für „${name}“ läuft gerade: ${running.map(t => taskName(t.type, t.id)).join(", ")}. Die Sperre ist also vermutlich noch berechtigt.`),
        callout("info", "Empfehlung", "Warte, bis die Aufgabe fertig ist – danach verschwindet die Sperre von selbst. Nur abbrechen, wenn sie offensichtlich hängt (z. B. seit Stunden ohne Fortschritt)."),
        h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Warten"), stopBtn));
    });
    return;
  }
  const ok = await confirmDialog({
    title: `„${name}“ entsperren?`,
    text: `Grund der Sperre: ${LOCK_TEXT[lock] || lock}. Es läuft keine Aufgabe mehr für diese Maschine – die Sperre ist vermutlich von einem abgebrochenen Vorgang übrig geblieben.`,
    confirmText: "Entsperren",
    extra: lock === "mounted" ? callout("warn", null, "Die Festplatte ist noch auf dem Server eingehängt. Nach dem Entsperren ggf. mit „pct unmount " + vmid + "“ aushängen.") : null,
  });
  if (ok) await doUnlock();
}
