import {
  h, icon, clear, pve, state, bytes, nodePath, enc, toast, errorToast, trackTask, openSheet, confirmDialog, field, input, select,
  toggle, segmented, withBusy, pageHead, callout, loader, empty, dateTime, relTime, guestIcon,
  backupDownloadBtn,
} from "../core.js";
import { backupNowSheet } from "./guests.js";

const DAYS = [["mon", "Montag"], ["tue", "Dienstag"], ["wed", "Mittwoch"], ["thu", "Donnerstag"], ["fri", "Freitag"], ["sat", "Samstag"], ["sun", "Sonntag"]];

function describeSchedule(s) {
  if (!s) return "–";
  s = s.trim();
  let m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return `Täglich um ${m[1].padStart(2, "0")}:${m[2]} Uhr`;
  m = s.match(/^([a-z]{3}) (\d{1,2}):(\d{2})$/);
  if (m) { const d = DAYS.find(x => x[0] === m[1]); if (d) return `Jeden ${d[1]} um ${m[2].padStart(2, "0")}:${m[3]} Uhr`; }
  m = s.match(/^mon\.\.fri (\d{1,2}):(\d{2})$/);
  if (m) return `Werktags um ${m[1].padStart(2, "0")}:${m[2]} Uhr`;
  if (s === "daily") return "Täglich um Mitternacht";
  if (s === "weekly") return "Wöchentlich (Montag 00:00)";
  return `Zeitplan: ${s}`;
}
function describeKeep(p) {
  if (!p) return "Aufbewahrung laut Speicher";
  const parts = Object.fromEntries(p.split(",").map(x => x.split("=")));
  const out = [];
  if (parts["keep-last"]) out.push(`letzte ${parts["keep-last"]}`);
  if (parts["keep-daily"]) out.push(`${parts["keep-daily"]} täglich`);
  if (parts["keep-weekly"]) out.push(`${parts["keep-weekly"]} wöchentlich`);
  if (parts["keep-monthly"]) out.push(`${parts["keep-monthly"]} monatlich`);
  if (parts["keep-all"] === "1") return "Alle behalten";
  return out.length ? `Behält ${out.join(", ")}` : p;
}

export async function renderBackups({ page, el }) {
  const nowBtn = h("button", { class: "btn primary" }, icon("archive", "sm"), "Jetzt sichern");
  el.append(pageHead("Sicherungen", "Damit nichts verloren geht – einmalig oder automatisch nach Zeitplan.", [nowBtn]));
  const schedCard = h("div", { class: "card pad-0" }, loader());
  const listBox = h("div", null, loader());
  el.append(h("h2", { class: "section" }, "Automatische Sicherung"), schedCard,
    h("h2", { class: "section" }, "Vorhandene Sicherungen"), listBox);

  let guests = [];
  let backupStores = [];
  const storeType = new Map();
  const nameOf = (vmid) => guests.find(g => String(g.vmid) === String(vmid))?.name;

  nowBtn.addEventListener("click", () => chooseGuestsSheet(guests));

  async function loadSchedules() {
    let jobs;
    try { jobs = await pve("GET", "/cluster/backup"); }
    catch (e) { clear(schedCard).append(h("div", { style: { padding: "18px" } }, callout("warn", null, `Zeitpläne nicht verfügbar: ${e.message}`))); return; }
    clear(schedCard);
    const addBtn = h("button", { class: "btn sm primary", onclick: () => scheduleSheet(backupStores, guests, loadSchedules) }, icon("plus", "sm"), "Zeitplan hinzufügen");
    if (!jobs.length) {
      schedCard.append(h("div", { class: "empty" }, h("div", { class: "e-ico" }, icon("calendar", "lg")), h("h3", null, "Noch kein Zeitplan"),
        h("p", null, "Empfehlung: jede Nacht alle Maschinen sichern und die letzten 7 Sicherungen behalten."), addBtn));
      return;
    }
    schedCard.append(h("div", { class: "list" }, jobs.map(j => {
      const what = j.all ? "Alle Maschinen" : j.vmid ? `Maschinen: ${String(j.vmid).split(",").map(v => nameOf(v) || v).join(", ")}` : (j.pool ? `Pool ${j.pool}` : "Auswahl");
      const sw = toggle(j.enabled === 0 || j.enabled === "0" ? "Aus" : "An", null, !(j.enabled === 0 || j.enabled === "0"), async (v) => {
        try { await pve("PUT", `/cluster/backup/${enc(j.id)}`, { enabled: v ? 1 : 0 }); toast(v ? "Zeitplan aktiviert" : "Zeitplan pausiert"); loadSchedules(); }
        catch (e) { errorToast(e); }
      });
      return h("div", { class: "list-item" },
        h("div", { class: "guest-icon" }, icon("calendar")),
        h("div", { class: "grow" }, h("div", { class: "title" }, describeSchedule(j.schedule || (j.starttime ? `${j.dow || ""} ${j.starttime}`.trim() : ""))),
          h("div", { class: "meta" }, `${what} → ${j.storage} · ${describeKeep(j["prune-backups"])}`)),
        h("div", { class: "end" }, sw,
          h("button", { class: "btn sm icon ghost", title: "Löschen", onclick: async () => {
            if (!await confirmDialog({ title: "Zeitplan löschen?", text: "Bereits vorhandene Sicherungen bleiben erhalten.", confirmText: "Löschen", danger: true })) return;
            try { await pve("DELETE", `/cluster/backup/${enc(j.id)}`); toast("Zeitplan gelöscht"); loadSchedules(); } catch (e) { errorToast(e); }
          } }, icon("trash", "sm"))));
    })), h("div", { style: { padding: "12px 18px", borderTop: "1px solid var(--line)" } }, addBtn));
  }

  async function loadBackups() {
    let all = [];
    for (const s of backupStores) {
      try {
        const items = await pve("GET", nodePath(`/storage/${enc(s.storage)}/content`), { content: "backup" });
        all.push(...items.map(i => ({ ...i, store: s.storage })));
        storeType.set(s.storage, s.type);
      } catch { /* egal */ }
    }
    clear(listBox);
    if (!backupStores.length) { listBox.append(callout("warn", "Kein Speicher für Sicherungen", "Aktiviere bei einem Speicher den Inhalt „VZDump-Backup“ – z. B. bei „local“ – oder binde einen Proxmox Backup Server ein.")); return; }
    if (!all.length) { listBox.append(h("div", { class: "card" }, empty("archive", "Noch keine Sicherungen", "Starte oben eine Sicherung oder richte einen Zeitplan ein."))); return; }
    const groups = {};
    for (const b of all) (groups[b.vmid ?? "?"] ||= []).push(b);
    const ids = Object.keys(groups).sort((a, b) => Number(a) - Number(b));
    for (const id of ids) {
      const items = groups[id].sort((a, b) => (b.ctime || 0) - (a.ctime || 0));
      const type = /vzdump-qemu|qemu/.test(items[0].volid) || items[0].subtype === "qemu" ? "qemu" : "lxc";
      const name = nameOf(id) || (items[0].notes || "").split("\n")[0] || `Maschine #${id}`;
      const exists = guests.some(g => String(g.vmid) === String(id));
      listBox.append(h("div", { class: "card pad-0", style: { marginBottom: "14px" } },
        h("div", { class: "list-item", style: { background: "var(--surface-2)" } }, guestIcon(type, exists ? guests.find(g => String(g.vmid) === String(id)).status : "", name),
          h("div", { class: "grow" }, h("div", { class: "title" }, name), h("div", { class: "meta" }, `#${id} · ${items.length} Sicherung${items.length === 1 ? "" : "en"}${exists ? "" : " · Maschine existiert nicht mehr"}`))),
        h("div", { class: "list" }, items.slice(0, 15).map(b => h("div", { class: "list-item" },
          h("div", { class: "grow" }, h("div", { class: "title", style: { fontWeight: 560 } }, dateTime(b.ctime), b.protected ? h("span", { class: "badge info", style: { marginLeft: "8px" } }, "geschützt") : null),
            h("div", { class: "meta" }, `${relTime(b.ctime)} · ${bytes(b.size)} · ${b.store}`)),
          h("div", { class: "end" },
            h("button", { class: "btn sm", title: "Wiederherstellen", onclick: () => restoreSheet(b, type, id, name, exists, guests) }, icon("restart", "sm"), h("span", { class: "hide-sm" }, "Wiederherstellen")),
            backupDownloadBtn(b, storeType.get(b.store)),
            h("button", { class: "btn sm icon ghost", title: "Löschen", onclick: async () => {
              if (b.protected) return toast("Geschützte Sicherung", "Diese Sicherung ist geschützt und kann nicht gelöscht werden.", "bad");
              if (!await confirmDialog({ title: "Sicherung löschen?", text: `Sicherung vom ${dateTime(b.ctime)} von „${name}“ wird endgültig gelöscht.`, confirmText: "Löschen", danger: true })) return;
              try { trackTask(await pve("DELETE", nodePath(`/storage/${enc(b.store)}/content/${enc(b.volid)}`)), "Sicherung löschen", { onDone: loadBackups }); }
              catch (e) { errorToast(e); }
            } }, icon("trash", "sm")))))),
        items.length > 15 ? h("div", { class: "muted small", style: { padding: "10px 18px" } }, `… und ${items.length - 15} ältere`) : null));
    }
  }

  try {
    const [res, stores] = await Promise.all([pve("GET", "/cluster/resources", { type: "vm" }), pve("GET", nodePath("/storage"), { content: "backup", enabled: 1 })]);
    guests = res.filter(g => g.node === state.node && !g.template).sort((a, b) => a.vmid - b.vmid);
    backupStores = stores;
  } catch (e) { errorToast(e); }
  await Promise.all([loadSchedules(), loadBackups()]);
  page.on("bpui:refresh", loadBackups);
}

function chooseGuestsSheet(guests) {
  if (!guests.length) return toast("Keine Maschinen vorhanden", "", "info");
  openSheet((sheet, close) => {
    const picked = new Set(guests.map(g => g.vmid));
    const rows = h("div", { class: "card pad-0 flat" }, guests.map(g => {
      const cb = h("input", { type: "checkbox" }); cb.checked = true;
      cb.addEventListener("change", () => { if (cb.checked) picked.add(g.vmid); else picked.delete(g.vmid); });
      return h("label", { class: "check-row" }, cb, h("div", { class: "grow" }, h("div", { style: { fontWeight: 600 } }, g.name || g.vmid), h("div", { class: "muted small" }, `#${g.vmid}`)));
    }));
    sheet.append(h("h2", null, "Was soll gesichert werden?"), h("p", { class: "sheet-sub" }, "Wähle die Maschinen aus."), rows,
      h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Abbrechen"),
        h("button", { class: "btn primary", onclick: () => {
          if (!picked.size) return toast("Bitte mindestens eine Maschine wählen", "", "bad");
          close();
          if (picked.size === guests.length) backupNowSheet([], true);
          else backupNowSheet(guests.filter(g => picked.has(g.vmid)));
        } }, "Weiter")));
  });
}

function scheduleSheet(stores, guests, onDone) {
  openSheet((sheet, close) => {
    if (!stores.length) {
      sheet.append(h("h2", null, "Zeitplan hinzufügen"), callout("warn", "Kein Speicher für Sicherungen", "Aktiviere zuerst bei einem Speicher den Inhalt „VZDump-Backup“."),
        h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Schließen")));
      return;
    }
    const d = { freq: "daily", day: "sun", time: "03:00", what: "all", keep: 7, storage: (stores.find(s => s.type === "pbs") || stores[0]).storage, mode: "snapshot" };
    const picked = new Set();
    const dayBox = h("div");
    const pickBox = h("div");
    const drawDay = () => { clear(dayBox); if (d.freq === "weekly") dayBox.append(field("Wochentag", select(DAYS.map(([v, l]) => ({ value: v, label: l })), d.day, { onchange: (e) => { d.day = e.target.value; } }))); };
    const drawPick = () => {
      clear(pickBox);
      if (d.what !== "pick") return;
      pickBox.append(h("div", { class: "card pad-0 flat" }, guests.map(g => {
        const cb = h("input", { type: "checkbox" }); cb.checked = picked.has(g.vmid);
        cb.addEventListener("change", () => { if (cb.checked) picked.add(g.vmid); else picked.delete(g.vmid); });
        return h("label", { class: "check-row" }, cb, h("div", null, h("div", { style: { fontWeight: 600 } }, g.name || g.vmid), h("div", { class: "muted small" }, `#${g.vmid}`)));
      })));
    };
    const btn = h("button", { class: "btn primary" }, "Zeitplan speichern");
    btn.addEventListener("click", () => withBusy(btn, async () => {
      if (!/^\d{2}:\d{2}$/.test(d.time)) return toast("Bitte eine Uhrzeit wählen", "", "bad");
      if (d.what === "pick" && !picked.size) return toast("Bitte mindestens eine Maschine wählen", "", "bad");
      const keep = Math.max(1, Math.min(365, Number(d.keep) || 7));
      const body = {
        schedule: d.freq === "daily" ? d.time : d.freq === "workdays" ? `mon..fri ${d.time}` : `${d.day} ${d.time}`,
        storage: d.storage, mode: d.mode, compress: "zstd", enabled: 1, "prune-backups": `keep-last=${keep}`,
        comment: "Angelegt mit Proxmox Zentrale",
      };
      if (d.what === "all") body.all = 1; else body.vmid = [...picked].join(",");
      try { await pve("POST", "/cluster/backup", body); close(); toast("Zeitplan gespeichert", describeSchedule(body.schedule)); onDone(); }
      catch (e) { errorToast(e); }
    }));
    sheet.append(h("h2", null, "Automatische Sicherung"), h("p", { class: "sheet-sub" }, "Proxmox sichert dann selbstständig – auch wenn diese Seite geschlossen ist."),
      h("div", { class: "stack", style: { gap: "16px" } },
        field("Wie oft?", segmented([{ value: "daily", label: "Täglich" }, { value: "workdays", label: "Werktags" }, { value: "weekly", label: "Wöchentlich" }], d.freq, (v) => { d.freq = v; drawDay(); })),
        dayBox,
        h("div", { class: "form-grid" },
          field("Uhrzeit", input({ type: "time", value: d.time, oninput: (e) => { d.time = e.target.value; } }), "Am besten nachts, wenn niemand den Server braucht."),
          field("Wie viele aufbewahren?", input({ type: "number", min: 1, max: 365, value: d.keep, oninput: (e) => { d.keep = e.target.value; } }), "Ältere werden automatisch gelöscht.")),
        field("Was sichern?", segmented([{ value: "all", label: "Alle Maschinen" }, { value: "pick", label: "Auswahl" }], d.what, (v) => { d.what = v; drawPick(); }), "„Alle“ schließt auch später angelegte Maschinen mit ein."),
        pickBox,
        field("Speicherort", select(stores.map(s => ({ value: s.storage, label: `${s.storage} · ${bytes(s.avail)} frei` })), d.storage, { onchange: (e) => { d.storage = e.target.value; } })),
      ),
      h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Abbrechen"), btn));
    drawDay(); drawPick();
  });
}

function restoreSheet(b, type, vmid, name, exists, guests) {
  openSheet(async (sheet, close) => {
    let mode = "new";
    let start = false;
    const storeSel = select([{ value: "", label: "Lade …" }], "");
    const warnBox = h("div");
    const drawWarn = () => {
      clear(warnBox);
      if (mode === "replace") warnBox.append(callout("bad", "Achtung", `Die aktuelle Maschine „${name}“ wird komplett durch den Stand vom ${dateTime(b.ctime)} ersetzt. Sie muss dafür ausgeschaltet sein.`));
    };
    const btn = h("button", { class: "btn primary" }, "Wiederherstellen");
    sheet.append(h("h2", null, "Wiederherstellen"), h("p", { class: "sheet-sub" }, `${name} · Stand ${dateTime(b.ctime)}`),
      h("div", { class: "stack", style: { gap: "16px" } },
        exists ? field("Wie?", segmented([{ value: "new", label: "Als neue Maschine" }, { value: "replace", label: "Original ersetzen" }], mode, (v) => { mode = v; drawWarn(); }),
          "„Als neue Maschine“ ist ungefährlich – das Original bleibt unverändert.") : callout("info", null, "Die ursprüngliche Maschine gibt es nicht mehr – sie wird unter ihrer alten Nummer neu angelegt, sofern frei."),
        warnBox,
        field("Speicherort", storeSel, "Wo die Festplatte der Maschine liegen soll."),
        toggle("Danach starten", null, false, (v) => { start = v; })),
      h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Abbrechen"), btn));
    try {
      const stores = await pve("GET", nodePath("/storage"), { content: type === "lxc" ? "rootdir" : "images", enabled: 1 });
      clear(storeSel);
      for (const s of stores) storeSel.append(h("option", { value: s.storage }, `${s.storage} · ${bytes(s.avail)} frei`));
      const pref = stores.find(s => s.storage === "local-lvm") || stores.find(s => s.storage === "local-zfs");
      if (pref) storeSel.value = pref.storage;
    } catch (e) { errorToast(e); }

    btn.addEventListener("click", () => withBusy(btn, async () => {
      let target = vmid;
      if (mode === "replace") {
        const g = guests.find(x => String(x.vmid) === String(vmid));
        if (g && g.status === "running") return toast("Bitte die Maschine zuerst ausschalten", "", "bad");
        if (!await confirmDialog({ title: "Original wirklich ersetzen?", text: "Der aktuelle Stand geht verloren.", confirmText: "Ersetzen", danger: true, typeToConfirm: name })) return;
      } else if (exists) {
        target = await pve("GET", "/cluster/nextid");
      }
      const body = { vmid: target, storage: storeSel.value, start: start ? 1 : 0 };
      if (mode === "replace") body.force = 1;
      if (mode === "new" && exists) body.unique = 1;
      try {
        let upid;
        if (type === "lxc") upid = await pve("POST", nodePath("/lxc"), { ...body, ostemplate: b.volid, restore: 1 });
        else upid = await pve("POST", nodePath("/qemu"), { ...body, archive: b.volid });
        close();
        trackTask(upid, `${name} wiederherstellen${mode === "new" && exists ? ` als #${target}` : ""}`);
      } catch (e) { errorToast(e); }
    }));
  });
}
