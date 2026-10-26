import { h, icon, clear, pve, state, bytes, pct, uptime, meter, ring, num, guestIcon, callout, loader, nodePath, setUpdatesCount } from "../core.js";

function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? "Gute Nacht" : hr < 11 ? "Guten Morgen" : hr < 18 ? "Hallo" : "Guten Abend";
}

export async function renderDashboard({ page, el, go }) {
  const head = h("div", { class: "page-head" });
  const notices = h("div", { class: "stack", style: { marginBottom: "18px" } });
  const stats = h("div", { class: "grid cols-3" }, [0, 1, 2].map(() => h("div", { class: "card skeleton", style: { height: "122px" } })));
  const quick = h("div", { class: "quick" },
    quickLink("#/new", "plus", "Neue Maschine", "Container oder VM"),
    quickLink("#/apps", "apps", "App installieren", "Aus dem Katalog"),
    quickLink("#/backups", "archive", "Sichern", "Jetzt oder geplant"),
    quickLink("#/updates", "refresh", "Updates", "Proxmox aktuell halten"),
  );
  const active = h("div", { class: "card pad-0" }, loader());
  const storage = h("div", { class: "card pad-0" }, loader());

  el.append(head, notices, stats,
    h("h2", { class: "section" }, "Schnellzugriff"), quick,
    h("div", { class: "grid cols-2", style: { marginTop: "8px" } },
      h("div", null, h("h2", { class: "section" }, "Maschinen ", h("span", { class: "muted", id: "guest-count" })), active),
      h("div", null, h("h2", { class: "section" }, "Speicherplatz"), storage)),
  );

  let nodeStatus = null;
  async function loadStatic() {
    try { nodeStatus = await pve("GET", nodePath("/status")); } catch { nodeStatus = null; }
    // Hinweise: Updates und fehlende Sicherungen
    clear(notices);
    try {
      const upd = await pve("GET", nodePath("/apt/update"));
      setUpdatesCount(upd.length);
      if (upd.length) {
        notices.append(h("div", { class: "card clickable flat", onclick: () => go("updates"), style: { padding: "0" } },
          callout("info", `${upd.length} Update${upd.length === 1 ? "" : "s"} verfügbar`, "Tippe hier, um sie anzusehen und zu installieren.", "refresh")));
      }
    } catch { /* keine Rechte */ }
    try {
      const jobs = await pve("GET", "/cluster/backup");
      if (!jobs.length) {
        notices.append(h("div", { class: "card clickable flat", onclick: () => go("backups"), style: { padding: "0" } },
          callout("warn", "Noch keine automatische Sicherung", "Richte einen Zeitplan ein, damit deine Maschinen regelmäßig gesichert werden.", "shield")));
      }
    } catch { /* keine Rechte */ }
  }

  async function load() {
    let res;
    try { res = await pve("GET", "/cluster/resources"); }
    catch (e) { clear(stats).append(callout("bad", "Daten konnten nicht geladen werden", e.message)); return; }
    const node = res.find(r => r.type === "node" && r.node === state.node) || {};
    const guests = res.filter(r => (r.type === "qemu" || r.type === "lxc") && r.node === state.node && !r.template);
    const stores = res.filter(r => r.type === "storage" && r.node === state.node && r.status === "available");

    clear(head).append(h("div", null,
      h("h1", null, `${greeting()}, ${state.user.username.split("@")[0]}`),
      h("p", null, node.status === "online"
        ? `Server „${state.node}“ läuft seit ${uptime(node.uptime)}${nodeStatus?.pveversion ? " · " + nodeStatus.pveversion.split("/").slice(0, 2).join(" ").replace("pve-manager", "Proxmox VE") : ""}`
        : `Server „${state.node}“ ist nicht erreichbar`)));

    const cpuP = (node.cpu || 0) * 100;
    const memP = pct(node.mem, node.maxmem);
    const rootfs = nodeStatus?.rootfs;
    const diskP = rootfs ? pct(rootfs.used, rootfs.total) : pct(node.disk, node.maxdisk);
    clear(stats).append(
      statCard("cpu", "Prozessor", ring(cpuP), `${num(cpuP, 0)} %`,
        nodeStatus?.cpuinfo ? `${nodeStatus.cpuinfo.cpus} Kerne · Last ${nodeStatus.loadavg?.[0] ?? "–"}` : `${node.maxcpu || "?"} Kerne`),
      statCard("memory", "Arbeitsspeicher", ring(memP), bytes(node.mem), `von ${bytes(node.maxmem)}`),
      statCard("disk", "System-Festplatte", ring(diskP), bytes(rootfs?.used ?? node.disk), `von ${bytes(rootfs?.total ?? node.maxdisk)}`),
    );

    const running = guests.filter(g => g.status === "running");
    document.getElementById("guest-count")?.replaceChildren(`${running.length} von ${guests.length} laufen`);
    clear(active);
    if (!guests.length) {
      active.append(h("div", { class: "empty" }, h("div", { class: "e-ico" }, icon("server", "lg")), h("h3", null, "Noch keine Maschinen"),
        h("p", null, "Leg deine erste Maschine an oder installiere eine App."),
        h("a", { class: "btn primary", href: "#/new" }, icon("plus", "sm"), "Neu anlegen")));
    } else {
      const sorted = [...guests].sort((a, b) => (b.status === "running") - (a.status === "running") || (b.cpu || 0) - (a.cpu || 0)).slice(0, 7);
      active.append(h("div", { class: "list" }, sorted.map(g => {
        const memP2 = pct(g.mem, g.maxmem);
        return h("div", { class: "list-item clickable", onclick: () => go(`guest/${g.type}/${g.vmid}`) },
          guestIcon(g.type, g.status, g.name),
          h("div", { class: "grow" }, h("div", { class: "title" }, g.name || `#${g.vmid}`),
            h("div", { class: "meta" }, g.status === "running" ? `CPU ${num((g.cpu || 0) * 100, 0)} % · RAM ${bytes(g.mem)}` : "Ausgeschaltet")),
          g.status === "running" ? h("div", { style: { width: "70px" } }, meter(memP2, "thin")) : null,
          icon("chevronRight", "sm"));
      })), guests.length > 7 ? h("a", { class: "list-item clickable", href: "#/guests", style: { justifyContent: "center", fontWeight: 620 } }, `Alle ${guests.length} anzeigen`) : null);
    }

    clear(storage);
    if (!stores.length) storage.append(h("div", { class: "empty" }, h("p", null, "Keine Speicher gefunden.")));
    else storage.append(h("div", { class: "list" }, stores.sort((a, b) => a.storage.localeCompare(b.storage)).map(s => {
      const p = pct(s.disk, s.maxdisk);
      return h("div", { class: "list-item" },
        h("div", { class: "guest-icon" }, icon("disk")),
        h("div", { class: "grow" },
          h("div", { class: "row" }, h("div", { class: "title" }, s.storage), h("span", { class: "spacer" }), h("span", { class: "meta" }, `${bytes(s.disk)} / ${bytes(s.maxdisk)}`)),
          h("div", { style: { marginTop: "8px" } }, meter(p))));
    })));
  }

  await loadStatic();
  await load();
  page.every(5000, load);
  page.on("bpui:refresh", load);
}

function statCard(ico, label, ringEl, value, sub) {
  return h("div", { class: "card" }, h("div", { class: "row", style: { gap: "16px" } }, ringEl,
    h("div", { class: "stat" }, h("div", { class: "label" }, icon(ico, "sm"), label), h("div", { class: "value" }, value), h("div", { class: "sub" }, sub))));
}

function quickLink(href, ico, title, sub) {
  return h("a", { href }, h("div", { class: "q-ico" }, icon(ico)), h("div", null, title), h("span", { class: "muted" }, sub));
}

