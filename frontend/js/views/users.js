// ===========================================================================
// Benutzer & Rechte
// ===========================================================================
import {
  h, icon, clear, pve, state, enc, toast, errorToast, openSheet, confirmDialog, field, input, select, toggle, withBusy, pageHead,
  callout, loader, dateTime,
} from "../core.js";

// Verständliche Rollen statt der Proxmox-Fachbegriffe
const ROLE_PRESETS = [
  { role: "Administrator", label: "Administrator", text: "Darf alles – wie root." },
  { role: "PVEVMAdmin", label: "Maschinen verwalten", text: "Maschinen anlegen, ändern, löschen, sichern." },
  { role: "PVEVMUser", label: "Maschinen bedienen", text: "Starten, stoppen, Konsole und Sicherungen – aber nichts ändern." },
  { role: "PVEAuditor", label: "Nur ansehen", text: "Sieht alles, darf nichts ändern." },
];
const roleLabel = (r) => ROLE_PRESETS.find(p => p.role === r)?.label || r;

export async function renderUsers({ page, el }) {
  const addBtn = h("button", { class: "btn primary" }, icon("plus", "sm"), "Benutzer anlegen");
  el.append(pageHead("Benutzer", "Wer sich anmelden darf – und was er darf.", [addBtn]));
  const body = h("div", null, loader());
  el.append(body);

  async function load() {
    let users, acl, tfa;
    try {
      [users, acl, tfa] = await Promise.all([pve("GET", "/access/users", { full: 1 }), pve("GET", "/access/acl"), pve("GET", "/access/tfa").catch(() => [])]);
    } catch (e) { clear(body).append(callout("bad", "Laden fehlgeschlagen", e.message)); return; }
    const tfaOf = (u) => (tfa.find(t => t.userid === u)?.entries || []).filter(e => e.enable !== false && e.enable !== 0).length > 0;
    const rolesOf = (u) => acl.filter(a => a.type === "user" && a.ugid === u).map(a => ({ path: a.path, role: a.roleid }));
    users.sort((a, b) => (a.userid === "root@pam" ? -1 : b.userid === "root@pam" ? 1 : a.userid.localeCompare(b.userid)));
    clear(body).append(
      h("div", { class: "card pad-0" }, h("div", { class: "list" }, users.map(u => {
        const roles = rolesOf(u.userid);
        const enabled = u.enable !== 0 && u.enable !== "0";
        const expired = u.expire && u.expire * 1000 < Date.now();
        return h("div", { class: "list-item clickable", onclick: () => userSheet(u, roles, tfaOf(u.userid), load) },
          h("div", { class: "avatar" }, u.userid.slice(0, 2).toUpperCase()),
          h("div", { class: "grow" },
            h("div", { class: "row wrap", style: { gap: "6px" } }, h("div", { class: "title" }, u.userid),
              u.userid === state.user.username ? h("span", { class: "badge info" }, "Du") : null,
              !enabled ? h("span", { class: "badge" }, "Deaktiviert") : null, expired ? h("span", { class: "badge bad" }, "Abgelaufen") : null),
            h("div", { class: "meta" }, [[u.firstname, u.lastname].filter(Boolean).join(" "), u.userid === "root@pam" ? "Darf alles" : roles.length ? roles.map(r => `${roleLabel(r.role)}${r.path !== "/" ? ` (${r.path})` : ""}`).join(", ") : "Keine Rechte"].filter(Boolean).join(" · "))),
          h("span", { class: `badge ${tfaOf(u.userid) ? "ok" : "warn"}`, title: "Zwei-Faktor-Anmeldung" }, icon("shield", "sm"), tfaOf(u.userid) ? "2FA" : "ohne 2FA"));
      }))),
      h("div", { style: { marginTop: "16px" } }, callout("info", "Tipp", "Leg für Familie oder Mitbewohner eigene Benutzer mit „Maschinen bedienen“ an, statt das root-Passwort weiterzugeben. Zwei-Faktor richtet jeder Benutzer in der Proxmox-Oberfläche selbst ein (oben rechts → TFA).")));
  }
  addBtn.addEventListener("click", () => addUserSheet(load));
  await load();
}

function addUserSheet(onDone) {
  openSheet((sheet, close) => {
    const d = { name: "", password: "", password2: "", firstname: "", email: "", role: "PVEVMUser" };
    const btn = h("button", { class: "btn primary" }, "Anlegen");
    const roleGrid = h("div", { class: "choice-grid" });
    const drawRoles = () => { clear(roleGrid).append(ROLE_PRESETS.map(p => h("button", { type: "button", class: `choice ${d.role === p.role ? "active" : ""}`, onclick: () => { d.role = p.role; drawRoles(); } }, h("strong", null, p.label), h("span", null, p.text)))); };
    drawRoles();
    btn.addEventListener("click", () => withBusy(btn, async () => {
      if (!/^[A-Za-z0-9._-]{2,60}$/.test(d.name)) return toast("Ungültiger Benutzername", "Buchstaben, Zahlen, Punkt, - und _.", "bad");
      if (d.password.length < 8) return toast("Passwort zu kurz", "Mindestens 8 Zeichen.", "bad");
      if (d.password !== d.password2) return toast("Passwörter stimmen nicht überein", "", "bad");
      const userid = `${d.name}@pve`;
      try {
        await pve("POST", "/access/users", { userid, password: d.password, firstname: d.firstname || undefined, email: d.email || undefined, enable: 1, comment: "Angelegt mit Proxmox Zentrale" });
        await pve("PUT", "/access/acl", { path: "/", users: userid, roles: d.role, propagate: 1 });
        close(); toast("Benutzer angelegt", `${userid} kann sich jetzt mit dem Bereich „Proxmox VE“ anmelden.`); onDone();
      } catch (e) { errorToast(e); }
    }));
    sheet.append(h("h2", null, "Benutzer anlegen"), h("p", { class: "sheet-sub" }, "Der Benutzer meldet sich mit dem Anmeldebereich „Proxmox VE“ an."),
      h("div", { class: "stack", style: { gap: "16px" } },
        h("div", { class: "form-grid" },
          field("Benutzername", input({ autocapitalize: "off", placeholder: "z. B. anna", oninput: (e) => { d.name = e.target.value.trim(); } })),
          field("Vorname (optional)", input({ oninput: (e) => { d.firstname = e.target.value.trim(); } })),
          field("Passwort", input({ type: "password", autocomplete: "new-password", oninput: (e) => { d.password = e.target.value; } })),
          field("Passwort wiederholen", input({ type: "password", autocomplete: "new-password", oninput: (e) => { d.password2 = e.target.value; } }))),
        field("E-Mail (optional)", input({ type: "email", oninput: (e) => { d.email = e.target.value.trim(); } }), "Für Benachrichtigungen von Proxmox."),
        field("Was darf der Benutzer?", roleGrid)),
      h("div", { class: "sheet-foot" }, h("button", { class: "btn", onclick: () => close() }, "Abbrechen"), btn));
  });
}

function userSheet(u, roles, hasTfa, onDone) {
  const isRoot = u.userid === "root@pam";
  openSheet((sheet, close) => {
    const enabled = u.enable !== 0 && u.enable !== "0";
    const roleSel = select(ROLE_PRESETS.map(p => ({ value: p.role, label: p.label })), roles.find(r => r.path === "/")?.role || "PVEVMUser");
    const saveRole = h("button", { class: "btn sm" }, "Recht speichern");
    saveRole.addEventListener("click", () => withBusy(saveRole, async () => {
      try {
        for (const r of roles.filter(r => r.path === "/")) await pve("PUT", "/access/acl", { path: "/", users: u.userid, roles: r.role, delete: 1 });
        await pve("PUT", "/access/acl", { path: "/", users: u.userid, roles: roleSel.value, propagate: 1 });
        toast("Recht gespeichert"); close(); onDone();
      } catch (e) { errorToast(e); }
    }));
    const pw = input({ type: "password", autocomplete: "new-password", placeholder: "Neues Passwort" });
    const confirmPw = input({ type: "password", autocomplete: "current-password", placeholder: "Dein eigenes Passwort zur Bestätigung" });
    const pwBtn = h("button", { class: "btn sm" }, "Passwort ändern");
    pwBtn.addEventListener("click", () => withBusy(pwBtn, async () => {
      if (pw.value.length < 8) return toast("Passwort zu kurz", "Mindestens 8 Zeichen.", "bad");
      try { await pve("PUT", "/access/password", { userid: u.userid, password: pw.value, "confirmation-password": confirmPw.value || undefined }); toast("Passwort geändert"); pw.value = ""; confirmPw.value = ""; }
      catch (e) { errorToast(e); }
    }));
    sheet.append(
      h("h2", null, u.userid), h("p", { class: "sheet-sub" }, [[u.firstname, u.lastname].filter(Boolean).join(" "), u.email, u.expire ? `läuft ab am ${dateTime(u.expire)}` : null].filter(Boolean).join(" · ") || "Benutzer"),
      h("div", { class: "stack", style: { gap: "18px" } },
        !hasTfa ? callout("warn", "Ohne Zwei-Faktor-Anmeldung", "Empfohlen, vor allem für Benutzer mit vielen Rechten. Einrichten in der Proxmox-Oberfläche: oben rechts auf den Benutzernamen → TFA.") : callout("ok", null, "Zwei-Faktor-Anmeldung ist eingerichtet."),
        isRoot ? callout("info", null, "root@pam darf immer alles. Die Rechte lassen sich nicht ändern.") : h("div", null,
          field("Was darf der Benutzer?", roleSel, roles.filter(r => r.path !== "/").length ? `Zusätzliche Rechte: ${roles.filter(r => r.path !== "/").map(r => `${roleLabel(r.role)} auf ${r.path}`).join(", ")}` : null),
          h("div", { style: { marginTop: "8px" } }, saveRole)),
        /@(pve)$/.test(u.userid) || isRoot || u.userid === state.user.username ? h("div", null, h("div", { class: "label", style: { marginBottom: "6px" } }, "Passwort"),
          h("div", { class: "form-grid" }, pw, confirmPw), h("div", { style: { marginTop: "8px" } }, pwBtn),
          /@pam$/.test(u.userid) ? h("p", { class: "muted small" }, "Ändert das Linux-Passwort dieses Benutzers auf dem Server.") : null) : null,
        !isRoot ? toggle("Benutzer aktiv", "Deaktivierte Benutzer können sich nicht mehr anmelden.", enabled, async (v) => {
          try { await pve("PUT", `/access/users/${enc(u.userid)}`, { enable: v ? 1 : 0 }); toast(v ? "Benutzer aktiviert" : "Benutzer deaktiviert"); onDone(); } catch (e) { errorToast(e); }
        }) : null),
      h("div", { class: "sheet-foot" },
        !isRoot && u.userid !== state.user.username ? h("button", { class: "btn danger-ghost", onclick: async () => {
          if (!await confirmDialog({ title: `${u.userid} löschen?`, text: "Der Benutzer kann sich danach nicht mehr anmelden. Seine Maschinen bleiben erhalten.", confirmText: "Löschen", danger: true })) return;
          try { await pve("DELETE", `/access/users/${enc(u.userid)}`); toast("Benutzer gelöscht"); close(); onDone(); } catch (e) { errorToast(e); }
        } }, icon("trash", "sm"), "Löschen") : null,
        h("button", { class: "btn", onclick: () => close() }, "Schließen")));
  });
}
