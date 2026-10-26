// ===========================================================================
// Proxmox Zentrale – App-Hülle, Navigation, Login
// ===========================================================================
import { h, icon, clear, api, pve, state, toast, errorToast, field, input, select, enc, openSheet, setUpdatesCount, setAppIndex } from "./js/core.js";
import { renderDashboard } from "./js/views/dashboard.js";
import { renderGuests, renderGuestDetail } from "./js/views/guests.js";
import { renderNew, renderNewLxc, renderNewVm } from "./js/views/create.js";
import { renderApps, renderJob } from "./js/views/apps.js";
import { renderBackups } from "./js/views/backups.js";
import { renderUpdates } from "./js/views/updates.js";
import { renderTasks } from "./js/views/tasks.js";
import { renderStorage } from "./js/views/storage.js";
import { renderAdvice } from "./js/views/advice.js";
import { renderStats } from "./js/views/stats.js";
import { renderNode } from "./js/views/node.js";
import { renderUsers } from "./js/views/users.js";

const app = document.getElementById("app");
let cleanup = [];          // Timer & Listener der aktuellen Seite
let mainEl = null;

const NAV = [
  { path: "dashboard", label: "Übersicht", icon: "home" },
  { path: "guests", label: "Maschinen", icon: "server" },
  { path: "new", label: "Neu anlegen", short: "Neu", icon: "plus" },
  { path: "apps", label: "Apps", icon: "apps" },
  { path: "storage", label: "Speicher & NAS", icon: "network" },
  { path: "advice", label: "Empfehlungen", icon: "shield" },
  { path: "stats", label: "Statistik", icon: "chart" },
  { path: "backups", label: "Sicherungen", icon: "archive" },
  { path: "updates", label: "Updates", icon: "refresh" },
  { path: "tasks", label: "Aktivität", icon: "list" },
  { path: "node", label: "Server", icon: "server", section: "System" },
  { path: "users", label: "Benutzer", icon: "user" },
];

// ---------- Seite-Kontext für Views ----------
export const page = {
  every(ms, fn) { const id = setInterval(() => { if (!document.hidden) fn(); }, ms); cleanup.push(() => clearInterval(id)); },
  on(evt, fn) { window.addEventListener(evt, fn); cleanup.push(() => window.removeEventListener(evt, fn)); },
  onLeave(fn) { cleanup.push(fn); },
};

// ---------- Router ----------
function route() {
  cleanup.forEach(f => { try { f(); } catch { /* egal */ } });
  cleanup = [];
  if (!state.user) return renderLogin();
  if (!mainEl) renderShell();
  const parts = (location.hash.replace(/^#\/?/, "") || "dashboard").split("/").map(decodeURIComponent);
  const [view, a, b] = parts;
  document.querySelectorAll("[data-nav]").forEach(el => {
    const p = el.dataset.nav;
    el.classList.toggle("active", p === view || (p === "guests" && view === "guest") || (p === "apps" && view === "job") ||
      (p === "new" && view === "new"));
  });
  clear(mainEl);
  window.scrollTo(0, 0);
  const ctx = { page, el: mainEl, go };
  const views = {
    dashboard: () => renderDashboard(ctx),
    guests: () => renderGuests(ctx),
    guest: () => renderGuestDetail(ctx, a, b),
    new: () => (a === "lxc" ? renderNewLxc(ctx) : a === "vm" ? renderNewVm(ctx) : renderNew(ctx)),
    apps: () => renderApps(ctx),
    job: () => renderJob(ctx, a),
    backups: () => renderBackups(ctx),
    updates: () => renderUpdates(ctx),
    tasks: () => renderTasks(ctx),
    storage: () => renderStorage(ctx),
    advice: () => renderAdvice(ctx),
    stats: () => renderStats(ctx),
    node: () => renderNode(ctx),
    users: () => renderUsers(ctx),
  };
  (views[view] || views.dashboard)();
}

export function go(path) { location.hash = "#/" + path; }

// ---------- App-Hülle ----------
function themeToggle() {
  const b = h("button", { class: "btn ghost icon sm", title: "Hell/Dunkel umschalten", onclick: () => {
    const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("bpui-theme", next); } catch { /* egal */ }
  } }, icon("moon", "sm"));
  return b;
}

function nodePicker() {
  if (state.nodes.length < 2) return null;
  return select(state.nodes.map(n => ({ value: n.node, label: n.node })), state.node, {
    style: { height: "38px", marginBottom: "12px" },
    onchange: (e) => { state.node = e.target.value; try { localStorage.setItem("bpui-node", state.node); } catch { /* egal */ } route(); },
  });
}

function renderShell() {
  clear(app);
  const initials = state.user.username.slice(0, 2).toUpperCase();
  const sidebar = h("aside", { class: "sidebar" },
    h("div", { class: "brand" }, h("div", { class: "brand-mark" }, icon("server", "sm")),
      h("div", null, "Proxmox Zentrale", h("small", null, state.node || ""))),
    nodePicker(),
    h("nav", { class: "nav" },
      NAV.slice(0, 5).map(n => h("a", { href: `#/${n.path}`, "data-nav": n.path }, icon(n.icon), n.label)),
      h("div", { class: "nav-section" }, "Pflege"),
      NAV.slice(5).map(n => [n.section ? h("div", { class: "nav-section" }, n.section) : null, h("a", { href: `#/${n.path}`, "data-nav": n.path }, icon(n.icon), n.label,
        n.path === "updates" ? h("span", { class: "badge count hidden", id: "upd-badge" }) : null,
        n.path === "advice" ? h("span", { class: "badge count hidden", id: "adv-badge" }) : null)]),
    ),
    h("div", { class: "sidebar-foot" },
      h("div", { class: "user-chip" }, h("div", { class: "avatar" }, initials),
        h("div", { style: { minWidth: 0, flex: 1 } }, h("div", { style: { fontWeight: 620, fontSize: "14px", overflow: "hidden", textOverflow: "ellipsis" } }, state.user.username),
          h("div", { class: "muted small" }, `Version ${state.user.version}`)),
        themeToggle(),
        h("button", { class: "btn ghost icon sm", title: "Abmelden", onclick: logout }, icon("logout", "sm"))),
    ),
  );

  const topbar = h("header", { class: "topbar" },
    h("div", { class: "brand" }, h("div", { class: "brand-mark" }, icon("server", "sm")), "Zentrale"),
    h("div", { class: "spacer" }),
    themeToggle(),
    h("button", { class: "btn ghost icon", title: "Mehr", onclick: openMoreMenu }, icon("menu")),
  );

  const bottom = h("nav", { class: "bottom-nav" },
    h("a", { href: "#/dashboard", "data-nav": "dashboard" }, icon("home"), "Übersicht"),
    h("a", { href: "#/guests", "data-nav": "guests" }, icon("server"), "Maschinen"),
    h("a", { href: "#/new", "data-nav": "new", class: "plus" }, icon("plus"), ""),
    h("a", { href: "#/apps", "data-nav": "apps" }, icon("apps"), "Apps"),
    h("a", { href: "#/backups", "data-nav": "backups" }, icon("archive"), "Sicherung"),
  );

  mainEl = h("main", { class: "main" });
  app.append(h("div", { class: "shell" }, sidebar, h("div", null, topbar, mainEl)), bottom);
}

function openMoreMenu() {
  openSheet((sheet, close) => {
    const item = (ico, label, onClick, extra) => h("div", { class: "list-item clickable", onclick: () => { close(); onClick(); } },
      h("div", { class: "guest-icon" }, icon(ico)), h("div", { class: "grow" }, h("div", { class: "title" }, label)), extra || icon("chevronRight", "sm"));
    sheet.append(
      h("h2", null, "Mehr"),
      h("p", { class: "sheet-sub" }, `Angemeldet als ${state.user.username}`),
      nodePicker(),
      h("div", { class: "card pad-0 flat" }, h("div", { class: "list" },
        item("shield", "Empfehlungen", () => go("advice")),
        item("chart", "Statistik", () => go("stats")),
        item("server", "Server", () => go("node")),
        item("user", "Benutzer", () => go("users")),
        item("network", "Speicher & NAS", () => go("storage")),
        item("refresh", "Updates", () => go("updates"), state.updatesCount ? h("span", { class: "badge count" }, state.updatesCount) : null),
        item("list", "Aktivität", () => go("tasks")),
        item("archive", "Sicherungen", () => go("backups")),
        item("logout", "Abmelden", logout),
      )),
      h("p", { class: "muted small", style: { textAlign: "center", marginTop: "16px" } }, `Proxmox Zentrale ${state.user.version}`),
    );
  });
}

async function logout() {
  try { await api("/logout", { method: "POST" }); } catch { /* egal */ }
  state.user = null; mainEl = null;
  location.hash = "";
  route();
}

// ---------- Login ----------
async function renderLogin() {
  mainEl = null;
  clear(app);
  let realms = [{ realm: "pam", comment: "Linux PAM", default: 1 }];
  const user = input({ autocomplete: "username", placeholder: "root", autocapitalize: "off", spellcheck: "false" });
  const pass = input({ type: "password", autocomplete: "current-password", placeholder: "••••••••" });
  const realmSel = select(realms.map(r => ({ value: r.realm, label: r.comment })), "pam");
  const err = h("div", { class: "callout bad hidden" });
  const btn = h("button", { class: "btn primary lg block", type: "submit" }, "Anmelden");
  const form = h("form", { class: "stack", style: { gap: "16px" } },
    field("Benutzername", user),
    field("Passwort", pass),
    field("Anmeldebereich", realmSel, "Meist „Linux PAM“ für den Benutzer root."),
    err, btn);

  api("/realms").then(r => {
    realms = r.data || realms;
    clear(realmSel);
    for (const rl of realms) {
      const o = h("option", { value: rl.realm }, rl.comment || rl.realm);
      if (rl.realm === "pam") o.selected = true;
      realmSel.appendChild(o);
    }
  }).catch(() => {});

  const showErr = (msg) => { clear(err).append(icon("xCircle"), h("div", null, h("p", null, msg))); err.classList.remove("hidden"); };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.classList.add("hidden");
    btn.disabled = true; btn.textContent = "Anmelden …";
    try {
      const res = await api("/login", { method: "POST", body: { username: user.value.trim(), password: pass.value, realm: realmSel.value } });
      if (res.need_tfa) return renderTfa(res.kinds || ["totp"]);
      await afterLogin(res.user);
    } catch (ex) {
      showErr(ex.message);
    } finally { btn.disabled = false; btn.textContent = "Anmelden"; }
  });

  app.append(h("div", { class: "login-wrap" },
    h("div", { class: "login-art" },
      h("div", { class: "brand" }, h("div", { class: "brand-mark" }, icon("server", "sm")), h("div", null, "Proxmox Zentrale", h("small", null, "Dein Server, einfach erklärt"))),
      h("h1", null, "Alles im Griff – ohne Fachchinesisch."),
      h("p", null, "Maschinen anlegen, Apps installieren, Sicherungen und Updates – mit deinem normalen Proxmox-Zugang."),
      h("div", { class: "login-features" }, ["Apps mit einem Klick", "Automatische Sicherungen", "Updates", "Nur im Heimnetz"].map(t => h("span", null, t))),
    ),
    h("div", { class: "login-panel" }, h("div", { class: "login-box" },
      h("h2", null, "Willkommen zurück"),
      h("p", null, "Melde dich mit deinen Proxmox-Zugangsdaten an."),
      form)),
  ));
  setTimeout(() => user.focus(), 50);
}

function renderTfa(kinds) {
  const panel = app.querySelector(".login-box");
  clear(panel);
  let kind = kinds.includes("totp") ? "totp" : kinds[0];
  const code = input({ inputmode: kind === "totp" ? "numeric" : "text", autocomplete: "one-time-code", placeholder: kind === "totp" ? "123456" : "" });
  const err = h("div", { class: "callout bad hidden" });
  const btn = h("button", { class: "btn primary lg block", type: "submit" }, "Bestätigen");
  const form = h("form", { class: "stack", style: { gap: "16px" } },
    kinds.length > 1 ? field("Art", select(kinds.map(k => ({ value: k, label: { totp: "Authenticator-App", yubico: "YubiKey OTP", recovery: "Wiederherstellungscode" }[k] || k })), kind,
      { onchange: (e) => { kind = e.target.value; } })) : null,
    field("Code", code, "Den aktuellen Code aus deiner Authenticator-App eingeben."),
    err, btn,
    h("button", { class: "btn ghost block", type: "button", onclick: renderLogin }, "Zurück"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      const res = await api("/login/tfa", { method: "POST", body: { code: code.value, kind } });
      await afterLogin(res.user);
    } catch (ex) {
      clear(err).append(icon("xCircle"), h("div", null, h("p", null, ex.message)));
      err.classList.remove("hidden");
      if (ex.status === 401) setTimeout(renderLogin, 2500);
    } finally { btn.disabled = false; }
  });
  panel.append(h("h2", null, "Zwei-Faktor-Anmeldung"), h("p", null, "Dein Konto ist zusätzlich geschützt."), form);
  setTimeout(() => code.focus(), 50);
}

async function afterLogin(user) {
  state.user = user;
  try {
    const nodes = await pve("GET", "/nodes");
    state.nodes = (nodes || []).sort((a, b) => a.node.localeCompare(b.node));
    let saved = null;
    try { saved = localStorage.getItem("bpui-node"); } catch { /* egal */ }
    state.node = state.nodes.find(n => n.node === saved)?.node || state.nodes.find(n => n.status === "online")?.node || state.nodes[0]?.node;
  } catch (e) { errorToast(e, "Server konnten nicht geladen werden"); }
  mainEl = null;
  if (!location.hash || location.hash === "#/") location.hash = "#/dashboard";
  route();
  checkUpdatesQuietly();
  // App-Katalog im Hintergrund laden → Logos für erkannte Apps
  api("/scripts").then(r => { setAppIndex(r.data, r.aliases); window.dispatchEvent(new Event("bpui:refresh")); }).catch(() => {});
}

async function checkUpdatesQuietly() {
  try {
    const list = await pve("GET", `/nodes/${enc(state.node)}/apt/update`);
    setUpdatesCount((list || []).length);
  } catch { /* keine Rechte o. ä. */ }
}

// ---------- Start ----------
try { const t = localStorage.getItem("bpui-theme"); if (t) document.documentElement.dataset.theme = t; } catch { /* egal */ }
window.addEventListener("hashchange", route);
window.addEventListener("bpui:logout", () => {
  if (state.user) { state.user = null; mainEl = null; toast("Abgemeldet", "Deine Sitzung ist abgelaufen. Bitte neu anmelden.", "info"); route(); }
});
(async () => {
  try {
    const r = await api("/me");
    await afterLogin(r.user);
  } catch { renderLogin(); }
})();
