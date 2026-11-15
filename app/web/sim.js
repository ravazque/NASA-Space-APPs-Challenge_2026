import { clockUtc, solToUtc, SOL_S } from "./marsclock.js";

const MARS_H_MS = (SOL_S * 1000) / 24;
const SIM = { deviceId: "sim", crew: "SIM" };
const rc = (p, cols) => p[0] * cols + p[1];

export const scenarioStartUtc = (scn) => solToUtc(scn.start.clock.replaySol, scn.start.clock.ltst);
const eventS = (scn, at) => ((at - scn.start.clock.ltst) * SOL_S) / 24;

export const scenarioSeconds = (doc, nowMs) => (clockUtc(doc.clock, nowMs) - doc.scenario.startUtcMs) / 1000;

const actorBy = (scn, id) => { const a = scn.actors.find((x) => x.id === id); return a ? { deviceId: a.id, crew: a.crew } : SIM; };

export function simStepper(initial = -1) {
  let last = initial, hi = initial;
  return (clock, tS) => {
    const d = tS - last, from = Math.max(last, hi);
    last = tS;
    if (!(clock.mode === "replay" || clock.mode === "scenario") || !(d >= 0) || d > Math.max(3600, (clock.rate ?? 1) * 30)) return null;
    hi = Math.max(hi, tS);
    return [from, tS];
  };
}

export function simStartOps(scn, data, nowMs) {
  const c = scn.start.clock, startUtcMs = scenarioStartUtc(scn);
  return [
    { t: "set", path: "clock", v: { mode: c.mode, replaySol: c.replaySol, anchorUtcMs: startUtcMs, anchorWallMs: nowMs, rate: c.rate, paused: false }, by: SIM },
    { t: "set", path: "scenario", v: { id: scn.id, running: true, startUtcMs }, by: SIM },
    { t: "set", path: "env.override", v: null, by: SIM },
    ...(scn.assets ?? []).map((a) => ({ t: "set", path: `assets.${a.id}`, v: { id: a.id, kind: a.kind, name: a.name, cell: rc(a.cell, data.cols), tag: "SIMULATED" }, by: SIM })),
  ];
}

function pathCells(a, data) {
  if (a.path.traverse) return data.traverse.slice(a.path.traverse[0], a.path.traverse[1] + 1);
  return a.path.map((p) => rc(p, data.cols));
}

function cellAt(cells, data, distM) {
  if (cells.length === 1) return cells[0];
  let left = distM;
  for (let i = 1; i < cells.length; i++) {
    const [r0, c0] = [(cells[i - 1] / data.cols) | 0, cells[i - 1] % data.cols], [r1, c1] = [(cells[i] / data.cols) | 0, cells[i] % data.cols];
    const seg = Math.hypot(r1 - r0, c1 - c0) * data.cellM;
    if (left <= seg) { const f = seg ? left / seg : 0; return Math.round(r0 + (r1 - r0) * f) * data.cols + Math.round(c0 + (c1 - c0) * f); }
    left -= seg;
  }
  return cells.at(-1);
}
function pathLength(cells, data) {
  let m = 0;
  for (let i = 1; i < cells.length; i++) m += Math.hypot(((cells[i] / data.cols) | 0) - ((cells[i - 1] / data.cols) | 0), (cells[i] % data.cols) - (cells[i - 1] % data.cols)) * data.cellM;
  return m;
}

export function simPresence(scn, data, tS) {
  return scn.actors.map((a) => {
    const cells = pathCells(a, data), total = pathLength(cells, data);
    let d = Math.max(0, tS) * a.speed_ms;
    d = a.loop && total > 0 ? d % total : Math.min(d, total);
    return { deviceId: a.id, crew: a.crew, role: "crew", kind: a.kind, cell: cellAt(cells, data, d), online: true, sim: true };
  });
}

export function simOps(scn, data, t0S, t1S, startUtcMs) {
  const out = [], logEvents = scn.events.map((e, i) => ({ e, i })).filter((x) => x.e.do === "log");
  scn.events.forEach((e, i) => {
    const s = eventS(scn, e.at);
    if (!(s > t0S && s <= t1S)) return;
    const utcMs = startUtcMs + s * 1000, by = e.as ? actorBy(scn, e.as) : SIM, id = (k) => `${logEvents[k].e.as}:e${logEvents[k].i}`;
    if (e.do === "log") {
      const x = e.entry;
      out.push({ t: "log.append", by, entry: { id: `${e.as}:e${i}`, section: x.section, severity: x.severity, cell: rc(x.cell, data.cols), radius_m: x.radius_m ?? 40,
        profiles: x.profiles ?? ["foot", "vehicle", "cargo"], title: x.title, note: x.note ?? "", data: x.data ?? {}, utcMs, wallMs: utcMs,
        sol: scn.start.clock.replaySol, ltst: e.at } });
    } else if (e.do === "lock") {
      out.push({ t: "lock.request", by, target: e.lock.target, kind: e.lock.kind, cells: [], profiles: ["foot", "vehicle", "cargo"], reason: e.lock.reason ?? "", sticky: !!e.lock.sticky });
    } else if (e.do === "weather") {
      const o = e.override;
      out.push({ t: "set", path: "env.override", by, v: o === null ? null : { tau: o.tau, wind_ms: o.wind_ms, wind_dir_deg: o.wind_dir_deg, t0Utc: utcMs, t1Utc: utcMs + o.over_h * MARS_H_MS,
        cell: o.cell ? rc(o.cell, data.cols) : null, radius_m: o.radius_m ?? null, label: o.label ?? "" } });
    } else if (e.do === "resolve") {
      out.push({ t: "log.status", by: actorBy(scn, logEvents[e.ref].e.as), ref: id(e.ref), status: "resolved" });
    } else if (e.do === "release") {
      const lk = scn.events.find((x) => x.do === "lock" && x.lock.target === e.target);
      out.push({ t: "lock.release", by: lk?.as ? actorBy(scn, lk.as) : SIM, target: e.target });
    }
  });
  return out;
}

export const simFrom = (op) => ({ ...op.by, role: "crew", sim: true });
