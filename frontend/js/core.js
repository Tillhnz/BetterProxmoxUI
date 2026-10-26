// ===========================================================================
// Kern: DOM-Helfer, Icons, API, Formatierung, Toasts, Dialoge, Aufgaben
// ===========================================================================

// append()/replaceChildren() sollen null/false einfach überspringen (statt "null" anzuzeigen)
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const m of ["append", "prepend", "replaceChildren"]) {
    const orig = proto[m];
    proto[m] = function (...nodes) { return orig.apply(this, nodes.flat(Infinity).filter(n => n !== null && n !== undefined && n !== false)); };
  }
}

export const state = {
  user: null,
  node: null,
  nodes: [],
  updatesCount: 0,
};

// ---------- DOM ----------
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "html") el.innerHTML = v; // nur für statische, eigene Inhalte (Icons)
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

// ---------- Icons (eigene, schlichte Strichgrafiken) ----------
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  apps: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  restart: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  memory: '<rect x="2.5" y="7" width="19" height="10" rx="2"/><path d="M6 11v2M10 11v2M14 11v2M18 11v2M6 17v3M18 17v3"/>',
  disk: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  network: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-2h12v2"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  check: '<path d="M5 12.5 10 17 19 7"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  xCircle: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  chevronLeft: '<path d="m15 6-6 6 6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  camera: '<path d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  spinner: '<path d="M12 3a9 9 0 1 0 9 9" />',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
};

export function icon(name, cls = "") {
  const span = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  span.setAttribute("viewBox", "0 0 24 24");
  span.setAttribute("class", `i ${cls}`.trim());
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = P[name] || P.info;
  return span;
}

// ---------- API ----------
export class ApiError extends Error {
  constructor(status, message, errors) { super(message); this.status = status; this.errors = errors; }
}

export async function api(path, { method = "GET", body, query } = {}) {
  let url = "/api" + path;
  if (query) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") q.set(k, v);
    const s = q.toString();
    if (s) url += (url.includes("?") ? "&" : "?") + s;
  }
  const opts = { method, headers: { "X-BPUI": "1" }, credentials: "same-origin" };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opts); }
  catch { throw new ApiError(0, "Keine Verbindung zum Server"); }
  let data = {};
  try { data = await res.json(); } catch { /* leer */ }
  if (!res.ok) {
    if (res.status === 401 && path !== "/login" && path !== "/me" && !path.startsWith("/login")) {
      window.dispatchEvent(new Event("bpui:logout"));
    }
    let msg = data.error || `Fehler ${res.status}`;
    if (data.errors && typeof data.errors === "object") {
      const detail = Object.entries(data.errors).map(([k, v]) => `${k}: ${v}`).join(", ");
      if (detail) msg += ` (${detail})`;
    }
    throw new ApiError(res.status, msg, data.errors);
  }
  return data;
}

/** Proxmox-API über den Proxy. Pfadsegmente werden sicher kodiert. */
export async function pve(method, path, body) {
  const res = await api("/pve" + path, method === "GET" ? { query: body } : { method, body: body || {} });
  return res.data;
}
export const enc = encodeURIComponent;
export const nodePath = (p = "") => `/nodes/${enc(state.node)}${p}`;

// ---------- Formatierung ----------
export function bytes(n, digits = 1) {
  if (n === undefined || n === null || isNaN(n)) return "–";
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0; let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i < 2 ? 0 : digits).replace(".", ",")} ${u[i]}`;
}
export function pct(v, max) { if (!max) return 0; return Math.max(0, Math.min(100, (v / max) * 100)); }
export function num(v, d = 0) { return Number(v).toFixed(d).replace(".", ","); }
export function uptime(s) {
  if (!s) return "–";
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d} ${d === 1 ? "Tag" : "Tage"}, ${hh} Std.`;
  if (hh) return `${hh} Std. ${m} Min.`;
  return `${m} Min.`;
}
export function dateTime(ts) {
  if (!ts) return "–";
  const d = new Date(ts * 1000);
  return d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function relTime(ts) {
  if (!ts) return "–";
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "gerade eben";
  if (diff < 3600) return `vor ${Math.floor(diff / 60)} Min.`;
  if (diff < 86400) return `vor ${Math.floor(diff / 3600)} Std.`;
  if (diff < 86400 * 7) { const d = Math.floor(diff / 86400); return `vor ${d} ${d === 1 ? "Tag" : "Tagen"}`; }
  return dateTime(ts);
}
export function level(p) { return p > 90 ? "bad" : p > 75 ? "warn" : ""; }
export function meter(p, cls = "") {
  return h("div", { class: `meter ${level(p)} ${cls}` }, h("i", { style: { width: `${p.toFixed(1)}%` } }));
}
export function ring(p, label) {
  const c = p > 90 ? "var(--bad)" : p > 75 ? "var(--warn)" : "var(--ok)";
  return h("div", { class: "ring", style: { "--p": p.toFixed(0), "--c": c } }, h("span", null, label ?? `${p.toFixed(0)}%`));
}
export function colorFor(text) {
  let hsh = 0; for (const ch of text) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${hsh % 360} 62% 50%)`;
}

// ---------- Toasts ----------
export function toast(title, text = "", kind = "ok", { timeout = 4500, actions = [] } = {}) {
  const box = document.getElementById("toasts");
  const ico = kind === "ok" ? icon("checkCircle") : kind === "bad" ? icon("xCircle") : kind === "busy" ? icon("spinner", "spin") : icon("info");
  const t = h("div", { class: `toast ${kind}` },
    h("div", { class: "t-ico" }, ico),
    h("div", { class: "t-body" },
      h("div", { class: "t-title" }, title),
      text ? h("div", { class: "t-text" }, text) : null,
      actions.length ? h("div", { class: "t-actions" }, actions.map(a => h("button", { class: "btn sm", onclick: () => { a.onClick(); close(); } }, a.label))) : null,
    ),
    h("button", { class: "x", onclick: () => close(), "aria-label": "Schließen" }, icon("x", "sm")),
  );
  box.appendChild(t);
  let timer = timeout ? setTimeout(() => close(), timeout) : null;
  function close() { clearTimeout(timer); t.remove(); }
  return {
    el: t, close,
    update(newTitle, newText, newKind, opts = {}) {
      clearTimeout(timer);
      const fresh = toast(newTitle, newText, newKind, opts);
      t.replaceWith(fresh.el);
      return fresh;
    },
  };
}
export function errorToast(e, title = "Das hat nicht geklappt") { toast(title, e?.message || String(e), "bad", { timeout: 8000 }); }

// ---------- Sheets / Dialoge ----------
export function openSheet(build, { wide = false, onClose } = {}) {
  const sheet = h("div", { class: `sheet ${wide ? "wide" : ""}`, role: "dialog", "aria-modal": "true" });
  const overlay = h("div", { class: "overlay" }, sheet);
  let closed = false;
  const close = (result) => {
    if (closed) return; closed = true;
    overlay.remove(); document.removeEventListener("keydown", onKey);
    onClose && onClose(result);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);
  build(sheet, close);
  document.body.appendChild(overlay);
  const first = sheet.querySelector("input, select, textarea");
  if (first && window.matchMedia("(min-width: 861px)").matches) setTimeout(() => first.focus(), 50);
  return close;
}

export function confirmDialog({ title, text, confirmText = "Bestätigen", danger = false, typeToConfirm = null, extra = null }) {
  return new Promise((resolve) => {
    openSheet((sheet, close) => {
      let input = null;
      const btn = h("button", { class: `btn ${danger ? "danger" : "primary"}`, onclick: () => close(true) }, confirmText);
      if (typeToConfirm) {
        btn.disabled = true;
        input = h("input", { class: "input", autocomplete: "off", placeholder: typeToConfirm,
          oninput: () => { btn.disabled = input.value.trim() !== String(typeToConfirm); } });
      }
      sheet.append(
        h("h2", null, title),
        text ? h("p", { class: "sheet-sub" }, text) : null,
        extra,
        typeToConfirm ? h("div", { class: "field" }, h("label", null, `Zum Bestätigen „${typeToConfirm}“ eingeben`), input) : null,
        h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close(false) }, "Abbrechen"), btn),
      );
    }, { onClose: (r) => resolve(!!r) });
  });
}

export async function withBusy(btn, fn) {
  const old = Array.from(btn.childNodes);
  btn.disabled = true;
  clear(btn).append(icon("spinner", "spin sm"), " Bitte warten …");
  try { return await fn(); }
  finally { btn.disabled = false; clear(btn).append(...old); }
}

// ---------- Formularbausteine ----------
export function field(label, control, hint, err) {
  return h("div", { class: "field" }, h("label", null, label), control, hint ? h("div", { class: "hint" }, hint) : null, err || null);
}
export function input(attrs = {}) { return h("input", { class: "input", ...attrs }); }
export function select(options, value, attrs = {}) {
  const el = h("select", { class: "input", ...attrs });
  for (const o of options) {
    const opt = h("option", { value: o.value }, o.label);
    if (String(o.value) === String(value)) opt.selected = true;
    if (o.disabled) opt.disabled = true;
    el.appendChild(opt);
  }
  return el;
}
export function toggle(title, sub, checked, onChange) {
  const cb = h("input", { type: "checkbox" });
  cb.checked = !!checked;
  cb.addEventListener("change", () => onChange && onChange(cb.checked));
  return h("label", { class: "toggle" }, cb, h("span", { class: "sw" }),
    h("span", { class: "t-text" }, h("strong", null, title), sub ? h("span", null, sub) : null));
}
export function segmented(options, value, onChange) {
  const wrap = h("div", { class: "segmented" });
  for (const o of options) {
    const b = h("button", { type: "button", class: o.value === value ? "active" : "" }, o.label);
    b.addEventListener("click", () => {
      wrap.querySelectorAll("button").forEach(x => x.classList.remove("active"));
      b.classList.add("active"); onChange(o.value);
    });
    wrap.appendChild(b);
  }
  return wrap;
}
export function callout(kind, title, text, ico) {
  return h("div", { class: `callout ${kind}` }, icon(ico || (kind === "warn" ? "alert" : kind === "bad" ? "xCircle" : kind === "ok" ? "checkCircle" : "info")),
    h("div", null, title ? h("strong", null, title) : null, text ? h("p", null, text) : null));
}
export function empty(ico, title, text, action) {
  return h("div", { class: "empty" }, h("div", { class: "e-ico" }, icon(ico, "lg")), h("h3", null, title), text ? h("p", null, text) : null, action || null);
}
export function loader() { return h("div", { class: "loader" }, icon("spinner", "spin lg")); }
export function pageHead(title, sub, actions = []) {
  return h("div", { class: "page-head" }, h("div", null, h("h1", null, title), sub ? h("p", null, sub) : null),
    actions.length ? h("div", { class: "actions" }, actions) : null);
}

// ---------- Proxmox-Aufgaben (UPIDs) verfolgen ----------
const TASK_NAMES = {
  qmstart: "VM starten", qmstop: "VM stoppen", qmshutdown: "VM herunterfahren", qmreboot: "VM neu starten",
  qmcreate: "VM anlegen", qmdestroy: "VM löschen", qmrestore: "VM wiederherstellen", qmsnapshot: "Snapshot erstellen",
  qmrollback: "Snapshot zurückspielen", qmdelsnapshot: "Snapshot löschen", qmclone: "VM klonen", qmigrate: "VM verschieben",
  vzstart: "Container starten", vzstop: "Container stoppen", vzshutdown: "Container herunterfahren", vzreboot: "Container neu starten",
  vzcreate: "Container anlegen", vzdestroy: "Container löschen", vzrestore: "Container wiederherstellen",
  vzsnapshot: "Snapshot erstellen", vzrollback: "Snapshot zurückspielen", vzdelsnapshot: "Snapshot löschen",
  vzdump: "Sicherung", aptupdate: "Paketlisten aktualisieren", download: "Download", imgdel: "Datei löschen",
  startall: "Alle Maschinen starten", stopall: "Alle Maschinen stoppen", srvreload: "Dienst neu laden", srvrestart: "Dienst neu starten",
  resize: "Speicher vergrößern", vncproxy: "Konsole", vncshell: "Host-Konsole", spiceproxy: "Konsole", termproxy: "Konsole",
};
export function parseUpid(upid) {
  const p = String(upid).split(":");
  return { node: p[1], type: p[5], id: p[6], user: p[7] };
}
export function taskName(type, id) {
  const n = TASK_NAMES[type] || type;
  return id ? `${n} (${id})` : n;
}

/** Wartet auf eine Proxmox-Aufgabe und zeigt Fortschritt als Toast. */
export async function trackTask(upid, title, { onDone, silent = false } = {}) {
  if (!upid || typeof upid !== "string" || !upid.startsWith("UPID:")) { onDone && onDone(true); return true; }
  const info = parseUpid(upid);
  title = title || taskName(info.type, info.id);
  let t = silent ? null : toast(title, "Läuft …", "busy", { timeout: 0 });
  const started = Date.now();
  while (true) {
    await new Promise(r => setTimeout(r, Date.now() - started < 10000 ? 1200 : 3000));
    let st;
    try { st = await pve("GET", `/nodes/${enc(info.node)}/tasks/${enc(upid)}/status`); }
    catch { continue; }
    if (st.status === "stopped") {
      const ok = st.exitstatus === "OK" || String(st.exitstatus || "").startsWith("WARNINGS");
      if (t) {
        t.update(ok ? `${title} – fertig` : `${title} – fehlgeschlagen`, ok ? "" : st.exitstatus, ok ? "ok" : "bad",
          { timeout: ok ? 4000 : 12000, actions: [{ label: "Protokoll", onClick: () => showTaskLog(upid, title) }] });
      }
      window.dispatchEvent(new Event("bpui:refresh"));
      onDone && onDone(ok, st);
      return ok;
    }
  }
}

export function showTaskLog(upid, title) {
  const info = parseUpid(upid);
  openSheet(async (sheet, close) => {
    const pre = h("div", { class: "log" }, "Lade Protokoll …");
    sheet.append(h("h2", null, title || taskName(info.type, info.id)), h("p", { class: "sheet-sub" }, `${info.node} · ${info.user}`), pre,
      h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Schließen")));
    let alive = true;
    const load = async () => {
      try {
        const lines = await pve("GET", `/nodes/${enc(info.node)}/tasks/${enc(upid)}/log`, { limit: 2000 });
        pre.textContent = lines.map(l => l.t).join("\n") || "(leer)";
        pre.scrollTop = pre.scrollHeight;
        const st = await pve("GET", `/nodes/${enc(info.node)}/tasks/${enc(upid)}/status`);
        if (alive && st.status === "running") setTimeout(load, 2000);
      } catch (e) { pre.textContent = e.message; }
    };
    load();
    const obs = new MutationObserver(() => { if (!document.body.contains(sheet)) { alive = false; obs.disconnect(); } });
    obs.observe(document.body, { childList: true });
  }, { wide: true });
}

export function setUpdatesCount(n) {
  state.updatesCount = n;
  const b = document.getElementById("upd-badge");
  if (b) { b.textContent = n; b.classList.toggle("hidden", !n); }
}

export function setAdviceCount(n) {
  const b = document.getElementById("adv-badge");
  if (b) { b.textContent = n; b.classList.toggle("hidden", !n); }
}

// ---------- Sperren (lock) ----------
export const LOCK_TEXT = {
  backup: "Sicherung läuft oder wurde abgebrochen", snapshot: "Snapshot wird erstellt", "snapshot-delete": "Snapshot wird gelöscht",
  rollback: "Snapshot wird zurückgespielt", migrate: "Wird verschoben", clone: "Wird geklont", create: "Wird angelegt",
  disk: "Festplatte wird bearbeitet", mounted: "Festplatte ist auf dem Server eingehängt", suspending: "Wird in den Ruhezustand versetzt",
  suspended: "Im Ruhezustand", destroyed: "Wird gelöscht", fstrim: "Speicher wird aufgeräumt", copy: "Wird kopiert",
};
export function lockBadge(lock) {
  if (!lock) return null;
  return h("span", { class: "badge warn", title: LOCK_TEXT[lock] || lock }, icon("lock", "sm"), "Gesperrt");
}

// ---------- Kleinkram ----------
export function guestTypeLabel(t) { return t === "qemu" ? "VM" : "Container"; }
export function guestIcon(type, status, name) {
  const app = name ? detectApp(name) : null;
  const inner = app ? logoImg(app.logo, () => icon(type === "qemu" ? "monitor" : "box")) : icon(type === "qemu" ? "monitor" : "box");
  return h("div", { class: `guest-icon ${type === "qemu" ? "vm" : "ct"} ${app ? "has-logo" : ""}`, title: app ? app.title : null }, inner,
    h("span", { class: `status-dot ${status || ""}` }));
}

// ---------- App-Erkennung & Logos ----------
let appKeys = [];          // [{key, logo, title}] – längste Schlüssel zuerst
const appExact = new Map();
export const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function setAppIndex(items, aliases = {}) {
  appExact.clear();
  const add = (key, logo, title) => { if (key && logo && !appExact.has(key)) appExact.set(key, { logo, title }); };
  for (const it of items || []) {
    if (!it.logo || it.kind === "tool") continue;
    const base = it.path.split("/").pop().replace(/\.sh$/, "").replace(/-vm$/, "");
    const title = it.title.replace(/\s*\(.*\)$/, "");
    add(normName(base), it.logo, title);
    add(normName(title), it.logo, title);
    add(normName(it.logo), it.logo, title);
  }
  for (const [k, v] of Object.entries(aliases)) add(normName(k), v, v.split("-").map(w => w[0].toUpperCase() + w.slice(1)).join(" "));
  appKeys = [...appExact.entries()].filter(([k]) => k.length >= 4).map(([key, v]) => ({ key, ...v })).sort((a, b) => b.key.length - a.key.length);
}

/** Erkennt eine bekannte App am Namen einer Maschine, z. B. "immich-server" → Immich. */
export function detectApp(...names) {
  for (const n of names) {
    const k = normName(n);
    if (!k) continue;
    if (appExact.has(k)) return appExact.get(k);
  }
  for (const n of names) {
    const k = normName(n);
    if (!k) continue;
    const hit = appKeys.find(a => k.includes(a.key));
    if (hit) return hit;
  }
  return null;
}

export function logoImg(slug, fallback) {
  const img = h("img", { src: `/api/logo/${encodeURIComponent(slug)}`, alt: "", loading: "lazy", decoding: "async" });
  img.addEventListener("error", () => { const fb = fallback ? fallback() : null; if (fb) img.replaceWith(fb); else img.remove(); }, { once: true });
  return img;
}

/** Rundes App-Symbol: Logo, sonst farbige Initialen. */
export function appAvatar(slug, title, { size = 44, key } = {}) {
  const initials = String(title || "?").replace(/[^A-Za-z0-9 ]/g, "").split(" ").filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";
  const box = h("div", { class: "app-avatar", style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.38)}px` } });
  const showInitials = () => { box.classList.remove("logo"); box.style.background = colorFor(key || title || "?"); return document.createTextNode(initials); };
  if (slug) { box.classList.add("logo"); box.append(logoImg(slug, showInitials)); }
  else box.append(showInitials());
  return box;
}
export function statusBadge(status) {
  const map = { running: ["ok", "Läuft"], stopped: ["", "Aus"], paused: ["warn", "Pausiert"], suspended: ["warn", "Ruhezustand"] };
  const [cls, label] = map[status] || ["", status || "?"];
  return h("span", { class: `badge ${cls}` }, label);
}
export function validHostname(n) { return /^(?=.{1,63}$)[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(n); }
export function prettyTemplate(volid) {
  const file = String(volid).split("/").pop();
  const m = file.match(/^([a-z]+)-([0-9.]+)-([a-z]+)?/i);
  if (!m) return file;
  const names = { debian: "Debian", ubuntu: "Ubuntu", alpine: "Alpine", centos: "CentOS", fedora: "Fedora", rockylinux: "Rocky Linux",
    almalinux: "AlmaLinux", archlinux: "Arch Linux", opensuse: "openSUSE", devuan: "Devuan", gentoo: "Gentoo" };
  return `${names[m[1].toLowerCase()] || m[1]} ${m[2]}`;
}
export function debounce(fn, ms = 250) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---------- Diagramme (eigene, schlanke SVG-Liniendiagramme) ----------
export const TIMEFRAMES = [
  { value: "hour", label: "Stunde" }, { value: "day", label: "Tag" }, { value: "week", label: "Woche" },
  { value: "month", label: "Monat" }, { value: "year", label: "Jahr" },
];

/** Lädt Verlaufsdaten (RRD) eines Pfads, z. B. nodePath("/rrddata") oder nodePath("/lxc/100/rrddata"). */
export async function rrd(path, timeframe = "day", cf = "AVERAGE") {
  const rows = await pve("GET", path, { timeframe, cf });
  return (rows || []).filter(r => r && r.time).sort((a, b) => a.time - b.time);
}

export function percentile(values, p) {
  const v = values.filter(x => typeof x === "number" && !isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))];
}

/**
 * Liniendiagramm. series: [{ key, label, color, fn? (row → Wert) }]
 * opts: { height, fmt (Wert → Text), max (feste Obergrenze), stack }
 */
export function lineChart(rows, series, opts = {}) {
  const height = opts.height || 170;
  const fmt = opts.fmt || ((v) => String(Math.round(v)));
  const wrap = h("div", { class: "chart" });
  const tip = h("div", { class: "chart-tip hidden" });
  const legend = h("div", { class: "chart-legend" }, series.map(s => h("span", null, h("i", { style: { background: s.color } }), s.label)));
  const box = h("div", { class: "chart-box", style: { height: `${height}px` } });
  wrap.append(legend, box);
  box.append(tip);
  const val = (r, s) => { const v = s.fn ? s.fn(r) : r[s.key]; return typeof v === "number" && !isNaN(v) ? v : null; };
  if (!rows.length || !rows.some(r => series.some(s => val(r, s) !== null))) {
    box.append(h("div", { class: "muted small", style: { padding: "40px 0", textAlign: "center" } }, "Noch keine Daten für diesen Zeitraum."));
    return wrap;
  }
  const NS = "http://www.w3.org/2000/svg";
  const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  let svg = null, cursor = null, geom = null;

  function render() {
    const W = Math.max(200, box.clientWidth);
    const H = height, padL = 52, padR = 8, padT = 8, padB = 22;
    const t0 = rows[0].time, t1 = rows[rows.length - 1].time || t0 + 1;
    let max = opts.max ?? 0;
    if (opts.max === undefined) for (const r of rows) for (const s of series) { const v = val(r, s); if (v !== null && v > max) max = v; }
    if (!max) max = 1;
    max *= opts.max === undefined ? 1.12 : 1;
    const x = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - padR);
    const y = (v) => padT + (1 - v / max) * (H - padT - padB);
    if (svg) svg.remove();
    svg = mk("svg", { width: W, height: H, class: "chart-svg" });
    // Gitterlinien + Achsenbeschriftung
    for (let i = 0; i <= 3; i++) {
      const v = (max / 3) * i, yy = y(v);
      svg.append(mk("line", { x1: padL, x2: W - padR, y1: yy, y2: yy, class: "chart-grid" }));
      const t = mk("text", { x: padL - 6, y: yy + 4, "text-anchor": "end", class: "chart-axis" }); t.textContent = fmt(v); svg.append(t);
    }
    const span = t1 - t0;
    const fmtT = (ts) => { const d = new Date(ts * 1000); return span > 3 * 86400 ? d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) : d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }); };
    for (let i = 0; i <= 4; i++) {
      const ts = t0 + (span * i) / 4;
      const t = mk("text", { x: x(ts), y: H - 5, "text-anchor": i === 0 ? "start" : i === 4 ? "end" : "middle", class: "chart-axis" }); t.textContent = fmtT(ts); svg.append(t);
    }
    series.forEach((s, si) => {
      let d = "", area = "", started = false, firstX = 0, lastX = 0;
      for (const r of rows) {
        const v = val(r, s);
        if (v === null) { if (started && si === 0 && !opts.noArea) { area += `L${lastX},${y(0)}Z`; } started = false; continue; }
        const px = x(r.time), py = y(v);
        if (!started) { d += `M${px},${py}`; if (si === 0) { area += `M${px},${y(0)}L${px},${py}`; firstX = px; } started = true; }
        else { d += `L${px},${py}`; if (si === 0) area += `L${px},${py}`; }
        lastX = px;
      }
      if (si === 0 && started && !opts.noArea) area += `L${lastX},${y(0)}Z`;
      void firstX;
      if (si === 0 && area && !opts.noArea) svg.append(mk("path", { d: area, fill: s.color, opacity: 0.12 }));
      svg.append(mk("path", { d, fill: "none", stroke: s.color, "stroke-width": 1.8, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    });
    cursor = mk("line", { x1: 0, x2: 0, y1: padT, y2: H - padB, class: "chart-cursor", visibility: "hidden" });
    svg.append(cursor);
    box.insertBefore(svg, tip);
    geom = { x, padL, padR, W };
  }

  function show(clientX) {
    if (!geom) return;
    const rect = box.getBoundingClientRect();
    const px = clientX - rect.left;
    let best = 0, bd = Infinity;
    rows.forEach((r, i) => { const dd = Math.abs(geom.x(r.time) - px); if (dd < bd) { bd = dd; best = i; } });
    const r = rows[best];
    const cx = geom.x(r.time);
    cursor.setAttribute("x1", cx); cursor.setAttribute("x2", cx); cursor.setAttribute("visibility", "visible");
    clear(tip).append(h("div", { class: "muted" }, new Date(r.time * 1000).toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })),
      series.map(s => { const v = val(r, s); return h("div", null, h("i", { style: { background: s.color } }), `${s.label}: `, h("strong", null, v === null ? "–" : fmt(v))); }));
    tip.classList.remove("hidden");
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(cx + 10, 0), geom.W - tw - 4) + (cx + 10 + tw > geom.W ? -tw - 20 : 0)}px`;
  }
  box.addEventListener("pointermove", (e) => show(e.clientX));
  box.addEventListener("pointerdown", (e) => show(e.clientX));
  box.addEventListener("pointerleave", () => { tip.classList.add("hidden"); cursor && cursor.setAttribute("visibility", "hidden"); });
  const ro = new ResizeObserver(() => render());
  ro.observe(box);
  requestAnimationFrame(render);
  return wrap;
}

export function chartCard(title, chartEl, sub) {
  return h("div", { class: "card" }, h("div", { class: "row", style: { marginBottom: "6px" } }, h("h3", { style: { margin: 0 } }, title), sub ? h("span", { class: "muted small", style: { marginLeft: "auto" } }, sub) : null), chartEl);
}
