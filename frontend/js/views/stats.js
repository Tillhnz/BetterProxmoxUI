// ===========================================================================
// Statistik: Verlauf von Server, Speichern und Maschinen
// ===========================================================================
import {
  h, clear, pve, state, bytes, nodePath, enc, pageHead, callout, loader, segmented, lineChart, chartCard, rrd, TIMEFRAMES,
  guestIcon, num,
} from "../core.js";

export const C = { cpu: "#ff7a45", io: "#c77dff", mem: "#6f9bff", memTotal: "#7f8897", in: "#34c784", out: "#ff7a45", load: "#e8b23a", disk: "#2ec4c4", read: "#6f9bff", write: "#ff5c8a" };
export const fmtPct = (v) => `${num(v, v < 10 ? 1 : 0)} %`;
export const fmtBytes = (v) => bytes(v);
export const fmtRate = (v) => `${bytes(v)}/s`;

export function guestCharts(rows, type) {
  return [
    chartCard("Prozessor", lineChart(rows, [{ key: "cpu", label: "Auslastung", color: C.cpu, fn: r => typeof r.cpu === "number" ? r.cpu * 100 : null }], { fmt: fmtPct, max: 100 })),
    chartCard("Arbeitsspeicher", lineChart(rows, [
      { key: "mem", label: "Belegt", color: C.mem },
      { key: "maxmem", label: "Zugeteilt", color: C.memTotal }], { fmt: fmtBytes })),
    chartCard("Netzwerk", lineChart(rows, [{ key: "netin", label: "Empfangen", color: C.in }, { key: "netout", label: "Gesendet", color: C.out }], { fmt: fmtRate })),
    chartCard("Festplatte", lineChart(rows, [{ key: "diskread", label: "Lesen", color: C.read }, { key: "diskwrite", label: "Schreiben", color: C.write }], { fmt: fmtRate })),
  ];
}

export async function renderStats({ page, el, go }) {
  let tf = "day";
  el.append(pageHead("Statistik", "Wie stark dein Server und deine Dienste ausgelastet sind."));
  const tfBar = h("div", { style: { marginBottom: "16px", maxWidth: "520px" } }, segmented(TIMEFRAMES, tf, (v) => { tf = v; load(); }));
  const body = h("div", null, loader());
  el.append(tfBar, body);
  let token = 0;

  async function load() {
    const my = ++token;
    clear(body).append(loader());
    let nodeRows = [], res = [], stores = [];
    try {
      [nodeRows, res, stores] = await Promise.all([rrd(nodePath("/rrddata"), tf), pve("GET", "/cluster/resources"), pve("GET", nodePath("/storage"), { enabled: 1 })]);
    } catch (e) { clear(body).append(callout("bad", "Laden fehlgeschlagen", e.message)); return; }
    if (my !== token) return;
    const guests = res.filter(r => (r.type === "qemu" || r.type === "lxc") && r.node === state.node && !r.template);
    clear(body);

    body.append(h("h2", { class: "section", style: { marginTop: 0 } }, `Server „${state.node}“`),
      h("div", { class: "grid charts" },
        chartCard("Prozessor", lineChart(nodeRows, [
          { key: "cpu", label: "Auslastung", color: C.cpu, fn: r => typeof r.cpu === "number" ? r.cpu * 100 : null },
          { key: "iowait", label: "Warten auf Festplatte", color: C.io, fn: r => typeof r.iowait === "number" ? r.iowait * 100 : null }], { fmt: fmtPct, max: 100 })),
        chartCard("Arbeitsspeicher", lineChart(nodeRows, [
          { key: "memused", label: "Belegt", color: C.mem },
          { key: "memtotal", label: "Vorhanden", color: C.memTotal },
          { key: "swapused", label: "Auslagerung (Swap)", color: C.io }], { fmt: fmtBytes })),
        chartCard("Netzwerk", lineChart(nodeRows, [{ key: "netin", label: "Empfangen", color: C.in }, { key: "netout", label: "Gesendet", color: C.out }], { fmt: fmtRate })),
        chartCard("Systemlast", lineChart(nodeRows, [{ key: "loadavg", label: "Last (Ø 1 Min.)", color: C.load }], { fmt: (v) => num(v, 1) }),
          "Faustregel: dauerhaft über der Anzahl Kerne = überlastet"),
        chartCard("System-Festplatte", lineChart(nodeRows, [{ key: "rootused", label: "Belegt", color: C.disk }, { key: "roottotal", label: "Größe", color: C.memTotal }], { fmt: fmtBytes }))));

    // Speicher
    const active = stores.filter(s => s.active);
    if (active.length) {
      const grid = h("div", { class: "grid charts" });
      body.append(h("h2", { class: "section" }, "Speicherplatz-Verlauf"), grid);
      await Promise.all(active.slice(0, 6).map(async s => {
        let rows = [];
        try { rows = await rrd(nodePath(`/storage/${enc(s.storage)}/rrddata`), tf === "hour" ? "day" : tf); } catch { /* egal */ }
        if (my !== token) return;
        grid.append(chartCard(s.storage, lineChart(rows, [{ key: "used", label: "Belegt", color: C.disk }, { key: "total", label: "Größe", color: C.memTotal }], { fmt: fmtBytes, height: 130 })));
      }));
    }

    // Rangliste der Maschinen
    if (guests.length) {
      const table = h("div", { class: "card pad-0" }, loader());
      body.append(h("h2", { class: "section" }, "Wer verbraucht am meisten?", h("span", { class: "muted" }, "Durchschnitt im Zeitraum")), table);
      const stats = [];
      for (let i = 0; i < guests.length; i += 5) {
        await Promise.all(guests.slice(i, i + 5).map(async g => {
          let rows = [];
          try { rows = await rrd(nodePath(`/${g.type}/${g.vmid}/rrddata`), tf); } catch { /* egal */ }
          const avg = (k, f = (r) => r[k]) => { const v = rows.map(f).filter(x => typeof x === "number" && !isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
          stats.push({ g, cpu: avg("cpu") * 100, cores: g.maxcpu, mem: avg("mem"), maxmem: g.maxmem, net: avg("netin") + avg("netout"), io: avg("diskread") + avg("diskwrite") });
        }));
        if (my !== token) return;
      }
      let sortKey = "cpu";
      const drawTable = () => {
        stats.sort((a, b) => b[sortKey] - a[sortKey]);
        const th = (k, label) => h("th", { style: { cursor: "pointer", color: sortKey === k ? "var(--accent)" : null }, onclick: () => { sortKey = k; drawTable(); } }, label, sortKey === k ? " ↓" : "");
        clear(table).append(h("div", { class: "table-wrap" }, h("table", { class: "table" },
          h("thead", null, h("tr", null, h("th", null, "Maschine"), th("cpu", "CPU"), th("mem", "RAM"), th("net", "Netzwerk"), th("io", "Festplatte"))),
          h("tbody", null, stats.map(s => h("tr", { style: { cursor: "pointer" }, onclick: () => go(`guest/${s.g.type}/${s.g.vmid}`) },
            h("td", null, h("div", { class: "row", style: { gap: "10px" } }, h("span", { style: { transform: "scale(.8)", display: "inline-flex", margin: "-4px" } }, guestIcon(s.g.type, s.g.status, s.g.name)), h("strong", null, s.g.name))),
            h("td", null, `${num(s.cpu, 1)} %`, h("div", { class: "muted small" }, `von ${s.cores} Kern${s.cores === 1 ? "" : "en"}`)),
            h("td", null, bytes(s.mem), h("div", { class: "muted small" }, `von ${bytes(s.maxmem)}`)),
            h("td", null, `${bytes(s.net)}/s`),
            h("td", null, `${bytes(s.io)}/s`)))))));
      };
      drawTable();
    }
  }
  await load();
  page.every(60000, () => { if (tf === "hour") load(); });
}
