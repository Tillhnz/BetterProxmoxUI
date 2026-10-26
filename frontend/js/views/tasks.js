import { h, icon, clear, api, pve, nodePath, pageHead, callout, loader, empty, relTime, dateTime, taskName, showTaskLog } from "../core.js";

export async function renderTasks({ page, el }) {
  el.append(pageHead("Aktivität", "Was zuletzt auf deinem Server passiert ist."));
  const jobsBox = h("div");
  const listCard = h("div", { class: "card pad-0" }, loader());
  el.append(jobsBox, h("h2", { class: "section" }, "Proxmox-Aufgaben"), listCard);

  async function loadJobs() {
    try {
      const jobs = (await api("/jobs")).data || [];
      clear(jobsBox);
      if (!jobs.length) return;
      jobsBox.append(h("h2", { class: "section", style: { marginTop: 0 } }, "Installationen & Host-Aufgaben"),
        h("div", { class: "card pad-0" }, h("div", { class: "list" }, jobs.map(j =>
          h("a", { class: "list-item clickable", href: `#/job/${j.id}`, style: { color: "var(--text)" } },
            h("div", { class: `guest-icon ${j.running ? "ct" : ""}` }, icon(j.running ? "spinner" : j.exit_code === 0 ? "checkCircle" : "xCircle", j.running ? "spin" : "")),
            h("div", { class: "grow" }, h("div", { class: "title" }, j.title), h("div", { class: "meta" }, `${relTime(j.started)} · ${j.owner}`)),
            h("span", { class: `badge ${j.running ? "accent" : j.exit_code === 0 ? "ok" : "bad"}` }, j.running ? "Läuft" : j.exit_code === 0 ? "OK" : "Fehler"))))));
    } catch { /* egal */ }
  }

  async function load() {
    let tasks;
    try { tasks = await pve("GET", nodePath("/tasks"), { limit: 60 }); }
    catch (e) { clear(listCard).append(h("div", { style: { padding: "18px" } }, callout("bad", "Laden fehlgeschlagen", e.message))); return; }
    clear(listCard);
    if (!tasks.length) { listCard.append(empty("list", "Noch keine Aktivität", "")); return; }
    listCard.append(h("div", { class: "list" }, tasks.map(t => {
      const running = !t.endtime;
      const ok = t.status === "OK";
      const warn = String(t.status || "").startsWith("WARNINGS");
      return h("div", { class: "list-item clickable", onclick: () => showTaskLog(t.upid, taskName(t.type, t.id)) },
        h("div", { class: "guest-icon" }, icon(running ? "spinner" : ok ? "checkCircle" : warn ? "alert" : "xCircle", running ? "spin" : "")),
        h("div", { class: "grow" }, h("div", { class: "title" }, taskName(t.type, t.id)),
          h("div", { class: "meta", title: dateTime(t.starttime) }, `${relTime(t.starttime)} · ${t.user}`)),
        h("span", { class: `badge ${running ? "accent" : ok ? "ok" : warn ? "warn" : "bad"}` }, running ? "Läuft" : ok ? "OK" : warn ? "Warnung" : "Fehler"));
    })));
  }
  await Promise.all([loadJobs(), load()]);
  page.every(5000, () => { loadJobs(); load(); });
}
