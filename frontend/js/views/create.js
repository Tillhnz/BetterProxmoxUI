import {
  h, icon, clear, pve, bytes, nodePath, enc, toast, errorToast, trackTask, openSheet, field, input, select, toggle,
  segmented, withBusy, pageHead, callout, loader, validHostname, prettyTemplate,
} from "../core.js";

// ---------------------------------------------------------------------------
// Auswahl
// ---------------------------------------------------------------------------
export function renderNew({ el }) {
  const tile = (href, ico, cls, title, text, tag) => h("a", { href, class: "card clickable", style: { color: "var(--text)", display: "flex", flexDirection: "column", gap: "12px" } },
    h("div", { class: "row" }, h("div", { class: `guest-icon ${cls}`, style: { width: "52px", height: "52px", borderRadius: "15px" } }, icon(ico, "lg")),
      h("span", { class: "spacer" }), tag ? h("span", { class: "badge accent" }, tag) : null),
    h("div", null, h("h3", { style: { fontSize: "18px" } }, title), h("p", { class: "muted", style: { margin: "4px 0 0" } }, text)));

  el.append(pageHead("Neu anlegen", "Was möchtest du einrichten?"),
    h("div", { class: "grid cols-3" },
      tile("#/apps", "apps", "", "Fertige App", "Home Assistant, Pi-hole, Jellyfin und viele mehr – mit einem Installations-Assistenten.", "Am einfachsten"),
      tile("#/new/lxc", "box", "ct", "Container (LXC)", "Leicht und sparsam. Ideal für Linux-Dienste wie Webserver, Datenbanken oder Docker."),
      tile("#/new/vm", "monitor", "vm", "Virtuelle Maschine", "Ein kompletter Computer. Für Windows, andere Betriebssysteme oder volle Trennung.")),
    h("div", { style: { marginTop: "20px" } }, callout("info", "Container oder VM?",
      "Container teilen sich den Kern mit Proxmox und brauchen kaum Ressourcen – für die meisten Linux-Dienste die beste Wahl. Eine VM brauchst du für Windows oder wenn ein Programm das ausdrücklich verlangt.")));
}

// ---------------------------------------------------------------------------
// Gemeinsame Hilfen
// ---------------------------------------------------------------------------
const SIZES = {
  lxc: [
    { id: "s", label: "Klein", cores: 1, memory: 512, disk: 4, text: "1 Kern · 512 MB · 4 GB" },
    { id: "m", label: "Mittel", cores: 2, memory: 2048, disk: 16, text: "2 Kerne · 2 GB · 16 GB" },
    { id: "l", label: "Groß", cores: 4, memory: 4096, disk: 32, text: "4 Kerne · 4 GB · 32 GB" },
  ],
  qemu: [
    { id: "s", label: "Klein", cores: 2, memory: 2048, disk: 32, text: "2 Kerne · 2 GB · 32 GB" },
    { id: "m", label: "Mittel", cores: 4, memory: 4096, disk: 64, text: "4 Kerne · 4 GB · 64 GB" },
    { id: "l", label: "Groß", cores: 8, memory: 8192, disk: 128, text: "8 Kerne · 8 GB · 128 GB" },
  ],
};

async function storagesFor(content) {
  const list = await pve("GET", nodePath("/storage"), { content, enabled: 1 });
  return list.filter(s => s.active !== 0).sort((a, b) => (b.avail || 0) - (a.avail || 0));
}
async function bridges() {
  try {
    const list = await pve("GET", nodePath("/network"), { type: "any_bridge" });
    return list.map(b => b.iface).sort();
  } catch { return ["vmbr0"]; }
}

function wizard(el, title, sub, steps, onFinish) {
  let step = 0;
  const bar = h("div", { class: "steps" });
  const content = h("div");
  const back = h("button", { class: "btn" }, icon("chevronLeft", "sm"), "Zurück");
  const next = h("button", { class: "btn primary" });
  const card = h("div", { class: "card wizard-card" }, bar, content, h("div", { class: "wizard-foot" }, back, next));
  el.append(h("a", { class: "back", href: "#/new" }, icon("chevronLeft", "sm"), "Neu anlegen"), pageHead(title, sub), card);

  function draw() {
    clear(bar).append(steps.map((_, i) => h("i", { class: i <= step ? "done" : "" })));
    clear(content).append(h("div", { class: "muted small", style: { fontWeight: 600, marginBottom: "4px" } }, `Schritt ${step + 1} von ${steps.length}`),
      h("h2", { style: { margin: "0 0 18px", fontSize: "20px", letterSpacing: "-.015em" } }, steps[step].title), steps[step].render());
    back.style.visibility = step === 0 ? "hidden" : "visible";
    clear(next).append(step === steps.length - 1 ? "Jetzt erstellen" : "Weiter", step === steps.length - 1 ? icon("check", "sm") : icon("chevronRight", "sm"));
  }
  back.addEventListener("click", () => { if (step > 0) { step--; draw(); } });
  next.addEventListener("click", async () => {
    const err = steps[step].validate ? await steps[step].validate() : null;
    if (err) return toast("Bitte prüfen", err, "bad");
    if (step < steps.length - 1) { step++; draw(); window.scrollTo({ top: 0, behavior: "smooth" }); }
    else await withBusy(next, onFinish);
  });
  draw();
  return { redraw: draw };
}

function sizePicker(kind, data, onChange) {
  const wrap = h("div", { class: "stack" });
  const custom = h("div", { class: "form-grid", style: { marginTop: "4px" } });
  const draw = () => {
    clear(wrap);
    const grid = h("div", { class: "choice-grid" });
    for (const s of SIZES[kind]) {
      grid.append(h("button", { type: "button", class: `choice ${data.size === s.id ? "active" : ""}`, onclick: () => {
        Object.assign(data, { size: s.id, cores: s.cores, memory: s.memory, disk: s.disk }); onChange && onChange(); draw();
      } }, h("strong", null, s.label), h("span", null, s.text)));
    }
    grid.append(h("button", { type: "button", class: `choice ${data.size === "c" ? "active" : ""}`, onclick: () => { data.size = "c"; draw(); } },
      h("strong", null, "Eigene"), h("span", null, "Selbst festlegen")));
    wrap.append(grid);
    if (data.size === "c") {
      clear(custom).append(
        field("Prozessorkerne", input({ type: "number", min: 1, max: 64, value: data.cores, oninput: (e) => { data.cores = Number(e.target.value); } })),
        field("Arbeitsspeicher (MB)", input({ type: "number", min: 256, step: 256, value: data.memory, oninput: (e) => { data.memory = Number(e.target.value); } }), "1024 MB = 1 GB"),
        field("Festplatte (GB)", input({ type: "number", min: 1, value: data.disk, oninput: (e) => { data.disk = Number(e.target.value); } })));
      wrap.append(custom);
    }
  };
  draw();
  return wrap;
}

function storageSelect(list, data, key, need) {
  if (!list.length) return callout("bad", "Kein passender Speicher", "Auf diesem Server gibt es keinen Speicher, der dafür freigegeben ist.");
  if (!data[key]) data[key] = (list.find(s => s.storage === "local-lvm") || list.find(s => s.storage === "local-zfs") || list[0]).storage;
  return select(list.map(s => ({ value: s.storage, label: `${s.storage} · ${bytes(s.avail)} frei${need && s.avail < need ? " (zu wenig!)" : ""}` })), data[key],
    { onchange: (e) => { data[key] = e.target.value; } });
}

function networkFields(data, bridgeList) {
  const wrap = h("div", { class: "stack" });
  const staticBox = h("div", { class: "form-grid" });
  const draw = () => {
    clear(staticBox);
    if (data.ipMode === "static") {
      staticBox.append(
        field("IP-Adresse mit Netzmaske", input({ placeholder: "192.168.1.50/24", value: data.ip || "", oninput: (e) => { data.ip = e.target.value.trim(); } }), "Die „/24“ passt für fast alle Heimnetze."),
        field("Gateway (Router)", input({ placeholder: "192.168.1.1", value: data.gw || "", oninput: (e) => { data.gw = e.target.value.trim(); } }), "Meist die Adresse deines Routers."));
    }
  };
  wrap.append(
    field("IP-Adresse", segmented([{ value: "dhcp", label: "Automatisch (empfohlen)" }, { value: "static", label: "Fest" }], data.ipMode, (v) => { data.ipMode = v; draw(); }),
      "„Automatisch“ bedeutet: Dein Router vergibt die Adresse. Für Server kannst du sie im Router fest reservieren."),
    staticBox,
    bridgeList.length > 1 ? field("Netzwerk-Anschluss", select(bridgeList.map(b => ({ value: b, label: b })), data.bridge, { onchange: (e) => { data.bridge = e.target.value; } }), "Normalerweise vmbr0.") : null,
  );
  draw();
  return wrap;
}

function validateNet(data) {
  if (data.ipMode !== "static") return null;
  if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(data.ip || "")) return "Feste IP bitte im Format 192.168.1.50/24 eingeben.";
  if (data.gw && !/^\d{1,3}(\.\d{1,3}){3}$/.test(data.gw)) return "Gateway bitte im Format 192.168.1.1 eingeben.";
  return null;
}

function summary(rows) {
  return h("dl", { class: "summary" }, rows.filter(Boolean).flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]));
}

// ---------------------------------------------------------------------------
// Container (LXC)
// ---------------------------------------------------------------------------
export async function renderNewLxc({ el, go }) {
  const wait = loader(); el.append(wait);
  let tmplStores, rootStores, bridgeList, templates = [];
  try {
    [tmplStores, rootStores, bridgeList] = await Promise.all([storagesFor("vztmpl"), storagesFor("rootdir"), bridges()]);
  } catch (e) { wait.replaceWith(callout("bad", "Laden fehlgeschlagen", e.message)); return; }
  wait.remove();

  const data = { size: "s", cores: 1, memory: 512, disk: 4, ipMode: "dhcp", bridge: bridgeList.includes("vmbr0") ? "vmbr0" : bridgeList[0],
    onboot: true, start: true, unprivileged: true, nesting: true, hostname: "", password: "", password2: "", template: "", rootStore: "" };

  async function loadTemplates() {
    templates = [];
    for (const s of tmplStores) {
      try {
        const items = await pve("GET", nodePath(`/storage/${enc(s.storage)}/content`), { content: "vztmpl" });
        templates.push(...items.map(i => ({ volid: i.volid, size: i.size, store: s.storage })));
      } catch { /* egal */ }
    }
    templates.sort((a, b) => prettyTemplate(a.volid).localeCompare(prettyTemplate(b.volid)));
    if (!data.template && templates.length) data.template = (templates.find(t => /debian-1[2-9]/.test(t.volid)) || templates[0]).volid;
  }
  await loadTemplates();

  const wz = wizard(el, "Container anlegen", "In drei Schritten zu deinem Linux-Container.", [
    {
      title: "Welches System?",
      render: () => {
        const wrap = h("div", { class: "stack" });
        if (!templates.length) wrap.append(callout("warn", "Noch keine Vorlagen", "Lade zuerst eine Vorlage herunter – zum Beispiel Debian."));
        else {
          const grid = h("div", { class: "choice-grid" });
          for (const t of templates) {
            grid.append(h("button", { type: "button", class: `choice ${data.template === t.volid ? "active" : ""}`, onclick: () => { data.template = t.volid; wz.redraw(); } },
              h("strong", null, prettyTemplate(t.volid)), h("span", { class: "mono", style: { fontSize: "11px", wordBreak: "break-all" } }, t.volid.split("/").pop())));
          }
          wrap.append(grid);
        }
        wrap.append(h("div", null, h("button", { class: "btn", type: "button", onclick: () => downloadTemplateSheet(tmplStores, async () => { await loadTemplates(); wz.redraw(); }) },
          icon("download", "sm"), "Weitere Vorlagen herunterladen")),
        h("p", { class: "muted small" }, "Tipp: Debian ist die solide Standardwahl. Alpine ist besonders klein."));
        return wrap;
      },
      validate: () => (!data.template ? "Bitte eine Vorlage auswählen." : null),
    },
    {
      title: "Name, Passwort & Größe",
      render: () => h("div", { class: "stack", style: { gap: "18px" } },
        field("Name", input({ value: data.hostname, placeholder: "z. B. webserver", autocapitalize: "off", oninput: (e) => { data.hostname = e.target.value.trim(); } }),
          "Nur Buchstaben, Zahlen und Bindestriche. Unter diesem Namen erscheint er im Netzwerk."),
        h("div", { class: "form-grid" },
          field("Root-Passwort", input({ type: "password", value: data.password, autocomplete: "new-password", oninput: (e) => { data.password = e.target.value; } }), "Mindestens 8 Zeichen. Damit meldest du dich im Container an."),
          field("Passwort wiederholen", input({ type: "password", value: data.password2, autocomplete: "new-password", oninput: (e) => { data.password2 = e.target.value; } }))),
        h("div", { class: "field" }, h("label", null, "Größe"), sizePicker("lxc", data), h("div", { class: "hint" }, "Lässt sich später jederzeit ändern."))),
      validate: () => {
        if (!validHostname(data.hostname)) return "Bitte einen gültigen Namen eingeben (Buchstaben, Zahlen, Bindestriche).";
        if ((data.password || "").length < 8) return "Das Passwort muss mindestens 8 Zeichen haben.";
        if (data.password !== data.password2) return "Die Passwörter stimmen nicht überein.";
        if (!(data.cores >= 1 && data.memory >= 128 && data.disk >= 1)) return "Bitte gültige Werte für die Größe eingeben.";
        return null;
      },
    },
    {
      title: "Netzwerk & Speicher",
      render: () => h("div", { class: "stack", style: { gap: "18px" } },
        networkFields(data, bridgeList),
        field("Speicherort", storageSelect(rootStores, data, "rootStore", data.disk * 1024 ** 3), "Wo die Festplatte des Containers liegt."),
        toggle("Mit dem Server starten", "Startet automatisch, wenn Proxmox hochfährt.", data.onboot, (v) => { data.onboot = v; }),
        toggle("Gleich nach dem Erstellen starten", null, data.start, (v) => { data.start = v; }),
        h("details", null, h("summary", { style: { cursor: "pointer", fontWeight: 620 } }, "Erweitert"),
          h("div", { class: "stack", style: { marginTop: "12px" } },
            toggle("Unprivilegiert (empfohlen)", "Sicherer, weil der Container keine Root-Rechte auf dem Server hat.", data.unprivileged, (v) => { data.unprivileged = v; }),
            toggle("Verschachtelung erlauben", "Nötig z. B. für Docker im Container.", data.nesting, (v) => { data.nesting = v; })))),
      validate: () => validateNet(data) || (!data.rootStore ? "Bitte einen Speicherort wählen." : null),
    },
    {
      title: "Zusammenfassung",
      render: () => h("div", { class: "stack" },
        summary([
          ["System", prettyTemplate(data.template)],
          ["Name", data.hostname],
          ["Größe", `${data.cores} Kern(e) · ${data.memory} MB RAM · ${data.disk} GB`],
          ["Netzwerk", data.ipMode === "dhcp" ? `Automatisch über ${data.bridge}` : `${data.ip}${data.gw ? " · Gateway " + data.gw : ""}`],
          ["Speicherort", data.rootStore],
          ["Autostart", data.onboot ? "Ja" : "Nein"],
        ]),
        callout("info", null, "Das Anlegen dauert meist nur ein paar Sekunden.")),
    },
  ], async () => {
    try {
      const vmid = await pve("GET", "/cluster/nextid");
      const net = [`name=eth0`, `bridge=${data.bridge}`, data.ipMode === "dhcp" ? "ip=dhcp" : `ip=${data.ip}`, data.ipMode === "static" && data.gw ? `gw=${data.gw}` : null, "firewall=0"].filter(Boolean).join(",");
      const body = {
        vmid, hostname: data.hostname, password: data.password, ostemplate: data.template,
        cores: data.cores, memory: data.memory, swap: Math.min(512, data.memory), rootfs: `${data.rootStore}:${data.disk}`,
        net0: net, unprivileged: data.unprivileged ? 1 : 0, onboot: data.onboot ? 1 : 0, start: data.start ? 1 : 0,
      };
      if (data.nesting) body.features = data.unprivileged ? "nesting=1,keyctl=1" : "nesting=1";
      const upid = await pve("POST", nodePath("/lxc"), body);
      trackTask(upid, `Container „${data.hostname}“ anlegen`);
      go(`guest/lxc/${vmid}`);
    } catch (e) { errorToast(e, "Container konnte nicht angelegt werden"); }
  });
}

function downloadTemplateSheet(tmplStores, onDone) {
  openSheet(async (sheet, close) => {
    const listEl = h("div", null, loader());
    let q = "";
    const storeSel = select(tmplStores.map(s => ({ value: s.storage, label: s.storage })), tmplStores[0]?.storage);
    sheet.append(h("h2", null, "Vorlage herunterladen"), h("p", { class: "sheet-sub" }, "Offizielle Systemvorlagen von Proxmox."),
      h("div", { class: "stack" },
        tmplStores.length > 1 ? field("Speicherort", storeSel) : null,
        h("div", { class: "input-wrap" }, icon("search", "sm"), input({ placeholder: "Suchen, z. B. debian", oninput: (e) => { q = e.target.value.toLowerCase(); draw(); } }))),
      h("div", { style: { marginTop: "14px" } }, listEl),
      h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Schließen")));
    if (!tmplStores.length) { clear(listEl).append(callout("bad", "Kein Speicher für Vorlagen", "Aktiviere „Container-Vorlagen“ bei einem Speicher, z. B. „local“.")); return; }
    let items = [];
    try { items = (await pve("GET", nodePath("/aplinfo"))).filter(i => i.section === "system"); }
    catch (e) { clear(listEl).append(callout("bad", "Liste nicht verfügbar", e.message)); return; }
    items.sort((a, b) => a.template.localeCompare(b.template));
    function draw() {
      clear(listEl);
      const shown = items.filter(i => !q || i.template.toLowerCase().includes(q) || (i.headline || "").toLowerCase().includes(q));
      if (!shown.length) { listEl.append(h("p", { class: "muted" }, "Nichts gefunden.")); return; }
      listEl.append(h("div", { class: "card pad-0 flat" }, h("div", { class: "list" }, shown.map(i => {
        const b = h("button", { class: "btn sm" }, icon("download", "sm"), "Laden");
        b.addEventListener("click", () => withBusy(b, async () => {
          try {
            const upid = await pve("POST", nodePath("/aplinfo"), { storage: storeSel.value, template: i.template });
            close();
            trackTask(upid, `Vorlage ${prettyTemplate(i.template)} herunterladen`, { onDone: () => onDone() });
          } catch (e) { errorToast(e); }
        }));
        return h("div", { class: "list-item" }, h("div", { class: "grow" }, h("div", { class: "title" }, prettyTemplate(i.template)),
          h("div", { class: "meta" }, i.template)), b);
      }))));
    }
    draw();
  }, { wide: true });
}

// ---------------------------------------------------------------------------
// Virtuelle Maschine
// ---------------------------------------------------------------------------
export async function renderNewVm({ el, go }) {
  const wait = loader(); el.append(wait);
  let isoStores, imgStores, bridgeList, isos = [];
  try {
    [isoStores, imgStores, bridgeList] = await Promise.all([storagesFor("iso"), storagesFor("images"), bridges()]);
  } catch (e) { wait.replaceWith(callout("bad", "Laden fehlgeschlagen", e.message)); return; }
  wait.remove();

  const data = { os: "linux", iso: "", name: "", size: "s", cores: 2, memory: 2048, disk: 32, bridge: bridgeList.includes("vmbr0") ? "vmbr0" : bridgeList[0],
    ipMode: "dhcp", diskStore: "", onboot: true, start: true };

  async function loadIsos() {
    isos = [];
    for (const s of isoStores) {
      try { isos.push(...(await pve("GET", nodePath(`/storage/${enc(s.storage)}/content`), { content: "iso" })).map(i => ({ volid: i.volid, size: i.size }))); } catch { /* egal */ }
    }
    isos.sort((a, b) => a.volid.localeCompare(b.volid));
  }
  await loadIsos();

  const wz = wizard(el, "Virtuelle Maschine anlegen", "Ein vollständiger Computer auf deinem Server.", [
    {
      title: "Betriebssystem",
      render: () => {
        const wrap = h("div", { class: "stack", style: { gap: "18px" } });
        wrap.append(field("Art", segmented([{ value: "linux", label: "Linux" }, { value: "windows", label: "Windows" }, { value: "other", label: "Anderes" }], data.os, (v) => { data.os = v; wz.redraw(); })));
        const isoBox = h("div", { class: "field" }, h("label", null, "Installations-Medium (ISO)"));
        if (!isos.length) isoBox.append(callout("warn", "Noch keine ISO-Dateien", "Lade eine ISO-Datei über einen Link herunter – zum Beispiel von der Debian- oder Ubuntu-Webseite."));
        else isoBox.append(select([{ value: "", label: "Bitte wählen …" }, ...isos.map(i => ({ value: i.volid, label: `${i.volid.split("/").pop()} (${bytes(i.size)})` }))], data.iso,
          { onchange: (e) => { data.iso = e.target.value; } }));
        isoBox.append(h("div", null, h("button", { class: "btn", type: "button", style: { marginTop: "6px" }, onclick: () => downloadIsoSheet(isoStores, async (volid) => { await loadIsos(); if (volid) data.iso = volid; wz.redraw(); }) },
          icon("download", "sm"), "ISO aus dem Internet laden")));
        wrap.append(isoBox);
        if (data.os === "windows") wrap.append(callout("info", "Windows-Hinweis", "Die VM wird mit UEFI und TPM eingerichtet, damit Windows 11 läuft. Die Festplatte nutzt SATA, so erkennt Windows sie ohne Zusatztreiber."));
        return wrap;
      },
      validate: () => (!data.iso ? "Bitte eine ISO-Datei auswählen oder herunterladen." : null),
    },
    {
      title: "Name & Größe",
      render: () => h("div", { class: "stack", style: { gap: "18px" } },
        field("Name", input({ value: data.name, placeholder: data.os === "windows" ? "z. B. windows11" : "z. B. ubuntu-server", autocapitalize: "off", oninput: (e) => { data.name = e.target.value.trim(); } }),
          "Nur Buchstaben, Zahlen und Bindestriche."),
        h("div", { class: "field" }, h("label", null, "Größe"), sizePicker("qemu", data), h("div", { class: "hint" }, data.os === "windows" ? "Für Windows 11 mindestens „Mittel“ wählen." : "Lässt sich später ändern."))),
      validate: () => {
        if (!validHostname(data.name)) return "Bitte einen gültigen Namen eingeben.";
        if (!(data.cores >= 1 && data.memory >= 256 && data.disk >= 1)) return "Bitte gültige Werte für die Größe eingeben.";
        return null;
      },
    },
    {
      title: "Netzwerk & Speicher",
      render: () => h("div", { class: "stack", style: { gap: "18px" } },
        bridgeList.length > 1 ? field("Netzwerk-Anschluss", select(bridgeList.map(b => ({ value: b, label: b })), data.bridge, { onchange: (e) => { data.bridge = e.target.value; } }), "Normalerweise vmbr0.")
          : callout("info", null, "Die VM bekommt ihre IP-Adresse wie ein normaler PC – bei der Installation des Betriebssystems."),
        field("Speicherort", storageSelect(imgStores, data, "diskStore", data.disk * 1024 ** 3), "Wo die virtuelle Festplatte liegt."),
        toggle("Mit dem Server starten", "Startet automatisch, wenn Proxmox hochfährt.", data.onboot, (v) => { data.onboot = v; }),
        toggle("Gleich nach dem Erstellen starten", "Danach über „Konsole“ das Betriebssystem installieren.", data.start, (v) => { data.start = v; })),
      validate: () => (!data.diskStore ? "Bitte einen Speicherort wählen." : null),
    },
    {
      title: "Zusammenfassung",
      render: () => h("div", { class: "stack" },
        summary([
          ["System", { linux: "Linux", windows: "Windows", other: "Anderes" }[data.os]],
          ["ISO", data.iso.split("/").pop()],
          ["Name", data.name],
          ["Größe", `${data.cores} Kerne · ${data.memory} MB RAM · ${data.disk} GB`],
          ["Netzwerk", data.bridge],
          ["Speicherort", data.diskStore],
        ]),
        callout("info", "Wie geht es weiter?", "Nach dem Erstellen öffnest du die Konsole und installierst das Betriebssystem wie auf einem normalen PC.")),
    },
  ], async () => {
    try {
      const vmid = await pve("GET", "/cluster/nextid");
      const st = data.diskStore;
      const body = {
        vmid, name: data.name, cores: data.cores, sockets: 1, cpu: "host", memory: data.memory,
        ide2: `${data.iso},media=cdrom`, onboot: data.onboot ? 1 : 0, start: data.start ? 1 : 0, agent: "enabled=1",
      };
      if (data.os === "windows") {
        Object.assign(body, {
          ostype: "win11", bios: "ovmf", machine: "q35", scsihw: "virtio-scsi-single",
          efidisk0: `${st}:1,efitype=4m,pre-enrolled-keys=1`, tpmstate0: `${st}:1,version=v2.0`,
          sata0: `${st}:${data.disk},discard=on`, net0: `e1000e,bridge=${data.bridge}`, boot: "order=sata0;ide2;net0",
        });
      } else {
        Object.assign(body, {
          ostype: data.os === "linux" ? "l26" : "other", scsihw: "virtio-scsi-single",
          scsi0: `${st}:${data.disk},iothread=1,discard=on`, net0: `virtio,bridge=${data.bridge}`, boot: "order=scsi0;ide2;net0",
        });
      }
      const upid = await pve("POST", nodePath("/qemu"), body);
      trackTask(upid, `VM „${data.name}“ anlegen`);
      go(`guest/qemu/${vmid}`);
    } catch (e) { errorToast(e, "VM konnte nicht angelegt werden"); }
  });
}

function downloadIsoSheet(isoStores, onDone) {
  openSheet((sheet, close) => {
    if (!isoStores.length) {
      sheet.append(h("h2", null, "ISO herunterladen"), callout("bad", "Kein Speicher für ISO-Dateien", "Aktiviere „ISO-Image“ bei einem Speicher, z. B. „local“."),
        h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Schließen")));
      return;
    }
    const url = input({ placeholder: "https://…/ubuntu-24.04-live-server-amd64.iso", inputmode: "url", autocapitalize: "off" });
    const fname = input({ placeholder: "wird aus dem Link übernommen" });
    url.addEventListener("input", () => {
      try { const n = new URL(url.value).pathname.split("/").pop(); if (n && !fname.dataset.touched) fname.value = n; } catch { /* egal */ }
    });
    fname.addEventListener("input", () => { fname.dataset.touched = "1"; });
    const storeSel = select(isoStores.map(s => ({ value: s.storage, label: `${s.storage} · ${bytes(s.avail)} frei` })), isoStores[0].storage);
    const btn = h("button", { class: "btn primary" }, icon("download", "sm"), "Herunterladen");
    btn.addEventListener("click", () => withBusy(btn, async () => {
      let name = fname.value.trim();
      if (!/^https?:\/\//.test(url.value.trim())) return toast("Bitte einen gültigen Link eingeben", "", "bad");
      if (!name.toLowerCase().endsWith(".iso")) name += ".iso";
      if (!/^[\w.+-]+\.iso$/i.test(name)) return toast("Ungültiger Dateiname", "Nur Buchstaben, Zahlen, Punkt, Minus und Unterstrich.", "bad");
      try {
        const upid = await pve("POST", nodePath(`/storage/${enc(storeSel.value)}/download-url`), { content: "iso", filename: name, url: url.value.trim() });
        close();
        trackTask(upid, `ISO ${name} herunterladen`, { onDone: (ok) => ok && onDone(`${storeSel.value}:iso/${name}`) });
      } catch (e) { errorToast(e); }
    }));
    sheet.append(h("h2", null, "ISO aus dem Internet laden"),
      h("p", { class: "sheet-sub" }, "Kopiere den Download-Link von der Webseite des Betriebssystems."),
      h("div", { class: "stack" }, field("Download-Link", url), field("Dateiname", fname), isoStores.length > 1 ? field("Speicherort", storeSel) : null),
      h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Abbrechen"), btn));
  });
}

