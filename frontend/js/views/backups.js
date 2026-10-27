// ===========================================================================
// Sicherungen: Seite, Zeitpläne (auch pro Dienst), Liste, Wiederherstellen
// ===========================================================================
import {
  h, icon, clear, pve, state, bytes, nodePath, enc, toast, errorToast, trackTask, openSheet, confirmDialog, field, input, select,
  toggle, segmented, withBusy, pageHead, callout, loader, empty, dateTime, relTime, guestIcon, backupDownloadBtn,
} from "../core.js";
import { backupNowSheet } from "./guests.js";

const DAYS = [["mon", "Montag"], ["tue", "Dienstag"], ["wed", "Mittwoch"], ["thu", "Donnerstag"], ["fri", "Freitag"], ["sat", "Samstag"], ["sun", "Sonntag"]];
const pad = (x) => String(x).padStart(2, "0");

// ---------------------------------------------------------------------------
// Zeitpläne verstehen
// ---------------------------------------------------------------------------
export function parseSchedule(s) {
  s = String(s || "").trim();
  let m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return { freq: "daily", time: `${pad(m[1])}:${m[2]}` };
  m = s.match(/^mon\.\.fri (\d{1,2}):(\d{2})$/);
  if (m) return { freq: "workdays", time: `${pad(m[1])}:${m[2]}` };
  m = s.match(/^([a-z]{3}) (\d{1,2}):(\d{2})$/);
  if (m && DAYS.some(d => d[0] === m[1])) return { freq: "weekly", day: m[1], time: `${pad(m[2])}:${m[3]}` };
  m = s.match(/^0\/(\d{1,2}):(\d{2})$/);
  if (m) return { freq: "hours", every: Number(m[1]), time: `00:${m[2]}` };
  if (s === "daily") return { freq: "daily", time: "00:00" };
  return null;
}

export function describeSchedule(s) {
  const p = parseSchedule(s);
  if (!p) return s ? `Zeitplan: ${s}` : "–";
  if (p.freq === "daily") return `Täglich um ${p.time} Uhr`;
  if (p.freq === "workdays") return `Werktags um ${p.time} Uhr`;
  if (p.freq === "weekly") return `Jeden ${DAYS.find(d => d[0] === p.day)[1]} um ${p.time} Uhr`;
  return `Alle ${p.every} Stunden`;
}

export function describeKeep(p) {
  if (!p) return "Aufbewahrung laut Speicher";
  const parts = Object.fromEntries(String(p).split(",").map(x => x.split("=")));
  if (parts["keep-all"] === "1") return "Alle behalten";
  const out = [];
  if (parts["keep-last"]) out.push(`letzte ${parts["keep-last"]}`);
  if (parts["keep-daily"]) out.push(`${parts["keep-daily"]} täglich`);
  if (parts["keep-weekly"]) out.push(`${parts["keep-weekly"]} wöchentlich`);
  if (parts["keep-monthly"]) out.push(`${parts["keep-monthly"]} monatlich`);
  return out.length ? `Behält ${out.join(", ")}` : p;
}

const jobEnabled = (j) => !(j.enabled === 0 || j.enabled === "0");
const jobSchedule = (j) => j.schedule || (j.starttime ? `${j.dow || ""} ${j.starttime}`.trim() : "");
const jobVmids = (j) => String(j.vmid || "").split(",").map(v => v.trim()).filter(Boolean);
const jobExcludes = (j) => String(j.exclude || "").split(",").map(v => v.trim()).filter(Boolean);

/** Welche aktiven Zeitpläne sichern diese Maschine? */
export function jobsCovering(jobs, vmid) {
  vmid = String(vmid);
  return (jobs || []).filter(j => jobEnabled(j) && (j.all ? !jobExcludes(j).includes(vmid) : jobVmids(j).includes(vmid)));
}
const isOwnJob = (j, vmid) => !j.all && jobVmids(j).length === 1 && jobVmids(j)[0] === String(vmid);

// ---------------------------------------------------------------------------
// Zeitplan anlegen / bearbeiten – für alle, eine Auswahl oder genau einen Dienst
// ---------------------------------------------------------------------------
export function openScheduleSheet({ stores, guests = [], job = null, fixed = null, onDone }) {
  openSheet((sheet, close) => {
    if (!stores.length) {
      sheet.append(h("h2", null, "Automatische Sicherung"), callout("warn", "Kein Speicher für Sicherungen", "Aktiviere zuerst bei einem Speicher den Inhalt „VZDump-Backup“ – oder verbinde unter „Speicher & NAS“ eine NAS-Freigabe für Sicherungen."),
        h("div", { class: "sheet-foot" }, h("a", { class: "btn", href: "#/storage", onclick: () => close() }, "Speicher & NAS"), h("button", { class: "btn primary", onclick: () => close() }, "OK")));
      return;
    }
    const parsed = job ? parseSchedule(jobSchedule(job)) : null;
    const keepMatch = job ? String(job["prune-backups"] || "").match(/keep-last=(\d+)/) : null;
    const preferred = stores.find(s => s.type === "pbs") || stores.find(s => ["cifs", "nfs"].includes(s.type)) || stores[0];
    const d = {
      freq: parsed?.freq || "daily", day: parsed?.day || "sun", time: parsed?.time || "03:00", every: parsed?.every || 6,
      keep: keepMatch ? Number(keepMatch[1]) : 7, storage: job?.storage || preferred.storage, mode: job?.mode || "snapshot",
      what: job ? (job.all ? "all" : "pick") : "all", touched: false,
    };
    const picked = new Set(job ? jobVmids(job).map(Number) : []);
    const custom = job && !parsed;

    const freqBox = h("div", { class: "stack", style: { gap: "16px" } });
    const drawFreq = () => {
      clear(freqBox);
      if (d.freq === "weekly") freqBox.append(field("Wochentag", select(DAYS.map(([v, l]) => ({ value: v, label: l })), d.day, { onchange: (e) => { d.day = e.target.value; d.touched = true; } })));
      if (d.freq === "hours") freqBox.append(field("Abstand", select([2, 3, 4, 6, 8, 12].map(n => ({ value: n, label: `Alle ${n} Stunden` })), d.every, { onchange: (e) => { d.every = Number(e.target.value); d.touched = true; } }),
        "Sinnvoll für Dienste, deren Daten sich ständig ändern – braucht aber mehr Speicherplatz."));
      else freqBox.append(field("Uhrzeit", input({ type: "time", value: d.time, oninput: (e) => { d.time = e.target.value; d.touched = true; } }), "Am besten nachts, wenn niemand den Dienst braucht."));
    };
    const pickBox = h("div");
    const drawPick = () => {
      clear(pickBox);
      if (fixed || d.what !== "pick") return;
      pickBox.append(h("div", { class: "card pad-0 flat", style: { maxHeight: "260px", overflow: "auto" } }, guests.map(g => {
        const cb = h("input", { type: "checkbox" }); cb.checked = picked.has(g.vmid);
        cb.addEventListener("change", () => { if (cb.checked) picked.add(g.vmid); else picked.delete(g.vmid); });
        return h("label", { class: "check-row" }, cb, h("span", { style: { transform: "scale(.75)", display: "inline-flex", margin: "-6px" } }, guestIcon(g.type, g.status, g.name)),
          h("div", null, h("div", { style: { fontWeight: 600 } }, g.name || g.vmid), h("div", { class: "muted small" }, `#${g.vmid}`)));
      })));
    };

    const btn = h("button", { class: "btn primary" }, icon("check", "sm"), job ? "Speichern" : "Einrichten");
    btn.addEventListener("click", () => withBusy(btn, async () => {
      if (d.freq !== "hours" && !/^\d{2}:\d{2}$/.test(d.time)) return toast("Bitte eine Uhrzeit wählen", "", "bad");
      if (!fixed && d.what === "pick" && !picked.size) return toast("Bitte mindestens eine Maschine wählen", "", "bad");
      const keep = Math.max(1, Math.min(365, Number(d.keep) || 7));
      const schedule = d.freq === "daily" ? d.time : d.freq === "workdays" ? `mon..fri ${d.time}` : d.freq === "weekly" ? `${d.day} ${d.time}` : `0/${d.every}:00`;
      const body = { schedule, storage: d.storage, mode: d.mode, compress: "zstd", enabled: 1, "prune-backups": `keep-last=${keep}` };
      if (fixed) { body.vmid = String(fixed.vmid); body.comment = `Proxmox Zentrale: ${fixed.name}`; }
      else if (d.what === "all") body.all = 1;
      else { body.vmid = [...picked].join(","); }
      if (!job && !fixed) body.comment = "Angelegt mit Proxmox Zentrale";
      try {
        if (job) {
          if (custom && !d.touched) delete body.schedule;  // von Hand angelegter Zeitplan bleibt, solange nichts daran geändert wurde
          if (!fixed && d.what === "all") body.delete = "vmid"; else if (!fixed && job.all) body.all = 0;
          await pve("PUT", `/cluster/backup/${enc(job.id)}`, body);
        } else await pve("POST", "/cluster/backup", body);
        close();
        toast(job ? "Zeitplan gespeichert" : "Automatische Sicherung eingerichtet", `${describeSchedule(body.schedule || jobSchedule(job))} · behält die letzten ${keep}`);
        onDone && onDone();
      } catch (e) { errorToast(e); }
    }));

    sheet.append(
      h("h2", null, fixed ? `„${fixed.name}“ regelmäßig sichern` : job ? "Zeitplan bearbeiten" : "Automatische Sicherung"),
      h("p", { class: "sheet-sub" }, "Proxmox sichert dann selbstständig – auch wenn diese Seite geschlossen ist."),
      h("div", { class: "stack", style: { gap: "16px" } },
        custom ? callout("info", null, `Dieser Zeitplan ist von Hand angelegt („${jobSchedule(job)}“). Wenn du hier eine Häufigkeit wählst, wird er ersetzt.`) : null,
        field("Wie oft?", segmented([{ value: "daily", label: "Täglich" }, { value: "workdays", label: "Werktags" }, { value: "weekly", label: "Wöchentlich" }, { value: "hours", label: "Mehrmals" }],
          d.freq, (v) => { d.freq = v; d.touched = true; drawFreq(); })),
        freqBox,
        field("Wie viele Sicherungen aufbewahren?", select([3, 5, 7, 14, 30, 60].map(n => ({ value: n, label: `Die letzten ${n}` })).concat([3, 5, 7, 14, 30, 60].includes(d.keep) ? [] : [{ value: d.keep, label: `Die letzten ${d.keep}` }]), d.keep,
          { onchange: (e) => { d.keep = Number(e.target.value); } }), "Ältere werden automatisch gelöscht, damit der Speicher nicht vollläuft."),
        fixed ? null : field("Was sichern?", segmented([{ value: "all", label: "Alle Maschinen" }, { value: "pick", label: "Auswahl" }], d.what, (v) => { d.what = v; drawPick(); }), "„Alle“ schließt auch später angelegte Maschinen mit ein."),
        pickBox,
        field("Speicherort", select(stores.map(s => ({ value: s.storage, label: `${s.storage} · ${bytes(s.avail)} frei${["cifs", "nfs", "pbs"].includes(s.type) ? " · NAS/extern" : ""}` })), d.storage,
          { onchange: (e) => { d.storage = e.target.value; } }), "Am sichersten auf einer NAS oder einem Backup-Server – nicht auf dem Server selbst."),
        h("details", null, h("summary", { style: { cursor: "pointer", fontWeight: 620 } }, "Erweitert"),
          h("div", { style: { marginTop: "12px" } }, field("Art der Sicherung", select([
            { value: "snapshot", label: "Im laufenden Betrieb (empfohlen)" }, { value: "suspend", label: "Kurz pausieren" },
            { value: "stop", label: "Für die Sicherung ausschalten (am sichersten)" }], d.mode, { onchange: (e) => { d.mode = e.target.value; } }))))),
      h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Abbrechen"), btn));
    drawFreq(); drawPick();
  });
}

// ---------------------------------------------------------------------------
// Liste der Sicherungen (für alle oder genau einen Dienst)
// ---------------------------------------------------------------------------
export async function loadBackupItems(stores, vmid) {
  const all = [];
  await Promise.all(stores.map(async s => {
    try {
      const items = await pve("GET", nodePath(`/storage/${enc(s.storage)}/content`), vmid ? { content: "backup", vmid } : { content: "backup" });
      all.push(...items.map(i => ({ ...i, store: s.storage, storeType: s.type })));
    } catch { /* Speicher nicht erreichbar */ }
  }));
  return all.sort((a, b) => (b.ctime || 0) - (a.ctime || 0));
}

function backupRow(b, ctx) {
  const { type, id, name, exists, guests, onChange } = ctx;
  return h("div", { class: "list-item" },
    h("div", { class: "grow" },
      h("div", { class: "title", style: { fontWeight: 560 } }, dateTime(b.ctime), b.protected ? h("span", { class: "badge info", style: { marginLeft: "8px" } }, "geschützt") : null),
      h("div", { class: "meta" }, `${relTime(b.ctime)} · ${bytes(b.size)} · ${b.store}`)),
    h("div", { class: "end" },
      h("button", { class: "btn sm", title: "Wiederherstellen", onclick: () => restoreSheet(b, type, id, name, exists, guests) }, icon("restart", "sm"), h("span", { class: "hide-sm" }, "Wiederherstellen")),
      backupDownloadBtn(b, b.storeType),
      h("button", { class: "btn sm icon ghost", title: "Löschen", onclick: async () => {
        if (b.protected) return toast("Geschützte Sicherung", "Diese Sicherung ist geschützt und kann nicht gelöscht werden.", "bad");
        if (!await confirmDialog({ title: "Sicherung löschen?", text: `Sicherung vom ${dateTime(b.ctime)} von „${name}“ wird endgültig gelöscht.`, confirmText: "Löschen", danger: true })) return;
        try { trackTask(await pve("DELETE", nodePath(`/storage/${enc(b.store)}/content/${enc(b.volid)}`)), "Sicherung löschen", { onDone: onChange }); }
        catch (e) { errorToast(e); }
      } }, icon("trash", "sm"))));
}

function backupGroup(id, items, guests, onChange, { header = true, limit = 15 } = {}) {
  const g = guests.find(x => String(x.vmid) === String(id));
  const type = g?.type || (/vzdump-qemu/.test(items[0].volid) || items[0].subtype === "qemu" ? "qemu" : "lxc");
  const name = g?.name || (items[0].notes || "").split("\n")[0] || `Maschine #${id}`;
  const ctx = { type, id, name, exists: !!g, guests, onChange };
  let shown = limit;
  const list = h("div", { class: "list" });
  const more = h("div");
  const draw = () => {
    clear(list).append(items.slice(0, shown).map(b => backupRow(b, ctx)));
    clear(more);
    if (items.length > shown) more.append(h("button", { class: "btn ghost block", style: { borderRadius: 0, borderTop: "1px solid var(--line)" }, onclick: () => { shown += 30; draw(); } }, `${items.length - shown} ältere anzeigen`));
  };
  draw();
  return h("div", { class: "card pad-0", style: { marginBottom: "14px" } },
    header ? h("a", { class: "list-item clickable", href: g ? `#/guest/${type}/${id}/sicherungen` : null, style: { background: "var(--surface-2)", color: "var(--text)" } },
      guestIcon(type, g?.status || "", name),
      h("div", { class: "grow" }, h("div", { class: "title" }, name), h("div", { class: "meta" }, `#${id} · ${items.length} Sicherung${items.length === 1 ? "" : "en"}${g ? "" : " · Maschine existiert nicht mehr"}`)),
      g ? icon("chevronRight", "sm") : null) : null,
    list, more);
}

// ---------------------------------------------------------------------------
// Bereich „Sicherungen“ in der Detailansicht eines Dienstes
// ---------------------------------------------------------------------------
export function guestBackupSection(guest, { onScheduleChange } = {}) {
  const wrap = h("div");
  const schedCard = h("div", { class: "card" }, loader());
  const listWrap = h("div", null, loader());
  const nowBtn = h("button", { class: "btn primary sm" }, icon("archive", "sm"), "Jetzt sichern");
  nowBtn.addEventListener("click", () => backupNowSheet([{ vmid: guest.vmid, name: guest.name }]));
  wrap.append(schedCard,
    h("div", { class: "row", style: { margin: "26px 0 12px" } }, h("h2", { class: "section", style: { margin: 0 } }, "Vorhandene Sicherungen"), h("span", { class: "spacer" }), nowBtn),
    listWrap);

  let stores = [], guests = [];
  async function loadSchedule() {
    let jobs;
    try { jobs = await pve("GET", "/cluster/backup"); } catch (e) { clear(schedCard).append(callout("warn", null, `Zeitpläne nicht verfügbar: ${e.message}`)); return; }
    const covering = jobsCovering(jobs, guest.vmid);
    const own = jobs.filter(j => isOwnJob(j, guest.vmid));
    const shared = covering.filter(j => !isOwnJob(j, guest.vmid));
    const pausedOwn = own.filter(j => !jobEnabled(j));
    const setup = () => openScheduleSheet({ stores, guests, fixed: guest, onDone: () => { loadSchedule(); onScheduleChange && onScheduleChange(); } });

    const rows = [];
    for (const j of own) {
      const sw = toggle(jobEnabled(j) ? "An" : "Pausiert", null, jobEnabled(j), async (v) => {
        try { await pve("PUT", `/cluster/backup/${enc(j.id)}`, { enabled: v ? 1 : 0 }); toast(v ? "Automatische Sicherung aktiv" : "Automatische Sicherung pausiert"); loadSchedule(); onScheduleChange && onScheduleChange(); }
        catch (e) { errorToast(e); }
      });
      rows.push(h("div", { class: "list-item wrap-sm" },
        h("div", { class: "guest-icon" }, icon("calendar")),
        h("div", { class: "grow" }, h("div", { class: "title" }, describeSchedule(jobSchedule(j))), h("div", { class: "meta", style: { whiteSpace: "normal" } }, `Nur dieser Dienst → ${j.storage} · ${describeKeep(j["prune-backups"])}`)),
        h("div", { class: "end" }, sw,
          h("button", { class: "btn sm", onclick: () => openScheduleSheet({ stores, guests, job: j, fixed: guest, onDone: () => { loadSchedule(); onScheduleChange && onScheduleChange(); } }) }, icon("edit", "sm"), h("span", { class: "hide-sm" }, "Ändern")),
          h("button", { class: "btn sm icon ghost", title: "Zeitplan löschen", onclick: async () => {
            if (!await confirmDialog({ title: "Zeitplan löschen?", text: `„${guest.name}“ wird dann nicht mehr automatisch gesichert. Vorhandene Sicherungen bleiben erhalten.`, confirmText: "Löschen", danger: true })) return;
            try { await pve("DELETE", `/cluster/backup/${enc(j.id)}`); toast("Zeitplan gelöscht"); loadSchedule(); onScheduleChange && onScheduleChange(); } catch (e) { errorToast(e); }
          } }, icon("trash", "sm")))));
    }
    for (const j of shared) {
      const others = j.all ? "alle Maschinen" : `${jobVmids(j).length} Maschinen`;
      const leave = h("button", { class: "btn sm ghost", title: "Diesen Dienst aus dem gemeinsamen Zeitplan herausnehmen" }, h("span", null, "Herausnehmen"));
      leave.addEventListener("click", async () => {
        if (!await confirmDialog({ title: "Aus dem gemeinsamen Zeitplan herausnehmen?", text: `„${guest.name}“ wird dann nicht mehr mit ${others} zusammen gesichert. Die anderen Maschinen sind nicht betroffen.`, confirmText: "Herausnehmen" })) return;
        try {
          if (j.all) await pve("PUT", `/cluster/backup/${enc(j.id)}`, { exclude: [...jobExcludes(j), String(guest.vmid)].join(",") });
          else {
            const rest = jobVmids(j).filter(v => v !== String(guest.vmid));
            if (rest.length) await pve("PUT", `/cluster/backup/${enc(j.id)}`, { vmid: rest.join(",") });
            else await pve("DELETE", `/cluster/backup/${enc(j.id)}`);
          }
          toast("Herausgenommen"); loadSchedule(); onScheduleChange && onScheduleChange();
        } catch (e) { errorToast(e); }
      });
      rows.push(h("div", { class: "list-item wrap-sm" },
        h("div", { class: "guest-icon" }, icon("calendar")),
        h("div", { class: "grow" }, h("div", { class: "title" }, describeSchedule(jobSchedule(j))), h("div", { class: "meta", style: { whiteSpace: "normal" } }, `Gemeinsamer Zeitplan für ${others} → ${j.storage} · ${describeKeep(j["prune-backups"])}`)),
        h("div", { class: "end" }, leave)));
    }

    const covered = covering.length > 0;
    clear(schedCard).append(
      h("div", { class: "card-head" }, icon("calendar"), h("h3", null, "Automatisch sichern")),
      covered ? callout("ok", "Wird regelmäßig gesichert", covering.length > 1 ? `${covering.length} Zeitpläne sichern diesen Dienst.` : null, "shield")
        : callout("warn", pausedOwn.length ? "Automatische Sicherung ist pausiert" : "Wird nicht automatisch gesichert", "Richte einen Zeitplan ein – dann sichert Proxmox diesen Dienst selbstständig, z. B. jede Nacht.", "alert"),
      rows.length ? h("div", { class: "card pad-0 flat", style: { marginTop: "12px" } }, h("div", { class: "list" }, rows)) : null,
      h("div", { class: "row wrap", style: { marginTop: "12px" } },
        !own.length ? h("button", { class: `btn ${covered ? "" : "primary"}`, onclick: setup }, icon("plus", "sm"), covered ? "Zusätzlicher eigener Zeitplan" : "Regelmäßig sichern")
          : h("button", { class: "btn sm ghost", onclick: setup }, icon("plus", "sm"), "Weiteren Zeitplan hinzufügen"),
        h("a", { class: "btn sm ghost", href: "#/backups" }, "Alle Zeitpläne")));
  }

  async function loadList() {
    const items = await loadBackupItems(stores, guest.vmid);
    clear(listWrap);
    if (!stores.length) { listWrap.append(callout("warn", "Kein Speicher für Sicherungen", "Aktiviere bei einem Speicher den Inhalt „VZDump-Backup“ oder verbinde unter „Speicher & NAS“ eine NAS.")); return; }
    if (!items.length) { listWrap.append(h("div", { class: "card" }, empty("archive", "Noch keine Sicherung", `Für „${guest.name}“ gibt es noch keine Sicherung. Starte jetzt eine oder richte oben einen Zeitplan ein.`))); return; }
    listWrap.append(backupGroup(guest.vmid, items, guests, loadList, { header: false, limit: 10 }));
  }

  (async () => {
    try {
      const [st, res] = await Promise.all([pve("GET", nodePath("/storage"), { content: "backup", enabled: 1 }), pve("GET", "/cluster/resources", { type: "vm" })]);
      stores = st; guests = res.filter(g => g.node === state.node && !g.template);
    } catch (e) { errorToast(e); }
    await Promise.all([loadSchedule(), loadList()]);
  })();
  window.addEventListener("bpui:refresh", function onR() { if (!wrap.isConnected) return window.removeEventListener("bpui:refresh", onR); loadList(); });
  return wrap;
}

// ---------------------------------------------------------------------------
// Seite „Sicherungen“ (optional gefiltert auf einen Dienst: #/backups/<vmid>)
// ---------------------------------------------------------------------------
export async function renderBackups({ page, el, go }, filterVmid) {
  const filter = /^\d+$/.test(filterVmid || "") ? String(filterVmid) : null;
  const nowBtn = h("button", { class: "btn primary" }, icon("archive", "sm"), "Jetzt sichern");
  const head = pageHead("Sicherungen", "Damit nichts verloren geht – einmalig oder automatisch nach Zeitplan.", [nowBtn]);
  const filterBar = h("div");
  const schedCard = h("div", { class: "card pad-0" }, loader());
  const listBox = h("div", null, loader());
  el.append(head, filterBar, h("h2", { class: "section" }, "Automatische Sicherung"), schedCard, h("h2", { class: "section" }, "Vorhandene Sicherungen"), listBox);

  let guests = [], stores = [];
  const nameOf = (vmid) => guests.find(g => String(g.vmid) === String(vmid))?.name;
  nowBtn.addEventListener("click", () => {
    if (filter) { const g = guests.find(x => String(x.vmid) === filter); return backupNowSheet([{ vmid: Number(filter), name: g?.name || filter }]); }
    chooseGuestsSheet(guests);
  });

  async function loadSchedules() {
    let jobs;
    try { jobs = await pve("GET", "/cluster/backup"); }
    catch (e) { clear(schedCard).append(h("div", { style: { padding: "18px" } }, callout("warn", null, `Zeitpläne nicht verfügbar: ${e.message}`))); return; }
    if (filter) jobs = jobs.filter(j => j.all ? !jobExcludes(j).includes(filter) : jobVmids(j).includes(filter));
    clear(schedCard);
    const addBtn = h("button", { class: "btn sm primary", onclick: () => {
      const g = filter && guests.find(x => String(x.vmid) === filter);
      openScheduleSheet({ stores, guests, fixed: g ? { vmid: g.vmid, name: g.name } : null, onDone: loadSchedules });
    } }, icon("plus", "sm"), filter ? "Zeitplan für diesen Dienst" : "Zeitplan hinzufügen");
    if (!jobs.length) {
      schedCard.append(h("div", { class: "empty" }, h("div", { class: "e-ico" }, icon("calendar", "lg")), h("h3", null, "Noch kein Zeitplan"),
        h("p", null, filter ? "Dieser Dienst wird nicht automatisch gesichert." : "Empfehlung: jede Nacht alle Maschinen sichern und die letzten 7 Sicherungen behalten."), addBtn));
      return;
    }
    schedCard.append(h("div", { class: "list" }, jobs.map(j => {
      const what = j.all ? `Alle Maschinen${jobExcludes(j).length ? ` außer ${jobExcludes(j).map(v => nameOf(v) || v).join(", ")}` : ""}`
        : j.vmid ? jobVmids(j).map(v => nameOf(v) || `#${v}`).join(", ") : (j.pool ? `Pool ${j.pool}` : "Auswahl");
      const sw = toggle(jobEnabled(j) ? "An" : "Aus", null, jobEnabled(j), async (v) => {
        try { await pve("PUT", `/cluster/backup/${enc(j.id)}`, { enabled: v ? 1 : 0 }); toast(v ? "Zeitplan aktiviert" : "Zeitplan pausiert"); loadSchedules(); }
        catch (e) { errorToast(e); }
      });
      const single = !j.all && jobVmids(j).length === 1 ? guests.find(g => String(g.vmid) === jobVmids(j)[0]) : null;
      return h("div", { class: "list-item wrap-sm" },
        single ? guestIcon(single.type, single.status, single.name) : h("div", { class: "guest-icon" }, icon("calendar")),
        h("div", { class: "grow" }, h("div", { class: "title" }, describeSchedule(jobSchedule(j))),
          h("div", { class: "meta", style: { whiteSpace: "normal" } }, `${what} → ${j.storage} · ${describeKeep(j["prune-backups"])}`)),
        h("div", { class: "end" }, sw,
          h("button", { class: "btn sm icon ghost", title: "Bearbeiten", onclick: () => openScheduleSheet({ stores, guests, job: j, fixed: single ? { vmid: single.vmid, name: single.name } : null, onDone: loadSchedules }) }, icon("edit", "sm")),
          h("button", { class: "btn sm icon ghost", title: "Löschen", onclick: async () => {
            if (!await confirmDialog({ title: "Zeitplan löschen?", text: "Bereits vorhandene Sicherungen bleiben erhalten.", confirmText: "Löschen", danger: true })) return;
            try { await pve("DELETE", `/cluster/backup/${enc(j.id)}`); toast("Zeitplan gelöscht"); loadSchedules(); } catch (e) { errorToast(e); }
          } }, icon("trash", "sm"))));
    })), h("div", { style: { padding: "12px 18px", borderTop: "1px solid var(--line)" } }, addBtn));
  }

  async function loadBackups() {
    const all = await loadBackupItems(stores, filter);
    clear(listBox);
    if (!stores.length) { listBox.append(callout("warn", "Kein Speicher für Sicherungen", "Aktiviere bei einem Speicher den Inhalt „VZDump-Backup“ – z. B. bei „local“ – oder verbinde unter „Speicher & NAS“ eine NAS.")); return; }
    if (!all.length) { listBox.append(h("div", { class: "card" }, empty("archive", "Noch keine Sicherungen", "Starte oben eine Sicherung oder richte einen Zeitplan ein."))); return; }
    const groups = {};
    for (const b of all) (groups[b.vmid ?? "?"] ||= []).push(b);
    for (const id of Object.keys(groups).sort((a, b) => Number(a) - Number(b))) listBox.append(backupGroup(id, groups[id], guests, loadBackups, { header: !filter }));
  }

  try {
    const [res, st] = await Promise.all([pve("GET", "/cluster/resources", { type: "vm" }), pve("GET", nodePath("/storage"), { content: "backup", enabled: 1 })]);
    guests = res.filter(g => g.node === state.node && !g.template).sort((a, b) => a.vmid - b.vmid);
    stores = st;
  } catch (e) { errorToast(e); }

  if (filter) {
    const g = guests.find(x => String(x.vmid) === filter);
    head.querySelector("h1").textContent = `Sicherungen von ${g?.name || `#${filter}`}`;
    head.querySelector("p").textContent = "Nur die Sicherungen und Zeitpläne dieses Dienstes.";
    filterBar.append(h("div", { class: "row wrap", style: { gap: "8px", marginBottom: "6px" } },
      g ? h("a", { class: "btn sm", href: `#/guest/${g.type}/${g.vmid}` }, icon("chevronLeft", "sm"), `Zurück zu ${g.name}`) : null,
      h("a", { class: "btn sm ghost", href: "#/backups" }, "Alle Sicherungen anzeigen")));
  }
  await Promise.all([loadSchedules(), loadBackups()]);
  page.on("bpui:refresh", loadBackups);
  void go;
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

export function restoreSheet(b, type, vmid, name, exists, guests) {
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
