// ===========================================================================
// Musik über die Anlage: Audio-Ausgang des Servers als Player für Music Assistant
//
//   Spotify / AirPlay / MA-App  →  Music Assistant (in Home Assistant)
//     →  Player-Container (Squeezelite)  →  Audiokabel  →  Anlage
// ===========================================================================
import {
  h, icon, clear, api, pve, state, nodePath, toast, errorToast, openSheet, confirmDialog, withBusy,
  pageHead, callout, loader, field, input, select, toggle, logoImg, appAvatar,
} from "../core.js";

const KIND = { analog: "Analog (Klinke)", hdmi: "HDMI", digital: "Digital (S/PDIF)", usb: "USB-Soundkarte" };
const HA_NAME = /home.?assistant|haos|\bhass\b|^ha$/i;

function logoBox(slug, ico) {
  return h("div", { class: "c-ico" }, slug ? logoImg(slug, () => icon(ico)) : icon(ico));
}

// Home Assistant finden (VM oder Container) inkl. IP-Adresse und Netzwerk-Brücke
async function findHomeAssistant() {
  let res = [];
  try { res = await pve("GET", "/cluster/resources"); } catch { return null; }
  const cands = res.filter(r => (r.type === "qemu" || r.type === "lxc") && r.node === state.node && !r.template && HA_NAME.test(r.name || ""));
  const ha = cands.sort((a, b) => (b.type === "qemu") - (a.type === "qemu") || (b.status === "running") - (a.status === "running"))[0];
  if (!ha) return null;
  const out = { vmid: ha.vmid, type: ha.type, name: ha.name, status: ha.status, ip: null, bridge: null };
  try {
    const cfg = await pve("GET", nodePath(`/${ha.type}/${ha.vmid}/config`));
    out.bridge = /bridge=([^,]+)/.exec(cfg.net0 || "")?.[1] || null;
  } catch { /* egal */ }
  if (ha.status === "running" && ha.type === "qemu") {
    try {
      const r = await pve("GET", nodePath(`/qemu/${ha.vmid}/agent/network-get-interfaces`));
      const ips = [];
      for (const ifc of r.result || []) {
        if (/^(lo|docker|hassio|veth)/.test(ifc.name)) continue;
        for (const a of ifc["ip-addresses"] || []) if (a["ip-address-type"] === "ipv4") ips.push(a["ip-address"]);
      }
      out.ip = ips.find(ip => !/^(127\.|172\.(17|30|31)\.|169\.254\.)/.test(ip)) || null;
    } catch { /* kein Gast-Agent */ }
  } else if (ha.status === "running") {
    try {
      const ifs = await pve("GET", nodePath(`/lxc/${ha.vmid}/interfaces`));
      out.ip = (ifs || []).filter(i => i.name !== "lo").map(i => String(i.inet || "").split("/")[0]).find(Boolean) || null;
    } catch { /* egal */ }
  }
  return out;
}

export async function renderAudio({ page, el, go }) {
  el.append(pageHead("Musik über die Anlage", "Spiel Musik aus Music Assistant, Spotify oder AirPlay über das Audiokabel an diesem Server ab."));
  if (!state.user.host_admin) {
    el.append(callout("info", "Nur für root@pam", "Der Musik-Player braucht Zugriff auf die Hardware des Servers. Melde dich als root@pam an, um ihn einzurichten."));
    return;
  }
  const chainCard = h("div", { class: "card" }, loader());
  const playerCard = h("div", { class: "card", style: { marginTop: "16px" } });
  const howtoCard = h("div", { class: "card", style: { marginTop: "16px" } });
  const helpCard = h("details", { class: "card", style: { marginTop: "16px" } });
  el.append(chainCard, playerCard, howtoCard, helpCard);

  let data, ha;
  async function load() {
    try {
      [data, ha] = await Promise.all([api("/audio").then(r => r.data), findHomeAssistant()]);
    } catch (e) { clear(chainCard).append(callout("bad", "Konnte nicht geladen werden", e.message)); return; }
    draw();
  }

  function draw() {
    const p = data.player;
    const playerOk = p && p.running && p.service === "active";
    const playerName = p?.name || "Anlage";
    const out = p ? data.outputs.find(o => o.device === p.device) : data.outputs.find(o => o.recommended) || data.outputs[0];

    // ---------- Kette ----------
    const node = (cls, visual, title, meta, status) => h("div", { class: `chain-node ${cls}` }, visual,
      h("div", null, h("strong", null, title), h("div", { class: "meta" }, meta), status ? h("div", { class: "status-line" }, h("i"), status) : null));
    clear(chainCard).append(
      h("div", { class: "card-head" }, icon("music"), h("h3", null, "So kommt die Musik zur Anlage")),
      h("div", { class: "chain" },
        node("ok", h("div", { class: "c-logos" }, logoBox("spotify", "music"), logoBox("apple", "music"), logoBox("music-assistant", "music")),
          "Dein Handy", "Spotify, AirPlay oder die Music-Assistant-App", null),
        node(ha ? (ha.status === "running" ? "ok" : "warn") : "", logoBox("music-assistant", "music"),
          "Music Assistant", ha ? `in „${ha.name}“ (${ha.type === "qemu" ? "VM" : "Container"} ${ha.vmid})` : "Home Assistant nicht gefunden",
          ha ? (ha.status === "running" ? "läuft" : "ausgeschaltet") : "unbekannt"),
        node(playerOk ? "ok" : p ? "warn" : "", logoBox(null, "speaker"),
          `Player „${playerName}“`, p ? `Container ${p.vmid} auf diesem Server` : "kleiner Container auf diesem Server",
          playerOk ? "bereit" : p ? (p.running ? "Player-Dienst gestoppt" : "Container aus") : "noch nicht eingerichtet"),
        node(out ? (playerOk ? "ok" : "") : "warn", logoBox(null, "volume"),
          "Deine Anlage", out ? `über ${KIND[out.kind]} · ${out.name}` : "kein Audio-Ausgang gefunden",
          out ? (playerOk ? "verbunden" : "Kabel steckt?") : "prüfen")));

    // ---------- Player ----------
    clear(playerCard);
    if (data.busy) {
      playerCard.append(h("div", { class: "card-head" }, icon("speaker"), h("h3", null, "Player")),
        callout("info", "Am Player wird gerade gearbeitet", "Einrichten oder Entfernen läuft noch."),
        h("div", { class: "row", style: { marginTop: "12px" } }, h("button", { class: "btn primary", onclick: openRunningJob }, icon("terminal", "sm"), "Fortschritt ansehen")));
      return drawHowto(playerName, playerOk);
    }
    if (!p) drawSetup(); else drawPlayer(p, out, playerOk);
    drawHowto(playerName, playerOk);
  }

  async function openRunningJob() {
    try { const j = (await api("/jobs")).data.find(x => x.kind === "audio" && x.running); if (j) go(`job/${j.id}`); else load(); } catch (e) { errorToast(e); }
  }

  // ---------- Einrichten ----------
  function setupForm(p, onSubmit) {
    const d = {
      device: p?.device || (data.outputs.find(o => o.recommended) || data.outputs[0])?.device,
      name: p?.name || "Anlage",
      fixed: !!p?.server, server: p?.server || ha?.ip || "",
      bridge: data.bridges.includes(ha?.bridge) ? ha.bridge : data.bridges.includes("vmbr0") ? "vmbr0" : data.bridges[0],
    };
    const wrap = h("div", { class: "stack" });
    const grid = h("div", { class: "choice-grid", style: { gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))" } });
    const drawGrid = () => clear(grid).append(data.outputs.map(o => h("button", { type: "button", class: `choice out-choice ${d.device === o.device ? "active" : ""}`,
      onclick: () => { d.device = o.device; drawGrid(); } },
      h("strong", { class: "k" }, icon(o.kind === "hdmi" ? "monitor" : o.kind === "usb" ? "cable" : "volume", "sm"), KIND[o.kind]),
      h("span", null, `${o.name} · ${o.card_name}`),
      o.recommended ? h("span", { class: "badge ok", style: { alignSelf: "flex-start", marginTop: "4px" } }, "Empfohlen") : null)));
    drawGrid();
    const nameIn = input({ value: d.name, maxlength: 40, oninput: (e) => { d.name = e.target.value; } });
    const srvIn = input({ value: d.server, placeholder: "z. B. 192.168.1.50", oninput: (e) => { d.server = e.target.value.trim(); } });
    const srvField = field("Adresse von Home Assistant / Music Assistant", srvIn, "Nur nötig, wenn der Player nicht von selbst gefunden wird.");
    srvField.classList.toggle("hidden", !d.fixed);
    const adv = h("details", { style: { marginTop: "4px" } }, h("summary", { class: "muted", style: { cursor: "pointer", fontWeight: 600 } }, "Erweitert"),
      h("div", { class: "stack", style: { marginTop: "10px" } },
        data.bridges.length > 1 ? field("Netzwerk", select(data.bridges.map(b => ({ value: b, label: b })), d.bridge, { onchange: (e) => { d.bridge = e.target.value; } }),
          "Am besten dasselbe Netzwerk wie Home Assistant.") : null,
        toggle("Music Assistant fest eintragen", "Statt automatisch im Netzwerk zu suchen", d.fixed, (v) => { d.fixed = v; srvField.classList.toggle("hidden", !v); }),
        srvField));
    const btn = h("button", { class: "btn primary", disabled: !data.pve_ok || !data.outputs.length }, icon(p ? "check" : "play", "sm"), p ? "Übernehmen" : "Player einrichten");
    btn.addEventListener("click", () => withBusy(btn, async () => {
      if (!d.name.trim()) return toast("Name fehlt", "Wie soll der Player in Spotify & Co. heißen?", "bad");
      try {
        const r = await api("/audio/setup", { method: "POST", body: { name: d.name.trim(), device: d.device, bridge: d.bridge, server: d.fixed ? d.server : "" } });
        onSubmit && onSubmit(); go(`job/${r.data.id}`);
      } catch (e) { errorToast(e); }
    }));
    wrap.append(
      field("Welcher Ausgang geht zur Anlage?", grid, "Beim ThinkCentre ist das meist „Analog“ – die Kopfhörer- bzw. Line-Out-Buchse."),
      field("Name des Players", nameIn, "So erscheint er in Music Assistant, Spotify und AirPlay."),
      adv, h("div", { class: "row wrap", style: { marginTop: "6px" } }, btn));
    return wrap;
  }

  function hardwareHint() {
    if (data.outputs.length) return null;
    if (data.hint === "vfio") return callout("warn", "Der Audio-Chip ist an eine VM durchgereicht",
      "Solange er direkt an eine VM gegeben ist, kann der Server ihn nicht selbst nutzen. Entferne das PCI-Gerät in den Hardware-Einstellungen der VM und starte den Server neu.");
    if (data.hint === "none") return callout("warn", "Kein Audio-Chip gefunden",
      "Der Server meldet keine Soundkarte. Ist der Ton im BIOS abgeschaltet? Alternativ funktioniert eine kleine USB-Soundkarte.");
    const b = h("button", { class: "btn sm" }, icon("refresh", "sm"), "Treiber laden");
    b.addEventListener("click", () => withBusy(b, async () => {
      try { await api("/audio/driver", { method: "POST" }); toast("Soundtreiber geladen"); load(); } catch (e) { errorToast(e); }
    }));
    return h("div", { class: "stack" }, callout("warn", "Soundtreiber nicht aktiv", "Der Audio-Chip ist da, aber der Treiber ist nicht geladen."), h("div", null, b));
  }

  function drawSetup() {
    playerCard.append(
      h("div", { class: "card-head" }, icon("speaker"), h("h3", null, "Schritt 1 · Player auf dem Server einrichten")),
      h("p", { class: "muted", style: { marginTop: "-6px" } },
        "Es wird ein winziger Container (256 MB RAM, 2 GB Platte) angelegt, der den Audio-Ausgang dieses Servers bekommt. ",
        "Darin läuft Squeezelite – ein schlanker Player, den Music Assistant automatisch findet. Home Assistant selbst wird dabei nicht verändert."),
      !data.pve_ok ? callout("warn", "Proxmox VE 8.1 oder neuer nötig", "Bitte zuerst die Updates installieren.") : null,
      hardwareHint(),
      data.outputs.length ? setupForm(null) : null);
  }

  // ---------- Eingerichteter Player ----------
  function drawPlayer(p, out, playerOk) {
    const kv = (k, v) => h("div", null, h("span", null, k), h("strong", null, v ?? "–"));
    const testBtn = h("button", { class: "btn primary", disabled: !p.running }, icon("volume", "sm"), "Testton abspielen");
    testBtn.addEventListener("click", () => withBusy(testBtn, async () => {
      toast("Testton läuft", "Du solltest jetzt nacheinander „Front Left“ und „Front Right“ hören.", "info");
      try { await api("/audio/test", { method: "POST" }); } catch (e) { errorToast(e); }
    }));
    const restartBtn = h("button", { class: "btn" }, icon("restart", "sm"), p.running ? "Neu starten" : "Starten");
    restartBtn.addEventListener("click", () => withBusy(restartBtn, async () => {
      try { await api("/audio/restart", { method: "POST" }); toast("Player neu gestartet"); await load(); } catch (e) { errorToast(e); }
    }));
    const editBtn = h("button", { class: "btn", onclick: () => openSheet((sheet, close) => {
      sheet.append(h("h2", null, "Player ändern"), h("p", { class: "sheet-sub" }, "Ausgang, Name oder Verbindung anpassen. Der Player startet dabei kurz neu."),
        setupForm(p, close));
    }) }, icon("edit", "sm"), "Ändern");
    const removeBtn = h("button", { class: "btn danger-ghost" }, icon("trash", "sm"), "Entfernen");
    removeBtn.addEventListener("click", async () => {
      if (!await confirmDialog({ title: "Musik-Player entfernen?", text: `Der Container ${p.vmid} wird gelöscht. In Music Assistant verschwindet „${p.name}“ dann als Player.`, confirmText: "Entfernen", danger: true })) return;
      try { const r = await api("/audio/remove", { method: "POST" }); go(`job/${r.data.id}`); } catch (e) { errorToast(e); }
    });

    const vol = h("input", { type: "range", min: 0, max: 100, step: 1, value: p.volume ?? 85, disabled: !p.running });
    const volLabel = h("span", { class: "v" }, `${p.volume ?? 85} %`);
    vol.addEventListener("input", () => { volLabel.textContent = `${vol.value} %`; });
    vol.addEventListener("change", async () => {
      try { await api("/audio/volume", { method: "POST", body: { value: Number(vol.value) } }); p.volume = Number(vol.value); } catch (e) { errorToast(e); }
    });

    playerCard.append(
      h("div", { class: "card-head" }, icon("speaker"), h("h3", null, `Player „${p.name}“`),
        h("span", { class: `badge ${playerOk ? "ok" : "warn"}` }, playerOk ? "Bereit" : p.running ? "Dienst gestoppt" : "Aus")),
      !playerOk ? h("div", { style: { marginBottom: "14px" } }, callout("warn", p.running ? "Der Player-Dienst läuft nicht" : "Der Container ist ausgeschaltet",
        "Tipp: Neu starten. Hilft das nicht, „Ändern“ → „Übernehmen“ richtet ihn neu ein.")) : null,
      !out ? h("div", { style: { marginBottom: "14px" } }, callout("warn", "Der eingestellte Ausgang ist nicht mehr da", "Wähle unter „Ändern“ einen anderen Ausgang.")) : null,
      h("div", { class: "kv", style: { marginBottom: "16px" } },
        kv("Ausgang", out ? `${KIND[out.kind]} · ${out.name}` : p.device),
        kv("Container", h("a", { href: `#/guest/lxc/${p.vmid}` }, `${p.vmid} · musik-player`)),
        kv("Music Assistant", p.server ? `fest: ${p.server}` : "automatisch gefunden")),
      field("Grundlautstärke des Ausgangs", h("div", { class: "vol-row" }, icon("volume", "sm"), vol, volLabel),
        "Einmal passend einstellen – die normale Lautstärke regelst du dann in Music Assistant, Spotify oder am iPhone."),
      h("div", { class: "action-bar", style: { marginTop: "6px" } }, testBtn, restartBtn, editBtn, removeBtn));
  }

  // ---------- Anleitung Music Assistant ----------
  function drawHowto(name, playerOk) {
    const path = (...parts) => h("div", { class: "path" }, parts.flatMap((x, i) => i ? [icon("chevronRight", "sm"), h("b", null, x)] : [h("b", null, x)]));
    const step = (slug, title, text, pth, note) => h("div", { class: "howto" },
      appAvatar(slug, title, { size: 42 }),
      h("div", { class: "grow" }, h("h4", null, title), text ? h("p", null, text) : null, pth, note ? h("div", { class: "muted", style: { fontSize: "13px" } }, note) : null));
    const haLink = ha?.ip ? h("a", { class: "btn", href: `http://${ha.ip}:8123/`, target: "_blank", rel: "noopener" }, icon("external", "sm"), "Home Assistant öffnen") : null;
    clear(howtoCard).append(
      h("div", { class: "card-head" }, icon("sparkle"), h("h3", null, "Schritt 2 · In Music Assistant verbinden")),
      !playerOk ? h("p", { class: "muted", style: { marginTop: "-6px" } }, "Erst den Player oben einrichten – dann diese Schritte in Music Assistant (in Home Assistant links in der Seitenleiste).") : null,
      step("music-assistant", "Player in Music Assistant aufnehmen",
        `Einmalig: Damit Music Assistant „${name}“ findet, braucht es den Squeezelite-Anbieter (falls noch nicht vorhanden).`,
        path("Einstellungen", "Anbieter", "Anbieter hinzufügen", "Squeezelite"),
        `Kurz danach steht „${name}“ unter Player. Ab jetzt kannst du in Music Assistant Musik darauf abspielen.`),
      step("spotify", "Als Spotify-Ziel (Spotify Connect)", "Damit „" + name + "“ in der Spotify-App unter „Geräte“ auftaucht:",
        path("Einstellungen", "Plugins", "Plugin hinzufügen", "Spotify Connect", `Player: ${name}`),
        "Pro Player einmal hinzufügen. Spotify Connect braucht in der Regel ein Premium-Konto; Befehle kommen mit 1–5 s Verzögerung an."),
      step("apple", "Als AirPlay-Ziel", "Damit iPhone, iPad und Mac auf „" + name + "“ streamen können:",
        path("Einstellungen", "Plugins", "Plugin hinzufügen", "AirPlay Receiver", `Player: ${name}`),
        "Dann im Kontrollzentrum auf das AirPlay-Symbol tippen und „" + name + "“ wählen. Rechne mit etwa 5 s Verzögerung bei Start und Pause."),
      step("google-home", "Google Cast", "Music Assistant kann (noch) nicht als Google-Cast-Ziel auftreten – Chromecast-Lautsprecher kann es nur ansteuern, nicht ersetzen.",
        null, "Alternativen auf Android: Spotify klappt über Spotify Connect (oben). Für andere Apps gibt es in Music Assistant das Plugin „AriaCast Receiver“ zusammen mit der AriaCast-App."),
      haLink ? h("div", { class: "row wrap", style: { marginTop: "8px" } }, haLink) : null);

    clear(helpCard).append(
      h("summary", { style: { cursor: "pointer", fontWeight: 650, fontSize: "16px" } }, "Kein Ton oder Player taucht nicht auf?"),
      h("ul", { class: "plain-list", style: { marginTop: "12px" } },
        h("li", null, "Erst den ", h("strong", null, "Testton"), " probieren. Kommt der an, stimmt die Verbindung Server → Anlage."),
        h("li", null, "Kein Testton: Steckt das Kabel in der richtigen Buchse (Kopfhörer bzw. Line-Out)? Ist an der Anlage der richtige Eingang (AUX) gewählt? Grundlautstärke hochdrehen."),
        h("li", null, "Testton ja, aber nichts in Music Assistant: Ist der Anbieter „Squeezelite“ hinzugefügt? Sonst unter „Ändern → Erweitert“ die Adresse von Home Assistant fest eintragen."),
        h("li", null, "Nicht gleichzeitig die Home-Assistant-Integration „SlimProto“ oder einen Lyrion Music Server nutzen – die streiten sich um den Player."),
        h("li", null, "USB-Soundkarte nachträglich eingesteckt? Unter „Ändern“ einfach „Übernehmen“ – dann wird sie an den Player durchgereicht.")));
  }

  await load();
  // Nur nachladen, wenn es einen Player gibt (sonst gingen Eingaben im Formular verloren)
  page.every(15000, () => { if ((data?.player || data?.busy) && !document.querySelector(".overlay")) load(); });
}
