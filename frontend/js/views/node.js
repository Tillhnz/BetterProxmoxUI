// ===========================================================================
// Server: Systeminfos, Dienste, Protokoll, Festplatten, Netzwerk, Konsole
// ===========================================================================
import {
  h, icon, clear, api, pve, state, bytes, uptime, nodePath, enc, errorToast, trackTask, openSheet, confirmDialog,
  withBusy, pageHead, callout, loader, segmented,
} from "../core.js";
import { tlsCard } from "./tls.js";

const SERVICE_DE = {
  pveproxy: "Weboberfläche (Proxmox)", pvedaemon: "Proxmox-Hintergrunddienst", pvestatd: "Statistik-Sammler", "pve-cluster": "Cluster-Dateisystem",
  pve_firewall: "Firewall", "pve-firewall": "Firewall", pvefw_logger: "Firewall-Protokoll", "pve-ha-crm": "Hochverfügbarkeit (Manager)", "pve-ha-lrm": "Hochverfügbarkeit (lokal)",
  spiceproxy: "SPICE-Konsole", sshd: "SSH-Zugang", cron: "Zeitgesteuerte Aufgaben", postfix: "E-Mail-Versand", chrony: "Zeitsynchronisation",
  systemd_timesyncd: "Zeitsynchronisation", corosync: "Cluster-Kommunikation", "proxmox-firewall": "Firewall (neu)", syslog: "Systemprotokoll", "systemd-journald": "Systemprotokoll",
  ksmtuned: "Speicher-Optimierung (KSM)", "lxcfs": "Container-Hilfsdienst", "qmeventd": "VM-Ereignisse", "pvescheduler": "Zeitplaner (Sicherungen)",
};

export async function renderNode({ page, el, go }) {
  el.append(pageHead("Server", `Technik und Einstellungen von „${state.node}“.`));
  const info = h("div", { class: "card" }, loader());
  const tabs = h("div", { style: { margin: "18px 0 14px" } });
  const body = h("div");
  el.append(info, tlsCard(), tabs, body);

  // ---------- Kopf: Systeminfos & Aktionen ----------
  (async () => {
    let st, ver, dns, time;
    try { [st, ver, dns, time] = await Promise.all([pve("GET", nodePath("/status")), pve("GET", nodePath("/version")).catch(() => null), pve("GET", nodePath("/dns")).catch(() => null), pve("GET", nodePath("/time")).catch(() => null)]); }
    catch (e) { clear(info).append(callout("bad", null, e.message)); return; }
    const kv = (k, v) => h("div", null, h("span", null, k), h("strong", null, v ?? "–"));
    const consoleBtn = h("button", { class: "btn", disabled: !state.user.host_admin }, icon("terminal", "sm"), "Host-Konsole");
    consoleBtn.addEventListener("click", () => withBusy(consoleBtn, async () => {
      if (!await confirmDialog({ title: "Host-Konsole öffnen?", text: "Du bekommst eine root-Kommandozeile direkt auf dem Proxmox-Server. Dort ist alles erlaubt – Befehle mit Bedacht eingeben.", confirmText: "Öffnen" })) return;
      try { const r = await api("/jobs", { method: "POST", body: { kind: "shell" } }); go(`job/${r.data.id}`); } catch (e) { errorToast(e); }
    }));
    clear(info).append(
      h("div", { class: "row wrap", style: { gap: "14px", marginBottom: "16px" } },
        h("div", { class: "guest-icon ct", style: { width: "52px", height: "52px", borderRadius: "15px" } }, icon("server", "lg")),
        h("div", { style: { flex: 1, minWidth: "200px" } }, h("h3", { style: { fontSize: "18px" } }, state.node),
          h("div", { class: "muted" }, `Proxmox VE ${ver?.version || ""} · läuft seit ${uptime(st.uptime)}`)),
        h("div", { class: "action-bar" }, consoleBtn, h("a", { class: "btn", href: `https://${location.hostname}:8006/`, target: "_blank", rel: "noopener" }, icon("external", "sm"), "Proxmox-Oberfläche"))),
      h("div", { class: "kv" },
        kv("Prozessor", st.cpuinfo ? `${st.cpuinfo.model}` : "–"),
        kv("Kerne / Threads", st.cpuinfo ? (st.cpuinfo.cores ? `${st.cpuinfo.cores * (st.cpuinfo.sockets || 1)} / ${st.cpuinfo.cpus}` : `${st.cpuinfo.cpus} Threads`) : "–"),
        kv("Arbeitsspeicher", st.memory ? `${bytes(st.memory.used)} von ${bytes(st.memory.total)}` : "–"),
        kv("Auslagerung (Swap)", st.swap ? `${bytes(st.swap.used)} von ${bytes(st.swap.total)}` : "–"),
        kv("Last (1/5/15 Min.)", (st.loadavg || []).join(" / ")),
        kv("Kernel", st["current-kernel"]?.release || st.kversion?.split(" ")[2]),
        kv("Startmodus", st["boot-info"]?.mode === "efi" ? `UEFI${st["boot-info"].secureboot ? " (Secure Boot)" : ""}` : st["boot-info"]?.mode ? "BIOS" : "–"),
        kv("Zeitzone", time?.timezone),
        kv("DNS-Server", dns ? [dns.dns1, dns.dns2, dns.dns3].filter(Boolean).join(", ") : "–"),
        kv("Suchdomäne", dns?.search)));
  })();

  // ---------- Reiter ----------
  let tab = "services";
  const views = { services: drawServices, log: drawLog, disks: drawDisks, network: drawNetwork, more: drawMore };
  tabs.append(h("div", { style: { overflowX: "auto" } }, segmented([
    { value: "services", label: "Dienste" }, { value: "log", label: "Protokoll" }, { value: "disks", label: "Festplatten" },
    { value: "network", label: "Netzwerk" }, { value: "more", label: "Mehr" }], tab, (v) => { tab = v; views[v](); })));

  async function drawServices() {
    clear(body).append(loader());
    let list;
    try { list = await pve("GET", nodePath("/services")); } catch (e) { clear(body).append(callout("bad", null, e.message)); return; }
    list.sort((a, b) => (a.state === "running" ? 0 : 1) - (b.state === "running" ? 0 : 1) || a.name.localeCompare(b.name));
    clear(body).append(h("div", { class: "card pad-0" }, h("div", { class: "list" }, list.map(s => {
      const running = s.state === "running";
      const act = (cmd, label) => h("button", { class: "btn sm", onclick: async () => {
        if (!await confirmDialog({ title: `${s.name}: ${label}?`, text: s.service === "pveproxy" ? "Die Proxmox-Weboberfläche ist dabei kurz nicht erreichbar." : `Dienst „${SERVICE_DE[s.service] || s.desc || s.name}“.`, confirmText: label })) return;
        try { trackTask(await pve("POST", nodePath(`/services/${enc(s.service)}/${cmd}`)), `${s.name} ${label.toLowerCase()}`, { onDone: drawServices }); } catch (e) { errorToast(e); }
      } }, label);
      return h("div", { class: "list-item" },
        h("span", { class: `status-dot ${running ? "running" : ""}`, style: running ? null : { background: s["unit-state"] === "disabled" ? "var(--line-strong)" : "var(--bad)" } }),
        h("div", { class: "grow" }, h("div", { class: "title" }, SERVICE_DE[s.service] || s.desc || s.name), h("div", { class: "meta mono" }, s.name)),
        h("div", { class: "end" }, running ? act("restart", "Neu starten") : act("start", "Starten")));
    }))));
  }

  async function drawLog() {
    clear(body);
    let n = 200;
    let filter = "";
    const pre = h("div", { class: "log", style: { maxHeight: "65vh" } }, "Lade …");
    const search = h("input", { class: "input", placeholder: "Filtern, z. B. error oder backup", oninput: (e) => { filter = e.target.value.toLowerCase(); show(); } });
    let lines = [];
    const show = () => { pre.textContent = (filter ? lines.filter(l => l.toLowerCase().includes(filter)) : lines).join("\n") || "(keine Einträge)"; pre.scrollTop = pre.scrollHeight; };
    async function load() {
      try { lines = await pve("GET", nodePath("/journal"), { lastentries: n }); }
      catch { try { lines = (await pve("GET", nodePath("/syslog"), { limit: n })).map(l => l.t); } catch (e) { pre.textContent = e.message; return; } }
      show();
    }
    body.append(h("div", { class: "card" },
      h("div", { class: "row wrap", style: { gap: "10px", marginBottom: "12px" } }, h("div", { style: { flex: 1, minWidth: "200px" } }, search),
        h("button", { class: "btn", onclick: (e) => withBusy(e.currentTarget, load) }, icon("refresh", "sm"), "Aktualisieren"),
        h("button", { class: "btn", onclick: (e) => { n += 500; withBusy(e.currentTarget, load); } }, "Mehr laden")),
      pre, h("p", { class: "muted small" }, "Systemprotokoll des Servers (neueste Einträge unten). Hilfreich, wenn etwas nicht funktioniert.")));
    load();
  }

  async function drawDisks() {
    clear(body).append(loader());
    let disks = [], zfs = [];
    try { [disks, zfs] = await Promise.all([pve("GET", nodePath("/disks/list")), pve("GET", nodePath("/disks/zfs")).catch(() => [])]); }
    catch (e) { clear(body).append(callout("bad", null, e.message)); return; }
    clear(body);
    body.append(h("div", { class: "card pad-0" }, h("div", { class: "list" }, disks.map(d => {
      const health = String(d.health || "").toUpperCase();
      const ok = health === "PASSED" || health === "OK";
      return h("div", { class: "list-item clickable", onclick: () => smartSheet(d) },
        h("div", { class: "guest-icon" }, icon("disk")),
        h("div", { class: "grow" }, h("div", { class: "title" }, d.model || d.devpath),
          h("div", { class: "meta" }, `${d.devpath} · ${bytes(d.size)} · ${String(d.type || "").toUpperCase()}${d.used ? ` · ${d.used}` : " · ungenutzt"}${typeof d.wearout === "number" && d.type !== "hdd" ? ` · Verschleiß ${100 - d.wearout} %` : ""}`)),
        h("span", { class: `badge ${ok ? "ok" : health === "UNKNOWN" || !health ? "" : "bad"}` }, ok ? "Gesund" : health || "?"));
    }))));
    if (zfs.length) body.append(h("h2", { class: "section" }, "ZFS-Pools"), h("div", { class: "card pad-0" }, h("div", { class: "list" }, zfs.map(z =>
      h("div", { class: "list-item" }, h("div", { class: "guest-icon" }, icon("archive")),
        h("div", { class: "grow" }, h("div", { class: "title" }, z.name), h("div", { class: "meta" }, `${bytes(z.alloc)} von ${bytes(z.size)} belegt · Fragmentierung ${z.frag ?? "?"} %`)),
        h("span", { class: `badge ${z.health === "ONLINE" ? "ok" : "bad"}` }, z.health))))));
    body.append(h("p", { class: "muted small", style: { marginTop: "12px" } }, "Tippe auf eine Festplatte für die SMART-Werte. Festplatten einrichten oder löschen geht bewusst nur in der Proxmox-Oberfläche."));
  }

  function smartSheet(d) {
    openSheet(async (sheet, close) => {
      const pre = h("div", { class: "log" }, "Lade SMART-Werte …");
      sheet.append(h("h2", null, d.model || d.devpath), h("p", { class: "sheet-sub" }, `${d.devpath} · Seriennummer ${d.serial || "?"}`), pre,
        h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Schließen")));
      try {
        const s = await pve("GET", nodePath("/disks/smart"), { disk: d.devpath });
        pre.textContent = s.text || (s.attributes || []).map(a => `${String(a.name).padEnd(28)} ${String(a.value).padStart(4)}  roh: ${a.raw}`).join("\n") || `Zustand: ${s.health}`;
      } catch (e) { pre.textContent = e.message; }
    }, { wide: true });
  }

  async function drawNetwork() {
    clear(body).append(loader());
    let ifs;
    try { ifs = await pve("GET", nodePath("/network")); } catch (e) { clear(body).append(callout("bad", null, e.message)); return; }
    const TYPE = { bridge: "Netzwerk-Brücke", OVSBridge: "OVS-Brücke", eth: "Netzwerkkarte", bond: "Bündelung", vlan: "VLAN", alias: "Alias" };
    ifs.sort((a, b) => (a.type === "bridge" ? 0 : 1) - (b.type === "bridge" ? 0 : 1) || a.iface.localeCompare(b.iface));
    clear(body).append(
      h("div", { class: "card pad-0" }, h("div", { class: "list" }, ifs.map(i => h("div", { class: "list-item" },
        h("div", { class: "guest-icon" }, icon("network")),
        h("div", { class: "grow" }, h("div", { class: "row", style: { gap: "8px" } }, h("div", { class: "title" }, i.iface), h("span", { class: "badge" }, TYPE[i.type] || i.type)),
          h("div", { class: "meta" }, [i.cidr || i.address, i.gateway ? `Gateway ${i.gateway}` : null, i.bridge_ports ? `über ${i.bridge_ports}` : null, i.comments].filter(Boolean).join(" · ") || "ohne IP-Adresse")),
        h("span", { class: `badge ${i.active ? "ok" : ""}` }, i.active ? "Aktiv" : "Inaktiv"))))),
      h("div", { style: { marginTop: "14px" } }, callout("warn", "Bewusst nur zum Ansehen", "Ein Fehler in der Netzwerk-Einstellung macht den Server unerreichbar. Änderungen deshalb in der Proxmox-Oberfläche (Server → System → Netzwerk) und nur, wenn du weißt, was du tust.")));
  }

  function drawMore() {
    const base = `https://${location.hostname}:8006/`;
    const item = (ico, title, text) => h("a", { class: "list-item clickable", href: base, target: "_blank", rel: "noopener", style: { color: "var(--text)" } },
      h("div", { class: "guest-icon" }, icon(ico)), h("div", { class: "grow" }, h("div", { class: "title" }, title), h("div", { class: "meta", style: { whiteSpace: "normal" } }, text)), icon("external", "sm"));
    clear(body).append(
      h("p", { class: "muted" }, "Diese Profi-Funktionen braucht man im Heimnetz selten. Sie öffnen sich in der normalen Proxmox-Oberfläche:"),
      h("div", { class: "card pad-0" }, h("div", { class: "list" },
        item("server", "Cluster & Hochverfügbarkeit", "Mehrere Server verbinden, Maschinen bei Ausfall automatisch umziehen (Rechenzentrum → Cluster / HA)."),
        item("shield", "Firewall-Regeln", "Regeln für Server und Maschinen (Rechenzentrum → Firewall)."),
        item("network", "Netzwerk ändern & SDN", "Brücken, VLANs und virtuelle Netze (Server → System → Netzwerk, Rechenzentrum → SDN)."),
        item("disk", "Festplatten einrichten, ZFS, LVM, Ceph", "Neue Festplatten initialisieren und Speicher-Pools anlegen (Server → Datenträger)."),
        item("refresh", "Replikation", "Maschinen regelmäßig auf einen zweiten Server spiegeln."),
        item("info", "Benachrichtigungen & Metrik-Server", "E-Mail bei Fehlern, Statistiken an InfluxDB/Graphite senden (Rechenzentrum)."),
        item("lock", "Zertifikate (Let's Encrypt)", "Ein echtes HTTPS-Zertifikat einrichten (Server → System → Zertifikate)."),
        item("user", "Pools & API-Tokens", "Maschinen gruppieren und Zugriffsschlüssel für Skripte."))));
  }

  drawServices();
}
