import { upgradeCard } from "./upgrade.js";
import {
  h, icon, clear, api, pve, state, nodePath, toast, errorToast, trackTask, confirmDialog, withBusy, pageHead, callout, loader,
  setUpdatesCount, uptime,
} from "../core.js";

export async function renderUpdates({ el, go }) {
  el.append(pageHead("Updates", "Halte Proxmox und diese Oberfläche aktuell."));
  const pveCard = h("div", { class: "card" }, loader());
  const selfCard = h("div", { class: "card", style: { marginTop: "14px" } });
  const ctCard = h("div", { class: "card", style: { marginTop: "14px" } });
  const powerCard = h("div", { class: "card", style: { marginTop: "14px" } });
  el.append(upgradeCard(go), pveCard, ctCard, selfCard, powerCard);
  const admin = state.user.host_admin;

  async function drawPve(refreshing = false) {
    let version = null, list = [];
    try { version = await pve("GET", nodePath("/version")); } catch { /* egal */ }
    try { list = await pve("GET", nodePath("/apt/update")); } catch (e) { clear(pveCard).append(callout("warn", null, `Updates können nicht abgefragt werden: ${e.message}`)); return; }
    setUpdatesCount(list.length);
    const checkBtn = h("button", { class: "btn" }, icon("refresh", "sm"), "Nach Updates suchen");
    checkBtn.addEventListener("click", () => withBusy(checkBtn, async () => {
      try {
        const upid = await pve("POST", nodePath("/apt/update"));
        await trackTask(upid, "Nach Updates suchen", { onDone: () => drawPve(true) });
      } catch (e) { errorToast(e); }
    }));
    const installBtn = h("button", { class: "btn primary" }, icon("download", "sm"), "Updates installieren");
    if (!admin) installBtn.disabled = true;
    installBtn.addEventListener("click", async () => {
      const kernel = list.some(p => /^(proxmox-kernel|pve-kernel)/.test(p.Package));
      if (!await confirmDialog({
        title: `${list.length} Update${list.length === 1 ? "" : "s"} installieren?`,
        text: `Deine Maschinen laufen dabei weiter.${kernel ? " Darunter ist ein neuer Kernel – danach ist ein Neustart des Servers nötig." : ""}`,
        confirmText: "Installieren",
      })) return;
      try { const res = await api("/jobs", { method: "POST", body: { kind: "upgrade" } }); go(`job/${res.data.id}`); } catch (e) { errorToast(e); }
    });

    clear(pveCard).append(
      h("div", { class: "card-head" }, h("div", { class: "guest-icon ct" }, icon("server")),
        h("div", null, h("h3", null, "Proxmox VE"), h("div", { class: "muted small" }, version ? `Version ${version.version}${version.release ? ` (Release ${version.release})` : ""}` : state.node))),
      list.length
        ? callout("info", `${list.length} Update${list.length === 1 ? "" : "s"} verfügbar`, "Updates schließen Sicherheitslücken und beheben Fehler. Am besten regelmäßig installieren.", "download")
        : callout("ok", "Alles aktuell", refreshing ? "Gerade geprüft – keine Updates vorhanden." : "Keine Updates bekannt. Tippe auf „Nach Updates suchen“, um neu zu prüfen."),
      h("div", { class: "row wrap", style: { marginTop: "14px" } }, checkBtn, list.length ? installBtn : null),
      !admin && list.length ? h("p", { class: "muted small" }, "Installieren darf nur root@pam.") : null,
      list.length ? h("details", { style: { marginTop: "14px" } }, h("summary", { style: { cursor: "pointer", fontWeight: 620 } }, "Pakete anzeigen"),
        h("div", { class: "table-wrap", style: { marginTop: "10px" } }, h("table", { class: "table" },
          h("thead", null, h("tr", null, h("th", null, "Paket"), h("th", null, "Installiert"), h("th", null, "Neu"))),
          h("tbody", null, list.sort((a, b) => a.Package.localeCompare(b.Package)).map(p => h("tr", null,
            h("td", null, h("div", { style: { fontWeight: 600 } }, p.Package), h("div", { class: "muted small" }, p.Title || "")),
            h("td", { class: "mono muted" }, p.OldVersion || "–"), h("td", { class: "mono" }, p.Version))))))) : null,
    );
  }

  clear(ctCard).append(
    h("div", { class: "card-head" }, h("div", { class: "guest-icon" }, icon("box")), h("div", null, h("h3", null, "Container aktualisieren"),
      h("div", { class: "muted small" }, "Updates innerhalb aller LXC-Container einspielen"))),
    h("p", { class: "muted", style: { marginTop: 0 } }, "Proxmox-Updates betreffen nur den Server selbst. Die Programme in deinen Containern werden damit separat aktualisiert."),
    h("button", { class: "btn", disabled: !admin, onclick: async (e) => {
      await withBusy(e.currentTarget, async () => {
        try { const res = await api("/jobs", { method: "POST", body: { kind: "script", path: "tools/pve/update-lxcs.sh", title: "Alle Container aktualisieren" } }); go(`job/${res.data.id}`); }
        catch (ex) { errorToast(ex); }
      });
    } }, icon("refresh", "sm"), "Container-Updates starten"));

  const selfBtn = h("button", { class: "btn", disabled: !admin }, icon("download", "sm"), "Oberfläche aktualisieren");
  selfBtn.addEventListener("click", async () => {
    if (!await confirmDialog({ title: "Proxmox Zentrale aktualisieren?", text: "Die neueste Version wird von GitHub geladen. Die Seite lädt danach neu – deine Maschinen sind davon nicht betroffen.", confirmText: "Aktualisieren" })) return;
    await withBusy(selfBtn, async () => {
      try {
        await api("/jobs", { method: "POST", body: { kind: "selfupdate" } });
        const t = toast("Update läuft", "Die Seite lädt gleich neu …", "busy", { timeout: 0 });
        const old = state.user.version;
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 3000));
          try {
            const r = await fetch("/api/health", { cache: "no-store" });
            if (r.ok) { const j = await r.json(); if (i > 3 && (j.version !== old || i > 10)) { t.close(); location.reload(); return; } }
          } catch { /* Neustart läuft */ }
        }
        t.update("Update dauert länger", "Bitte die Seite später neu laden.", "info");
      } catch (e) { errorToast(e); }
    });
  });
  selfCard.append(
    h("div", { class: "card-head" }, h("div", { class: "guest-icon vm" }, icon("sparkle")), h("div", null, h("h3", null, "Proxmox Zentrale"),
      h("div", { class: "muted small" }, `Installierte Version ${state.user.version}`))),
    h("p", { class: "muted", style: { marginTop: 0 } }, "Holt die neueste Version dieser Oberfläche aus deinem GitHub-Repository."),
    selfBtn);

  // Server neu starten / herunterfahren
  let st = null;
  try { st = await pve("GET", nodePath("/status")); } catch { /* egal */ }
  powerCard.append(
    h("div", { class: "card-head" }, h("div", { class: "guest-icon" }, icon("power")), h("div", null, h("h3", null, "Server neu starten"),
      h("div", { class: "muted small" }, st ? `Läuft seit ${uptime(st.uptime)} · Kernel ${st["current-kernel"]?.release || st.kversion?.split(" ")[2] || "?"}` : ""))),
    h("p", { class: "muted", style: { marginTop: 0 } }, "Nach Kernel-Updates nötig. Maschinen mit Autostart werden danach automatisch wieder gestartet, die anderen werden vorher sauber heruntergefahren."),
    h("div", { class: "row wrap" },
      powerBtn("restart", "Neu starten", "reboot", "Server neu starten?", "Alle Maschinen werden heruntergefahren. Die Oberfläche ist für einige Minuten nicht erreichbar."),
      powerBtn("power", "Herunterfahren", "shutdown", "Server herunterfahren?", "Der Server geht komplett aus. Du musst ihn danach von Hand wieder einschalten!")));

  function powerBtn(ico, label, cmd, title, text) {
    return h("button", { class: `btn ${cmd === "shutdown" ? "danger-ghost" : ""}`, onclick: async () => {
      if (!await confirmDialog({ title, text, confirmText: label, danger: true, typeToConfirm: state.node })) return;
      try { await pve("POST", nodePath("/status"), { command: cmd }); toast(cmd === "reboot" ? "Server startet neu" : "Server fährt herunter", "Bis gleich!", "info", { timeout: 0 }); }
      catch (e) { errorToast(e); }
    } }, icon(ico, "sm"), label);
  }

  await drawPve();
}
