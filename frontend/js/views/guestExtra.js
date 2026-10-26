// ===========================================================================
// Maschinen-Detail: Statistik, Größen-Empfehlung, Hardware, Optionen, Aktionen, Verlauf
// ===========================================================================
import {
  h, icon, clear, pve, state, bytes, nodePath, enc, toast, errorToast, trackTask, openSheet, confirmDialog, field, input, select,
  toggle, withBusy, callout, loader, segmented, rrd, TIMEFRAMES, relTime, taskName, showTaskLog, validHostname,
} from "../core.js";
import { guestCharts } from "./stats.js";
import { analyzeGuest, applySizing } from "../sizing.js";

const card = (ico, title, ...children) => h("div", { class: "card", style: { marginTop: "14px" } },
  h("div", { class: "card-head" }, icon(ico), h("h3", null, title)), ...children);

// ---------- Statistik ----------
export function statsSection(type, vmid) {
  let tf = "day";
  const grid = h("div", { class: "grid charts", style: { marginTop: "12px" } });
  const wrap = h("div", { style: { marginTop: "22px" } },
    h("div", { class: "row wrap", style: { gap: "12px" } }, h("h2", { class: "section", style: { margin: 0 } }, "Statistik"),
      h("div", { style: { marginLeft: "auto", minWidth: "min(100%, 420px)" } }, segmented(TIMEFRAMES, tf, (v) => { tf = v; load(); }))),
    grid);
  async function load() {
    clear(grid).append(loader());
    let rows = [];
    try { rows = await rrd(nodePath(`/${type}/${vmid}/rrddata`), tf); } catch (e) { clear(grid).append(callout("warn", null, e.message)); return; }
    clear(grid).append(guestCharts(rows, type));
  }
  load();
  return wrap;
}

// ---------- Größen-Empfehlung ----------
export function sizingSection(g, conf, onApplied) {
  const box = h("div");
  (async () => {
    let nodeCores = 4;
    try { nodeCores = (await pve("GET", nodePath("/status"))).cpuinfo?.cpus || 4; } catch { /* egal */ }
    const list = await analyzeGuest(g, conf, nodeCores);
    if (!list.length) return;
    box.append(h("div", { class: "stack", style: { marginTop: "14px" } }, list.map(sz => {
      const c = callout(sz.dir === "up" ? (sz.level === "info" ? "info" : "warn") : "ok", sz.title, `${sz.why} ${sz.todo}`, sz.dir === "up" ? "alert" : "sparkle");
      const b = h("button", { class: "btn sm primary" }, icon("check", "sm"), sz.dir === "up" ? "Erhöhen" : "Reduzieren");
      b.addEventListener("click", () => withBusy(b, async () => { try { await applySizing(sz); onApplied && onApplied(); c.remove(); } catch (e) { errorToast(e); } }));
      c.querySelector("div").append(h("div", { style: { marginTop: "10px" } }, b));
      return c;
    })));
  })();
  return box;
}

// ---------- Hardware ----------
export function hardwareCard(type, vmid, base, config, name, reload) {
  const rows = [];
  const add = (label, value, action) => rows.push(h("div", { class: "list-item", style: { minHeight: "52px", padding: "10px 16px" } },
    h("div", { class: "grow" }, h("div", { class: "meta" }, label), h("div", { class: "title", style: { whiteSpace: "normal", wordBreak: "break-all", fontWeight: 560 } }, value)), action || null));
  add("Prozessor", `${config.cores || 1} Kern(e)${config.sockets > 1 ? ` × ${config.sockets} Sockel` : ""}${config.cpu ? ` · Typ ${config.cpu}` : ""}`);
  add("Arbeitsspeicher", `${bytes((config.memory || 512) * 1024 * 1024)}${type === "lxc" ? ` · Swap ${bytes((config.swap || 0) * 1024 * 1024)}` : config.balloon === 0 ? " · ohne Ballooning" : ""}`);
  for (const [k, v] of Object.entries(config).sort()) {
    if (type === "lxc" && /^(rootfs|mp\d+)$/.test(k)) add(k === "rootfs" ? "System-Festplatte" : `Einhängepunkt ${k}`, String(v));
    else if (type === "qemu" && /^(scsi|virtio|sata|ide|efidisk|tpmstate)\d+$/.test(k)) {
      if (/media=cdrom/.test(v)) add(`CD/DVD (${k})`, String(v).split(",")[0] === "none" ? "leer" : String(v).split(",")[0].split("/").pop(),
        h("button", { class: "btn sm", onclick: () => isoSheet(base, k, name, reload) }, "Wechseln"));
      else add(k.startsWith("efidisk") ? "UEFI-Speicher" : k.startsWith("tpmstate") ? "TPM" : `Festplatte ${k}`, String(v));
    } else if (/^net\d+$/.test(k)) add(`Netzwerk ${k}`, String(v).replace(/,?hwaddr=[^,]+/i, "").replace(/^(virtio|e1000e?|rtl8139|vmxnet3)=([0-9A-F:]+)/i, "$1"));
    else if (/^(usb|hostpci)\d+$/.test(k)) add(k.startsWith("usb") ? `USB-Gerät ${k}` : `PCI-Gerät ${k}`, String(v));
  }
  if (type === "qemu") add("BIOS / Maschine", `${config.bios === "ovmf" ? "UEFI" : "SeaBIOS"} · ${config.machine || "i440fx"}`);
  if (config.ostype) add("Betriebssystem-Typ", String(config.ostype));

  const addDisk = h("button", { class: "btn sm" }, icon("plus", "sm"), "Festplatte hinzufügen");
  addDisk.addEventListener("click", () => addDiskSheet(type, base, config, name, reload));
  const addNet = h("button", { class: "btn sm" }, icon("plus", "sm"), "Netzwerkkarte hinzufügen");
  addNet.addEventListener("click", () => addNetSheet(type, base, config, name, reload));
  return card("cpu", "Hardware", h("div", { class: "card pad-0 flat" }, h("div", { class: "list" }, rows)),
    h("div", { class: "row wrap", style: { marginTop: "12px" } }, addDisk, addNet),
    h("p", { class: "muted small" }, "USB- und PCI-Geräte durchreichen geht in der Proxmox-Oberfläche (Hardware → Hinzufügen)."));
}

async function storagesFor(content) {
  return (await pve("GET", nodePath("/storage"), { content, enabled: 1 })).filter(s => s.active !== 0).sort((a, b) => (b.avail || 0) - (a.avail || 0));
}

function isoSheet(base, key, name, reload) {
  openSheet(async (sheet, close) => {
    const sel = select([{ value: "none", label: "Leer (keine ISO)" }], "none");
    const btn = h("button", { class: "btn primary" }, "Einlegen");
    sheet.append(h("h2", null, "CD/DVD wechseln"), h("p", { class: "sheet-sub" }, `Laufwerk ${key} von „${name}“.`), field("ISO-Datei", sel),
      h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Abbrechen"), btn));
    try {
      for (const s of await storagesFor("iso")) {
        for (const i of await pve("GET", nodePath(`/storage/${enc(s.storage)}/content`), { content: "iso" })) sel.append(h("option", { value: i.volid }, i.volid.split("/").pop()));
      }
    } catch (e) { errorToast(e); }
    btn.addEventListener("click", () => withBusy(btn, async () => {
      try { await pve("PUT", `${base}/config`, { [key]: `${sel.value},media=cdrom` }); toast(sel.value === "none" ? "CD ausgeworfen" : "ISO eingelegt"); close(); reload(); }
      catch (e) { errorToast(e); }
    }));
  });
}

function addDiskSheet(type, base, config, name, reload) {
  openSheet(async (sheet, close) => {
    const d = { storage: "", size: 32, mp: "/mnt/daten" };
    const sel = select([{ value: "", label: "Lade …" }], "");
    const btn = h("button", { class: "btn primary" }, "Hinzufügen");
    sheet.append(h("h2", null, "Festplatte hinzufügen"), h("p", { class: "sheet-sub" }, `Zusätzlicher Speicher für „${name}“.`),
      h("div", { class: "stack" }, field("Speicherort", sel), field("Größe (GB)", input({ type: "number", min: 1, value: d.size, oninput: (e) => { d.size = Number(e.target.value); } })),
        type === "lxc" ? field("Pfad im Container", input({ value: d.mp, oninput: (e) => { d.mp = e.target.value.trim(); } })) : callout("info", null, "Die neue Festplatte muss danach im Betriebssystem der VM noch formatiert werden (z. B. Windows: Datenträgerverwaltung).")),
      h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Abbrechen"), btn));
    try {
      const st = await storagesFor(type === "lxc" ? "rootdir" : "images");
      clear(sel).append(st.map(s => h("option", { value: s.storage }, `${s.storage} · ${bytes(s.avail)} frei`)));
    } catch (e) { errorToast(e); }
    btn.addEventListener("click", () => withBusy(btn, async () => {
      if (!(d.size > 0)) return toast("Bitte eine Größe angeben", "", "bad");
      try {
        if (type === "lxc") {
          if (!/^\/[A-Za-z0-9._/-]+$/.test(d.mp)) return toast("Ungültiger Pfad", "", "bad");
          let n = 0; while (config[`mp${n}`] !== undefined) n++;
          await pve("PUT", `${base}/config`, { [`mp${n}`]: `${sel.value}:${d.size},mp=${d.mp},backup=1` });
        } else {
          const bus = Object.keys(config).some(k => /^sata\d+$/.test(k) && !/media=cdrom/.test(config[k])) && !Object.keys(config).some(k => /^scsi\d+$/.test(k)) ? "sata" : "scsi";
          let n = 0; while (config[`${bus}${n}`] !== undefined) n++;
          await pve("PUT", `${base}/config`, { [`${bus}${n}`]: `${sel.value}:${d.size}${bus === "scsi" ? ",iothread=1" : ""},discard=on` });
        }
        toast("Festplatte hinzugefügt"); close(); reload();
      } catch (e) { errorToast(e); }
    }));
  });
}

function addNetSheet(type, base, config, name, reload) {
  openSheet(async (sheet, close) => {
    let bridges = ["vmbr0"];
    try { bridges = (await pve("GET", nodePath("/network"), { type: "any_bridge" })).map(b => b.iface).sort(); } catch { /* egal */ }
    const sel = select(bridges.map(b => ({ value: b, label: b })), bridges.includes("vmbr0") ? "vmbr0" : bridges[0]);
    const vlan = input({ type: "number", min: 1, max: 4094, placeholder: "leer = kein VLAN" });
    const btn = h("button", { class: "btn primary" }, "Hinzufügen");
    sheet.append(h("h2", null, "Netzwerkkarte hinzufügen"), h("p", { class: "sheet-sub" }, `Weitere Netzwerkverbindung für „${name}“.`),
      h("div", { class: "stack" }, field("Netzwerk-Brücke", sel), field("VLAN (optional)", vlan, "Nur nötig, wenn dein Netzwerk VLANs nutzt.")),
      h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Abbrechen"), btn));
    btn.addEventListener("click", () => withBusy(btn, async () => {
      let n = 0; while (config[`net${n}`] !== undefined) n++;
      const tag = vlan.value ? `,tag=${Number(vlan.value)}` : "";
      try {
        await pve("PUT", `${base}/config`, { [`net${n}`]: type === "lxc" ? `name=eth${n},bridge=${sel.value},ip=dhcp${tag}` : `virtio,bridge=${sel.value}${tag}` });
        toast("Netzwerkkarte hinzugefügt"); close(); reload();
      } catch (e) { errorToast(e); }
    }));
  });
}

// ---------- Optionen ----------
export function optionsCard(type, base, config, reload) {
  const st = Object.fromEntries(String(config.startup || "").split(",").filter(Boolean).map(x => x.split("=")));
  const order = input({ type: "number", min: 0, value: st.order || "", placeholder: "beliebig" });
  const up = input({ type: "number", min: 0, value: st.up || "", placeholder: "0" });
  const tags = input({ value: String(config.tags || "").split(/[;,\s]+/).filter(Boolean).join(", "), placeholder: "z. B. wichtig, smarthome" });
  let protection = config.protection === 1 || config.protection === "1";
  const save = h("button", { class: "btn primary" }, "Speichern");
  save.addEventListener("click", () => withBusy(save, async () => {
    const startup = [order.value ? `order=${Number(order.value)}` : null, up.value ? `up=${Number(up.value)}` : null].filter(Boolean).join(",");
    const t = tags.value.split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(x => /^[a-z0-9_+.-]+$/.test(x)).join(";");
    const body = { protection: protection ? 1 : 0 };
    const del = [];
    if (startup) body.startup = startup; else if (config.startup) del.push("startup");
    if (t) body.tags = t; else if (config.tags) del.push("tags");
    if (del.length) body.delete = del.join(",");
    try { await pve("PUT", `${base}/config`, body); toast("Optionen gespeichert"); reload(); } catch (e) { errorToast(e); }
  }));
  return card("settings", "Optionen",
    h("div", { class: "form-grid" },
      field("Start-Reihenfolge", order, "Kleinere Zahl startet zuerst – z. B. 1 für die Datenbank, 2 für die App."),
      field("Wartezeit danach (Sekunden)", up, "So lange wartet Proxmox, bevor die nächste Maschine startet."),
      field("Schlagwörter", tags, "Zum Sortieren und Wiederfinden.")),
    h("div", { style: { marginTop: "12px" } }, toggle("Löschschutz", "Verhindert, dass die Maschine versehentlich gelöscht wird.", protection, (v) => { protection = v; })),
    h("div", { style: { marginTop: "12px" } }, save));
}

// ---------- Aktionen: Klonen, Vorlage, Verschieben ----------
export function actionsCard(type, vmid, base, config, name, statusFn, go) {
  const clone = h("button", { class: "btn" }, icon("box", "sm"), "Klonen");
  clone.addEventListener("click", () => cloneSheet(type, vmid, base, name, go));
  const tpl = h("button", { class: "btn" }, icon("archive", "sm"), "In Vorlage umwandeln");
  tpl.addEventListener("click", async () => {
    if (statusFn().status === "running") return toast("Bitte zuerst ausschalten", "", "bad");
    if (!await confirmDialog({ title: "In Vorlage umwandeln?", text: `„${name}“ wird zur Vorlage. Vorlagen lassen sich nicht mehr starten, aber beliebig oft klonen. Das kann nicht rückgängig gemacht werden.`, confirmText: "Umwandeln", danger: true, typeToConfirm: name })) return;
    try { trackTask(await pve("POST", `${base}/template`), `${name} in Vorlage umwandeln`); go("guests"); } catch (e) { errorToast(e); }
  });
  const others = state.nodes.filter(n => n.node !== state.node && n.status === "online");
  const mig = others.length ? h("button", { class: "btn" }, icon("server", "sm"), "Auf anderen Server verschieben") : null;
  mig && mig.addEventListener("click", () => migrateSheet(type, base, name, others, statusFn, go));
  return card("sparkle", "Weitere Aktionen", h("div", { class: "action-bar" }, clone, tpl, mig),
    h("p", { class: "muted small" }, "Klonen erstellt eine unabhängige Kopie – praktisch zum Testen, bevor du etwas am Original änderst."));
}

function cloneSheet(type, vmid, base, name, go) {
  openSheet(async (sheet, close) => {
    const d = { name: `${name}-kopie`.slice(0, 60), storage: "" };
    const sel = select([{ value: "", label: "Wie das Original" }], "");
    const btn = h("button", { class: "btn primary" }, "Klonen");
    sheet.append(h("h2", null, "Maschine klonen"), h("p", { class: "sheet-sub" }, `Eine vollständige Kopie von „${name}“.`),
      h("div", { class: "stack" }, field("Name der Kopie", input({ value: d.name, oninput: (e) => { d.name = e.target.value.trim(); } })), field("Speicherort", sel),
        callout("info", null, "Die Kopie bekommt eine neue Netzwerk-Adresse (MAC). Läuft das Original, wird ein Snapshot-Stand kopiert, sofern der Speicher das kann.")),
      h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Abbrechen"), btn));
    try { sel.append(...(await storagesFor(type === "lxc" ? "rootdir" : "images")).map(s => h("option", { value: s.storage }, `${s.storage} · ${bytes(s.avail)} frei`))); } catch { /* egal */ }
    btn.addEventListener("click", () => withBusy(btn, async () => {
      if (!validHostname(d.name)) return toast("Ungültiger Name", "Buchstaben, Zahlen und Bindestriche.", "bad");
      try {
        const newid = await pve("GET", "/cluster/nextid");
        const body = { newid, full: 1, [type === "lxc" ? "hostname" : "name"]: d.name };
        if (sel.value) body.storage = sel.value;
        trackTask(await pve("POST", `${base}/clone`, body), `${name} klonen → ${d.name}`);
        close(); go(`guest/${type}/${newid}`);
      } catch (e) { errorToast(e); }
    }));
  });
}

function migrateSheet(type, base, name, others, statusFn, go) {
  openSheet((sheet, close) => {
    const sel = select(others.map(n => ({ value: n.node, label: n.node })), others[0].node);
    const running = statusFn().status === "running";
    const btn = h("button", { class: "btn primary" }, "Verschieben");
    btn.addEventListener("click", () => withBusy(btn, async () => {
      const body = { target: sel.value };
      if (running) body[type === "qemu" ? "online" : "restart"] = 1;
      try { trackTask(await pve("POST", `${base}/migrate`, body), `${name} → ${sel.value}`); close(); go("guests"); } catch (e) { errorToast(e); }
    }));
    sheet.append(h("h2", null, "Auf anderen Server verschieben"), field("Ziel-Server", sel),
      h("div", { style: { marginTop: "12px" } }, callout("info", null, running ? (type === "qemu" ? "Die VM läuft während des Verschiebens weiter (Live-Migration)." : "Der Container wird dabei kurz neu gestartet.") : "Die Maschine ist aus und wird einfach verschoben.")),
      h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Abbrechen"), btn));
  });
}

// ---------- Aufgaben-Verlauf ----------
export function historyCard(vmid) {
  const list = h("div", null, loader());
  (async () => {
    try {
      const tasks = await pve("GET", nodePath("/tasks"), { vmid, limit: 12 });
      clear(list).append(tasks.length ? h("div", { class: "card pad-0 flat" }, h("div", { class: "list" }, tasks.map(t => {
        const ok = t.status === "OK", running = !t.endtime;
        return h("div", { class: "list-item clickable", style: { minHeight: "50px" }, onclick: () => showTaskLog(t.upid, taskName(t.type)) },
          h("span", { style: { color: running ? "var(--accent)" : ok ? "var(--ok)" : "var(--bad)", display: "flex" } }, icon(running ? "spinner" : ok ? "checkCircle" : "xCircle", running ? "spin sm" : "sm")),
          h("div", { class: "grow" }, h("div", { class: "title", style: { fontWeight: 560 } }, taskName(t.type)), h("div", { class: "meta" }, `${relTime(t.starttime)} · ${t.user}${!ok && !running ? ` · ${t.status}` : ""}`)));
      }))) : h("div", { class: "muted small" }, "Noch keine Aufgaben."));
    } catch (e) { clear(list).append(callout("warn", null, e.message)); }
  })();
  return card("list", "Verlauf", list);
}
