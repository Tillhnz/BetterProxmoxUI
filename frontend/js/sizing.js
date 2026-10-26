// ===========================================================================
// Größen-Empfehlungen: Braucht ein Dienst mehr RAM/CPU/Festplatte – oder weniger?
// Grundlage sind die Messwerte der letzten 7 Tage (Proxmox-RRD).
// ===========================================================================
import { pve, nodePath, bytes, percentile, toast } from "./core.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const roundUp = (v, step) => Math.ceil(v / step) * step;

/** Lädt Verlauf und berechnet Vorschläge für eine Maschine. */
export async function analyzeGuest(g, conf, nodeCores) {
  if (g.status !== "running" || g.template) return [];
  let peak, avg;
  try {
    [peak, avg] = await Promise.all([
      pve("GET", nodePath(`/${g.type}/${g.vmid}/rrddata`), { timeframe: "week", cf: "MAX" }),
      pve("GET", nodePath(`/${g.type}/${g.vmid}/rrddata`), { timeframe: "week", cf: "AVERAGE" }),
    ]);
  } catch { return []; }
  const pts = (peak || []).filter(r => typeof r.maxmem === "number" && r.maxmem > 0);
  if (pts.length < 24) return []; // weniger als ~12 Stunden Messwerte → noch keine Aussage
  const out = [];
  const name = g.name || `#${g.vmid}`;
  const isLxc = g.type === "lxc";
  const agentOn = /^1|enabled=1/.test(String(conf?.agent || ""));
  const days = Math.max(1, Math.round((pts[pts.length - 1].time - pts[0].time) / 86400));
  const span = days >= 6 ? "der letzten Woche" : `der letzten ${days} Tag${days === 1 ? "" : "e"}`;

  // ---------- Arbeitsspeicher ----------
  const maxmem = conf?.memory ? conf.memory * MB : pts[pts.length - 1].maxmem;
  const memPeak = percentile(pts.map(r => r.mem), 95);
  const memTop = Math.max(...pts.map(r => r.mem || 0));
  if (memPeak !== null && maxmem) {
    const ratio = memPeak / maxmem;
    if (ratio > (isLxc ? 0.9 : 0.95) && (isLxc || agentOn)) {
      const target = roundUp(Math.max(maxmem * 1.5, memTop * 1.3), 512 * MB);
      out.push({
        id: `size-mem-up-${g.vmid}`, guest: g, kind: "mem", dir: "up", level: ratio > 0.97 ? "warn" : "info",
        title: `${name} braucht mehr Arbeitsspeicher`,
        why: `In ${span} war der Arbeitsspeicher meist zu ${Math.round(ratio * 100)} % voll (Spitze ${bytes(memTop)} von ${bytes(maxmem)}). Dann wird es langsam oder Programme werden beendet.`,
        todo: `Auf ${bytes(target)} erhöhen.${isLxc ? " Wirkt sofort, ohne Neustart." : " Wirkt nach dem nächsten Neustart der VM."}`,
        change: { memory: Math.round(target / MB) }, from: maxmem, to: target,
      });
    } else if (ratio < (isLxc ? 0.35 : 0.3) && maxmem >= 1024 * MB) {
      const target = Math.max(512 * MB, roundUp(memTop * (isLxc ? 1.6 : 1.8), 256 * MB));
      if (maxmem - target >= 512 * MB) out.push({
        id: `size-mem-down-${g.vmid}`, guest: g, kind: "mem", dir: "down", level: "info",
        title: `${name}: ${bytes(maxmem - target)} Arbeitsspeicher einsparbar`,
        why: `In ${span} hat ${name} höchstens ${bytes(memTop)} von ${bytes(maxmem)} gebraucht.${isLxc ? "" : " Hinweis: VMs nutzen freien Speicher gern als Cache – bei Problemen einfach wieder erhöhen."}`,
        todo: `Auf ${bytes(target)} reduzieren – mit Puffer für Spitzen. Den frei werdenden Speicher können andere Dienste nutzen.${isLxc ? "" : " Wirkt nach dem nächsten Neustart der VM."}`,
        change: { memory: Math.round(target / MB) }, from: maxmem, to: target,
      });
    }
  }

  // ---------- Prozessor ----------
  const cores = Number(conf?.cores || g.maxcpu || 1);
  const avgPts = (avg || []).filter(r => typeof r.cpu === "number");
  const cpuPeak = percentile(pts.map(r => r.cpu), 95);
  const cpuAvg = avgPts.length ? avgPts.reduce((a, r) => a + r.cpu, 0) / avgPts.length : null;
  if (cpuPeak !== null && cpuAvg !== null) {
    if (cpuPeak > 0.9 && cpuAvg > 0.5 && cores < nodeCores) {
      const target = Math.min(nodeCores, Math.max(cores + 1, cores * 2));
      out.push({
        id: `size-cpu-up-${g.vmid}`, guest: g, kind: "cpu", dir: "up", level: cpuAvg > 0.75 ? "warn" : "info",
        title: `${name} braucht mehr Prozessorkerne`,
        why: `Die ${cores} Kern${cores === 1 ? " ist" : "e sind"} im Schnitt zu ${Math.round(cpuAvg * 100)} % ausgelastet, in Spitzen zu ${Math.round(cpuPeak * 100)} %.`,
        todo: `Auf ${target} Kerne erhöhen.${isLxc ? " Wirkt sofort." : " Wirkt nach dem nächsten Neustart der VM."}`,
        change: { cores: target }, from: cores, to: target,
      });
    } else if (cpuPeak < 0.15 && cores >= 4) {
      const target = Math.max(2, Math.ceil(cores * cpuPeak * 3));
      if (target < cores) out.push({
        id: `size-cpu-down-${g.vmid}`, guest: g, kind: "cpu", dir: "down", level: "info",
        title: `${name}: weniger Kerne reichen`,
        why: `Selbst in Spitzen nutzt ${name} nur ${Math.round(cpuPeak * 100)} % der ${cores} Kerne.`,
        todo: `Auf ${target} Kerne reduzieren. Das entlastet den Server bei vielen gleichzeitig laufenden Diensten.`,
        change: { cores: target }, from: cores, to: target,
      });
    }
  }

  // ---------- Festplatte (nur bei Containern messbar) ----------
  if (isLxc) {
    const last = pts[pts.length - 1];
    if (last.maxdisk > 0 && last.disk > 0) {
      const ratio = last.disk / last.maxdisk;
      if (ratio > 0.85) {
        const add = Math.max(4, Math.ceil((last.maxdisk * 0.3) / GB));
        out.push({
          id: `size-disk-up-${g.vmid}`, guest: g, kind: "disk", dir: "up", level: ratio > 0.95 ? "bad" : "warn",
          title: `Festplatte von ${name} ist zu ${Math.round(ratio * 100)} % voll`,
          why: `${bytes(last.disk)} von ${bytes(last.maxdisk)} belegt. Ist sie voll, stürzen Datenbanken und Apps ab.`,
          todo: `Um ${add} GB vergrößern (geht im laufenden Betrieb).`,
          resize: { disk: "rootfs", size: `+${add}G` }, from: last.maxdisk, to: last.maxdisk + add * GB,
        });
      }
    }
  }
  return out;
}

/** Setzt einen Vorschlag um. */
export async function applySizing(s) {
  const base = nodePath(`/${s.guest.type}/${s.guest.vmid}`);
  if (s.resize) {
    await pve("PUT", `${base}/resize`, s.resize);
  } else {
    if (s.change.memory && s.guest.type === "lxc") {
      // Swap bei Containern sinnvoll mitziehen (max. 512 MB)
      await pve("PUT", `${base}/config`, { ...s.change, swap: Math.min(512, s.change.memory) });
    } else await pve("PUT", `${base}/config`, s.change);
  }
  toast("Übernommen", s.guest.type === "qemu" && !s.resize ? "Die Änderung wirkt nach dem nächsten Neustart der VM." : `${s.guest.name} hat jetzt die neue Größe.`);
}

/** Analysiert alle laufenden Maschinen (parallel, begrenzt). */
export async function analyzeAll(guests, configs, nodeCores) {
  const running = guests.filter(g => g.status === "running");
  const results = [];
  for (let i = 0; i < running.length; i += 4) {
    const chunk = running.slice(i, i + 4);
    (await Promise.all(chunk.map(g => analyzeGuest(g, configs.get(g.vmid), nodeCores)))).forEach(r => results.push(...r));
  }
  return results;
}
