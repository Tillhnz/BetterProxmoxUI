// ===========================================================================
// Umwandlungs-Assistent: VM → Container (LXC)
// Übernimmt Kerne, RAM, Netzwerk (gleiche MAC/IP), Laufwerke und NAS-Freigaben.
// ===========================================================================
import {
  h, icon, clear, api, state, bytes, toast, errorToast, confirmDialog, withBusy, field, input, select, toggle,
  segmented, callout, loader, pageHead, appAvatar,
} from "../core.js";

const GB = 1024 ** 3;
const sizeFor = (used, min = 2) => Math.max(min, Math.ceil(((used || 0) * 1.3) / GB) + 2);

export async function renderConvert({ el, go }, vmid) {
  el.append(h("a", { class: "back", href: `#/guest/qemu/${vmid}` }, icon("chevronLeft", "sm"), "Zurück zur VM"),
    pageHead("VM in Container umwandeln", "Ein Container braucht weniger Arbeitsspeicher, startet schneller und kann Ordner vom Server direkt nutzen."));
  if (!state.user.host_admin) {
    el.append(callout("info", "Nur für root@pam", "Für die Umwandlung werden die Festplatten der VM auf dem Server gelesen."));
    return;
  }
  const body = h("div", { class: "stack" }, h("div", { class: "card" }, h("div", { class: "row muted" }, icon("spinner", "spin sm"),
    "Analysiere die VM … (bei ausgeschalteter VM wird ihre Festplatte gelesen, das dauert bis zu einer Minute)")));
  el.append(body);

  let a;
  try { a = (await api(`/convert/${vmid}`)).data; }
  catch (e) { clear(body).append(callout("bad", "Analyse fehlgeschlagen", e.message)); return; }
  clear(body);

  const card = (ico, title, ...children) => h("div", { class: "card" }, h("div", { class: "card-head" }, icon(ico), h("h3", null, title)), ...children);

  // ---------- Überblick ----------
  body.append(card("search", "Was gefunden wurde",
    h("div", { class: "row wrap", style: { gap: "12px", marginBottom: "12px" } },
      appAvatar(a.immich ? "immich" : (a.os.id || "linux"), a.name, { size: 46 }),
      h("div", { class: "grow" }, h("strong", { style: { fontSize: "17px" } }, a.name), h("div", { class: "muted" },
        `${a.os.name || "Linux"} · ${a.cores} Kerne · ${bytes(a.memory * 1024 ** 2)} RAM · ${a.mode === "agent" ? "gelesen über den Gast-Agenten" : "Festplatte direkt gelesen"}`)),
      a.immich ? h("span", { class: "badge accent" }, "Immich erkannt") : null,
      a.docker ? h("span", { class: "badge" }, "Docker") : null),
    ...(a.leftovers ? [] : a.blockers).map(b => h("div", { style: { marginBottom: "8px" } }, callout("bad", "Geht so nicht", b))),
    ...a.warnings.map(w => h("div", { style: { marginBottom: "8px" } }, callout("warn", null, w)))));
  if (a.leftovers) {
    const lo = a.leftovers;
    let startVm = true;
    const items = [
      lo.processes.length ? "Die Umwandlung läuft im Hintergrund noch (hängt vermutlich) – sie wird beendet." : null,
      lo.mounts.length || lo.loops.length || lo.nbds.length ? "Die Festplatten der VM sind noch auf dem Server eingehängt – sie werden freigegeben." : null,
      lo.ct ? `Container ${lo.ct.ctid} ist nur halb angelegt – er wird gelöscht.` : null,
    ].filter(Boolean);
    const btn = h("button", { class: "btn primary" }, icon("refresh", "sm"), "Aufräumen");
    btn.addEventListener("click", () => withBusy(btn, async () => {
      try { const r = await api(`/convert/${vmid}/cleanup`, { method: "POST", body: { start_vm: startVm } }); go(`job/${r.data.id}`); }
      catch (e) { errorToast(e); }
    }));
    body.append(card("alert", "Reste einer abgebrochenen Umwandlung",
      h("ul", { class: "plain-list", style: { marginTop: 0 } }, items.map(t => h("li", null, t))),
      h("p", { class: "muted small" }, "Die VM selbst wird dabei nicht verändert."),
      a.status !== "running" ? toggle("VM danach wieder starten", "Damit Immich & Co. bis zum nächsten Versuch wieder laufen.", startVm, v => { startVm = v; }) : null,
      h("div", { class: "row wrap", style: { marginTop: "10px" } }, btn)));
    return;
  }
  if (a.blockers.length) return;

  // ---------- Plan (vorbelegt wie die VM) ----------
  const free = a.storages.slice().sort((x, y) => (y.storage === "local-lvm") - (x.storage === "local-lvm") || y.avail - x.avail);
  const ipOf = (mac) => a.ips[(mac || "").toUpperCase()] || null;
  const p = {
    ctid: a.nextid, hostname: a.name.replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || `ct${a.nextid}`,
    cores: a.cores, memory: a.memory, swap: 512, onboot: a.onboot, start: true, dri: a.immich && a.dri,
    storage: free[0]?.storage, rootfs_gb: sizeFor(a.root?.used, 8),
    nics: a.nics.map(n => {
      const ip = ipOf(n.mac);
      return { bridge: n.bridge, mac: n.mac, keepMac: true, tag: n.tag, firewall: n.firewall, mode: ip ? "static" : "dhcp", ip: ip || "", gw: a.gateway || "" };
    }),
    mounts: a.mounts.map(m => m.kind === "disk"
      ? { target: m.target, action: "copy", size_gb: sizeFor(m.used) }
      // Gehört die vorhandene Server-Freigabe „root“, könnte der Container nur lesen → lieber passend neu einhängen
      : { target: m.target, action: m.host_path && !m.host_owner_root ? "bind" : "mount", host_path: m.host_path || "" }),
  };

  // Container
  const num = (v, on, attrs = {}) => input({ type: "number", value: v, oninput: (e) => on(Number(e.target.value)), ...attrs });
  body.append(card("box", "Container",
    h("div", { class: "grid cols-2" },
      field("Name", input({ value: p.hostname, oninput: (e) => { p.hostname = e.target.value.trim(); } })),
      field("Nummer", num(p.ctid, v => { p.ctid = v; }, { min: 100 }), `Die VM behält ihre Nummer ${a.vmid}.`),
      field("Prozessor-Kerne", num(p.cores, v => { p.cores = v; }, { min: 1 }), "Wie bei der VM"),
      field("Arbeitsspeicher (MB)", num(p.memory, v => { p.memory = v; }, { min: 128, step: 256 }),
        "Wie bei der VM. Container brauchen meist weniger – später unter Statistik prüfen.")),
    h("div", { class: "stack", style: { marginTop: "6px" } },
      toggle("Beim Hochfahren des Servers starten", "Die VM startet danach nicht mehr automatisch.", p.onboot, v => { p.onboot = v; }),
      toggle("Container danach gleich starten", a.compose.length ? "Startet auch die Docker-Apps wieder." : "", p.start, v => { p.start = v; }))));

  // Laufwerke
  const storageSel = select(free.map(s => ({ value: s.storage, label: `${s.storage} · ${bytes(s.avail)} frei` })), p.storage,
    { onchange: (e) => { p.storage = e.target.value; } });
  const diskRows = a.mounts.filter(m => m.kind === "disk").map(m => {
    const c = p.mounts.find(x => x.target === m.target);
    const size = num(c.size_gb, v => { c.size_gb = v; }, { min: 1, style: { width: "110px" } });
    return h("div", { class: "list-item wrap-sm" }, h("div", { class: "guest-icon" }, icon("disk")),
      h("div", { class: "grow" }, h("div", { class: "title" }, m.target), h("div", { class: "meta" }, `eigenes Laufwerk der VM · belegt ${bytes(m.used || 0)}`)),
      h("div", { class: "row conv-ctl", style: { gap: "8px" } }, size, h("span", { class: "muted" }, "GB"),
        segmented([{ value: "copy", label: "Kopieren" }, { value: "skip", label: "Weglassen" }], c.action, v => { c.action = v; size.disabled = v === "skip"; })));
  });
  body.append(card("disk", "Laufwerke",
    field("Speicherort für den Container", storageSel),
    h("div", { class: "card pad-0 flat", style: { marginTop: "4px" } }, h("div", { class: "list" },
      h("div", { class: "list-item wrap-sm" }, h("div", { class: "guest-icon" }, icon("server")),
        h("div", { class: "grow" }, h("div", { class: "title" }, "System ( / )"), h("div", { class: "meta" }, `belegt ${bytes(a.root?.used || 0)} – ohne Docker-Images und Zwischenspeicher`)),
        h("div", { class: "row conv-ctl", style: { gap: "8px" } }, num(p.rootfs_gb, v => { p.rootfs_gb = v; }, { min: 4, style: { width: "110px" } }), h("span", { class: "muted" }, "GB"))),
      diskRows)),
    h("p", { class: "muted small", style: { marginTop: "8px" } }, "Größen sind mit Reserve vorgeschlagen und lassen sich später vergrößern.")));

  // NAS
  const nas = a.mounts.filter(m => m.kind === "nas");
  if (nas.length) {
    body.append(card("network", "NAS-Freigaben",
      h("p", { class: "muted", style: { marginTop: "-6px" } }, "Container dürfen Freigaben nicht selbst einhängen. Stattdessen hängt der Server sie ein und reicht den Ordner an den Container weiter – unter demselben Pfad wie in der VM."),
      ...nas.map(m => {
        const c = p.mounts.find(x => x.target === m.target);
        const hp = input({ value: c.host_path, placeholder: "/mnt/pve/…", oninput: (e) => { c.host_path = e.target.value.trim(); } });
        const hpField = field("Ordner auf dem Server", hp, m.host_owner_root ? "Achtung: Dieser Ordner gehört auf dem Server „root“ – der Container könnte darin nur lesen. „Neu einhängen“ richtet die Rechte passend für den Container ein." : null);
        const info = h("div", { class: "muted small" });
        const upd = () => {
          hpField.classList.toggle("hidden", c.action !== "bind");
          info.textContent = (c.action === "mount" ? `Der Server hängt ${m.source} mit den Zugangsdaten aus der VM unter /mnt/bpui/… ein (Eintrag in /etc/fstab).`
            : c.action === "skip" ? "Wird nicht übernommen – du kannst den Ordner später unter Einstellungen → Ordner hinzufügen." : "")
            + (c.action !== "skip" && m.fstype.startsWith("nfs") ? " Wichtig bei NFS: Der Container greift als Benutzer 100000 zu, nicht als root. Damit er schreiben darf, auf der NAS in der NFS-Regel „Squash: Alle Benutzer zu admin zuordnen“ einstellen (Synology)." : "");
        };
        upd();
        return h("div", { class: "howto" }, h("div", { class: "guest-icon" }, icon("network")),
          h("div", { class: "grow stack", style: { gap: "8px", minWidth: 0 } },
            h("div", null, h("strong", null, m.target), h("div", { class: "muted small" }, `${m.source} (${m.fstype})`)),
            segmented([
              { value: "bind", label: m.host_path ? "Server-Freigabe" : "Server-Ordner" },
              { value: "mount", label: "Neu einhängen" }, { value: "skip", label: "Weglassen" }], c.action, v => { c.action = v; upd(); }),
            hpField, info));
      })));
  }

  // Netzwerk
  body.append(card("network", "Netzwerk",
    ...p.nics.map((n, i) => {
      const ipIn = input({ value: n.ip, placeholder: "192.168.1.20/24", oninput: (e) => { n.ip = e.target.value.trim(); } });
      const gwIn = input({ value: n.gw, placeholder: "192.168.1.1", oninput: (e) => { n.gw = e.target.value.trim(); } });
      const ipBox = h("div", { class: "grid cols-2" }, field("IP-Adresse mit Netzmaske", ipIn), field("Gateway (Router)", gwIn));
      ipBox.classList.toggle("hidden", n.mode !== "static");
      return h("div", { class: "stack", style: { gap: "10px", marginTop: i ? "16px" : 0 } },
        h("div", { class: "muted" }, `Netzwerkkarte ${i + 1} · ${n.bridge}${n.tag ? ` · VLAN ${n.tag}` : ""}`),
        segmented([{ value: "static", label: "Gleiche IP fest eintragen" }, { value: "dhcp", label: "Automatisch (DHCP)" }], n.mode,
          v => { n.mode = v; ipBox.classList.toggle("hidden", v !== "static"); }),
        ipBox,
        toggle("Gleiche MAC-Adresse wie die VM", "Dann erkennt der Router den Container als dasselbe Gerät (gleiche IP per DHCP-Reservierung).", n.keepMac, v => { n.keepMac = v; }));
    }),
    !Object.keys(a.ips).length && a.mode === "disk" ? h("p", { class: "muted small", style: { marginTop: "8px" } }, "Die aktuelle IP ist unbekannt, weil die VM aus ist. Mit gleicher MAC-Adresse bekommt der Container vom Router meist dieselbe IP.") : null));

  // Apps
  if (a.compose.length || a.immich) {
    body.append(card("apps", "Apps",
      a.compose.length ? h("div", null, h("p", { style: { marginTop: 0 } }, "Diese Docker-Apps werden im Container wieder gestartet (die Images lädt Docker neu, die Daten bleiben):"),
        h("ul", { class: "plain-list" }, a.compose.map(f => h("li", null, h("code", { class: "mono" }, f))))) : null,
      a.immich && a.dri ? h("div", { style: { marginTop: "10px" } }, toggle("Grafikchip für Immich durchreichen",
        "Für schnelleres Umwandeln von Videos und Erkennen von Gesichtern. In der docker-compose.yml muss dafür die Hardware-Beschleunigung aktiviert sein.", p.dri, v => { p.dri = v; })) : null));
  }

  // Start
  const startBtn = h("button", { class: "btn primary" }, icon("play", "sm"), "Umwandlung starten");
  startBtn.addEventListener("click", () => withBusy(startBtn, async () => {
    const steps = [a.status === "running" ? "Die VM wird sauber heruntergefahren." : null,
      "Ihre Festplatten werden nur gelesen – die VM selbst bleibt unverändert erhalten.",
      `Container ${p.ctid} „${p.hostname}“ wird angelegt und gefüllt – Fortschritt, Tempo und Restzeit siehst du live.`,
      "Die VM startet danach nicht mehr automatisch. Geht etwas schief, wird sie wieder gestartet."].filter(Boolean);
    if (!await confirmDialog({ title: "Umwandlung starten?", text: steps.join(" "), confirmText: "Starten" })) return;
    const bodyReq = {
      ctid: p.ctid, hostname: p.hostname, cores: p.cores, memory: p.memory, swap: p.swap, storage: p.storage, rootfs_gb: p.rootfs_gb,
      onboot: p.onboot, start: p.start, dri: p.dri,
      nics: p.nics.map(n => ({ bridge: n.bridge, mac: n.keepMac ? n.mac : null, tag: n.tag, firewall: n.firewall, ip: n.mode === "static" ? n.ip : "dhcp", gw: n.mode === "static" ? n.gw : "" })),
      mounts: p.mounts,
    };
    try { const r = await api(`/convert/${vmid}`, { method: "POST", body: bodyReq }); go(`job/${r.data.id}`); }
    catch (e) { errorToast(e); }
  }));
  body.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, icon("sparkle"), h("h3", null, "Los geht's")),
    h("ul", { class: "plain-list", style: { marginTop: 0 } },
      h("li", null, "Die VM bleibt als Rückfallebene erhalten – erst löschen, wenn der Container ein paar Tage gut läuft."),
      h("li", null, "VM und Container nie gleichzeitig starten: gleiche Adresse und gleiche Daten.")),
    h("div", { class: "row wrap", style: { marginTop: "10px" } }, startBtn)));
}
