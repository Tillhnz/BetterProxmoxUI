import {
  h, icon, clear, api, state, toast, errorToast, openSheet, confirmDialog, withBusy, pageHead, callout, loader, empty, relTime, appAvatar, setAppIndex,
} from "../core.js";

const KIND_LABEL = { ct: "Container", vm: "VM", tool: "Proxmox-Werkzeug" };
const CAT_ORDER = ["Smart Home", "Netzwerk", "Medien", "Daten", "Werkzeuge", "KI", "Betriebssysteme", "Proxmox-Pflege"];

// ---------------------------------------------------------------------------
// App-Katalog
// ---------------------------------------------------------------------------
export async function renderApps({ page, el, go }) {
  el.append(pageHead("Apps", "Fertige Installationen aus den Proxmox Community-Scripts – über 400 Programme."));
  const jobsBox = h("div");
  const notice = h("div");
  const controls = h("div", { class: "stack", style: { marginBottom: "16px" } });
  const results = h("div", null, loader());
  el.append(jobsBox, notice, controls, results);

  let items = [];
  let tab = "featured";
  let q = "";
  let limit = 120;

  try {
    const res = await api("/scripts");
    items = res.data || [];
    setAppIndex(items, res.aliases);
    if (!res.host_admin) {
      notice.append(h("div", { style: { marginBottom: "16px" } }, callout("warn", "Nur mit root-Zugang",
        state.user.host_actions ? "Apps werden direkt auf dem Proxmox-Server installiert. Das darf – wie in Proxmox selbst – nur der Benutzer root@pam." : "Host-Aktionen sind in den Einstellungen abgeschaltet.")));
    }
  } catch (e) { clear(results).append(callout("bad", "Katalog nicht verfügbar", e.message)); return; }

  const search = h("input", { class: "input", placeholder: "App suchen, z. B. Home Assistant …", oninput: (e) => { q = e.target.value.toLowerCase().trim(); limit = 120; draw(); } });
  const chips = h("div", { class: "chips" });
  controls.append(h("div", { class: "input-wrap" }, icon("search", "sm"), search), chips);

  function drawChips() {
    clear(chips);
    for (const [k, label] of [["featured", "Empfohlen"], ["ct", "Alle Container"], ["vm", "VMs"], ["tool", "Proxmox-Pflege"]]) {
      chips.append(h("button", { class: `chip ${tab === k ? "active" : ""}`, onclick: () => { tab = k; limit = 120; drawChips(); draw(); } }, label));
    }
  }

  function card(it) {
    return h("div", { class: "card clickable", style: { display: "flex", gap: "14px", alignItems: "flex-start", padding: "16px" }, onclick: () => appSheet(it, go) },
      appAvatar(it.logo, it.title, { key: it.path }),
      h("div", { style: { minWidth: 0, flex: 1 } },
        h("div", { style: { fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, it.title),
        h("div", { class: "muted small", style: { marginTop: "2px", display: "-webkit-box", WebkitLineClamp: "2", WebkitBoxOrient: "vertical", overflow: "hidden" } },
          it.description || KIND_LABEL[it.kind]),
        it.description ? h("span", { class: `badge ${it.kind === "vm" ? "info" : it.kind === "tool" ? "" : "accent"}`, style: { marginTop: "8px" } }, KIND_LABEL[it.kind]) : null));
  }

  function draw() {
    clear(results);
    let list = items;
    if (q) {
      list = items.filter(i => i.title.toLowerCase().includes(q) || i.path.toLowerCase().includes(q) || (i.description || "").toLowerCase().includes(q));
    } else if (tab === "featured") {
      const byCat = {};
      for (const it of items.filter(i => i.featured)) (byCat[it.category || "Weitere"] ||= []).push(it);
      for (const cat of [...CAT_ORDER, ...Object.keys(byCat).filter(c => !CAT_ORDER.includes(c))]) {
        if (!byCat[cat]) continue;
        results.append(h("h2", { class: "section", style: { marginTop: "18px" } }, cat), h("div", { class: "grid cols-3" }, byCat[cat].map(card)));
      }
      return;
    } else {
      list = items.filter(i => i.kind === tab);
    }
    if (!list.length) { results.append(empty("search", "Nichts gefunden", "Versuche einen anderen Begriff – z. B. den englischen Namen.")); return; }
    results.append(h("p", { class: "muted small" }, `${list.length} Treffer`), h("div", { class: "grid cols-3" }, list.slice(0, limit).map(card)));
    if (list.length > limit) results.append(h("div", { style: { textAlign: "center", marginTop: "16px" } },
      h("button", { class: "btn", onclick: () => { limit += 200; draw(); } }, `Weitere ${Math.min(200, list.length - limit)} anzeigen`)));
  }

  async function loadJobs() {
    try {
      const res = await api("/jobs");
      const running = (res.data || []).filter(j => j.running);
      clear(jobsBox);
      if (running.length) {
        jobsBox.append(h("div", { class: "card pad-0", style: { marginBottom: "16px" } }, h("div", { class: "list" }, running.map(j =>
          h("a", { class: "list-item clickable", href: `#/job/${j.id}`, style: { color: "var(--text)" } },
            h("div", { class: "guest-icon ct" }, icon("spinner", "spin")),
            h("div", { class: "grow" }, h("div", { class: "title" }, j.title), h("div", { class: "meta" }, `Läuft seit ${relTime(j.started).replace("vor ", "")} · tippen, um zuzuschauen`)),
            icon("chevronRight", "sm"))))));
      }
    } catch { /* egal */ }
  }

  drawChips(); draw(); loadJobs();
  page.every(5000, loadJobs);
}

function appSheet(it, go) {
  openSheet((sheet, close) => {
    const btn = h("button", { class: "btn primary" }, icon("download", "sm"), "Installieren");
    const allowed = state.user.host_admin;
    if (!allowed) btn.disabled = true;
    btn.addEventListener("click", () => withBusy(btn, async () => {
      try {
        const res = await api("/jobs", { method: "POST", body: { kind: "script", path: it.path, title: it.title } });
        close(); go(`job/${res.data.id}`);
      } catch (e) { errorToast(e); }
    }));
    const src = `https://github.com/community-scripts/ProxmoxVE/blob/main/${it.path}`;
    sheet.append(
      h("div", { class: "row", style: { gap: "14px", marginBottom: "14px" } },
        appAvatar(it.logo, it.title, { size: 56, key: it.path }),
        h("div", null, h("h2", { style: { margin: 0 } }, it.title), h("div", { class: "muted" }, KIND_LABEL[it.kind]))),
      it.description ? h("p", null, it.description) : null,
      h("div", { class: "stack" },
        callout("info", "So funktioniert’s", it.kind === "tool"
          ? "Das Werkzeug läuft direkt auf deinem Proxmox-Server. Ein Terminal zeigt dir die Fragen an – mit den Tasten unten auswählen und bestätigen."
          : "Es öffnet sich ein Installations-Assistent. Wähle am Anfang „Default Settings“ bzw. „Standard“ – dann wird alles mit sinnvollen Werten eingerichtet. Mit den Pfeiltasten auswählen, mit Enter bestätigen."),
        callout("warn", null, "Das Skript stammt aus dem Community-Projekt „community-scripts“ und läuft mit Administratorrechten auf deinem Server. Es ist weit verbreitet, aber nicht von Proxmox selbst."),
        !allowed ? callout("bad", null, "Nur root@pam darf Apps installieren.") : null),
      h("p", { class: "small" }, h("a", { href: src, target: "_blank", rel: "noopener" }, icon("external", "sm"), " Skript ansehen")),
      h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Abbrechen"), btn));
  });
}

// ---------------------------------------------------------------------------
// Terminal für laufende Aufgaben
// ---------------------------------------------------------------------------
let xtermPromise = null;
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
}
function loadCss(href) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; document.head.appendChild(l); }

function loadXterm() {
  if (xtermPromise) return xtermPromise;
  xtermPromise = (async () => {
    try {
      await loadScript("/static/vendor/xterm/xterm.js");
      await loadScript("/static/vendor/xterm/addon-fit.js");
      loadCss("/static/vendor/xterm/xterm.css");
    } catch {
      const cdn = "https://cdn.jsdelivr.net/npm";
      await loadScript(`${cdn}/@xterm/xterm@5.5.0/lib/xterm.js`);
      await loadScript(`${cdn}/@xterm/addon-fit@0.10.0/lib/addon-fit.js`);
      loadCss(`${cdn}/@xterm/xterm@5.5.0/css/xterm.css`);
    }
    return { Terminal: window.Terminal, FitAddon: window.FitAddon.FitAddon };
  })();
  return xtermPromise;
}

export async function renderJob({ page, el, go }, id) {
  if (!/^[0-9a-f]{12}$/.test(id || "")) return go("apps");
  let info = null;
  try { info = (await api("/jobs")).data.find(j => j.id === id); } catch { /* egal */ }
  if (!info) {
    el.append(h("a", { class: "back", href: "#/apps" }, icon("chevronLeft", "sm"), "Apps"), empty("terminal", "Aufgabe nicht gefunden", "Sie ist vermutlich schon länger beendet."));
    return;
  }
  // Je nach Art der Aufgabe: wohin zurück, wie heißt „Beenden“, wie streng die Warnung
  const KIND = {
    shell: { back: ["#/node", "Server"], stop: "Konsole schließen", confirm: { title: "Konsole schließen?", text: "Befehle, die gerade in der Konsole laufen, werden dabei beendet.", confirmText: "Schließen" },
      hint: "Zum Beenden „exit“ eingeben oder oben auf „Konsole schließen“ tippen. Strg+C bricht einen laufenden Befehl ab." },
    upgrade: { back: ["#/updates", "Updates"], stop: "Abbrechen", confirm: { title: "Updates wirklich abbrechen?", text: "Ein Abbruch mitten in der Installation kann Proxmox beschädigen. Nur abbrechen, wenn sich seit vielen Minuten nichts mehr tut.", confirmText: "Trotzdem abbrechen", danger: true },
      hint: "Du kannst die Seite schließen – die Updates laufen weiter." },
    selfupdate: { back: ["#/updates", "Updates"], stop: "Abbrechen", confirm: { title: "Abbrechen?", text: "Die Oberfläche wird dann eventuell nicht vollständig aktualisiert.", confirmText: "Abbrechen", danger: true }, hint: "Die Seite lädt gleich neu." },
    script: { back: ["#/apps", "Apps"], stop: "Abbrechen", confirm: { title: "Installation abbrechen?", text: "Eine halb fertige Installation kann Reste hinterlassen (z. B. einen unfertigen Container).", confirmText: "Abbrechen", danger: true },
      hint: "Tipp: Für die meisten Fragen einfach „Enter“ drücken. Du kannst die Seite schließen – die Installation läuft weiter." },
  };
  const k = KIND[info.kind] || KIND.script;
  const isShell = info.kind === "shell";

  const badge = h("span", { class: "badge" });
  const endActions = h("div", { class: "row wrap hidden", style: { marginBottom: "12px" } });
  const setStatus = (running, code, killed) => {
    badge.className = `badge ${running ? "accent" : isShell || killed ? "" : code === 0 ? "ok" : "bad"}`;
    clear(badge).append(running ? (stopping ? "Wird beendet …" : "Läuft") : isShell ? "Geschlossen" : killed ? "Abgebrochen" : code === 0 ? "Erfolgreich beendet" : `Beendet mit Fehler (${code})`);
    killBtn.classList.toggle("hidden", !running);
    hint.classList.toggle("hidden", !running);
    endActions.classList.toggle("hidden", running);
    if (!running) {
      clear(endActions).append(
        isShell ? h("button", { class: "btn primary", onclick: async () => {
          try { const r = await api("/jobs", { method: "POST", body: { kind: "shell" } }); go(`job/${r.data.id}`); } catch (e) { errorToast(e); }
        } }, icon("terminal", "sm"), "Neue Konsole öffnen") : null,
        h("a", { class: `btn ${isShell ? "" : "primary"}`, href: k.back[0] }, icon("chevronLeft", "sm"), `Zurück zu ${k.back[1]}`));
    }
  };
  let stopping = false, killedHere = false;
  const killBtn = h("button", { class: `btn sm ${isShell ? "" : "danger-ghost"}` }, icon("x", "sm"), k.stop);
  killBtn.addEventListener("click", async () => {
    if (!await confirmDialog(k.confirm)) return;
    stopping = true; killedHere = true; killBtn.disabled = true; setStatus(true);
    try { await api(`/jobs/${id}/kill`, { method: "POST" }); } catch (e) { errorToast(e); stopping = false; killBtn.disabled = false; setStatus(true); }
  });
  const hint = h("div", { style: { marginBottom: "12px" } }, callout("info", null, k.hint));

  const box = h("div", { class: "term-box" });
  const keys = [["Enter", "\r"], ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["←", "\x1b[D"], ["→", "\x1b[C"], ["Tab", "\t"], ["Leertaste", " "], ["Esc", "\x1b"], ["y", "y"], ["n", "n"], ["Strg+C", "\x03"]];
  const keybar = h("div", { class: "keybar" });

  el.append(
    h("a", { class: "back", href: k.back[0] }, icon("chevronLeft", "sm"), k.back[1]),
    h("div", { class: "row wrap", style: { marginBottom: "12px", gap: "10px" } }, h("h1", { style: { margin: 0, fontSize: "22px", letterSpacing: "-.02em" } }, info.title), badge, h("span", { class: "spacer" }), killBtn),
    hint, endActions,
    h("div", { class: "term-shell" }, box, keybar));
  setStatus(info.running, info.exit_code, info.killed);

  let X;
  try { X = await loadXterm(); } catch { box.append(callout("bad", "Terminal konnte nicht geladen werden", "Bitte BetterProxmoxUI aktualisieren oder Internetverbindung prüfen.")); return; }
  const term = new X.Terminal({
    cursorBlink: true, fontSize: window.innerWidth < 600 ? 12 : 14, fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    theme: { background: "#0b0d10", foreground: "#d6dbe3", cursor: "#ff7a45", selectionBackground: "#ff7a4555" }, scrollback: 5000, convertEol: false,
  });
  const fit = new X.FitAddon();
  term.loadAddon(fit);
  term.open(box);
  try { fit.fit(); } catch { /* egal */ }

  let ws = null, closedByUs = false;
  const send = (obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  function connect() {
    term.reset();
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/jobs/${id}/ws`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => { try { fit.fit(); } catch { /* egal */ } send({ type: "resize", cols: term.cols, rows: term.rows }); };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        try { const m = JSON.parse(e.data); if (m.type === "exit") { stopping = false; setStatus(false, m.code, m.killed || info.killed || killedHere); notifyDone(m.code); } } catch { /* egal */ }
      } else term.write(new Uint8Array(e.data));
    };
    ws.onclose = () => {
      if (closedByUs) return;
      if (!badge.textContent.startsWith("Läuft") || stopping) return;
      toast("Verbindung unterbrochen", "Die Aufgabe läuft weiter.", "info", { actions: [{ label: "Neu verbinden", onClick: connect }] });
    };
  }
  let notified = false;
  function notifyDone(code) {
    if (notified || !info.running || isShell || killedHere) return; notified = true;
    toast(code === 0 ? `${info.title}: fertig` : `${info.title}: Fehler`, code === 0 ? "Scrolle im Terminal nach oben für Details wie Adresse oder Zugangsdaten." : "Details stehen im Terminal.", code === 0 ? "ok" : "bad", { timeout: 10000 });
  }
  term.onData((d) => send({ type: "input", data: d }));
  for (const [label, seq] of keys) keybar.append(h("button", { onclick: () => { send({ type: "input", data: seq }); term.focus(); } }, label));

  const ro = new ResizeObserver(() => { try { fit.fit(); send({ type: "resize", cols: term.cols, rows: term.rows }); } catch { /* egal */ } });
  ro.observe(box);
  connect();
  page.onLeave(() => { closedByUs = true; ro.disconnect(); try { ws.close(); } catch { /* egal */ } term.dispose(); });
}
