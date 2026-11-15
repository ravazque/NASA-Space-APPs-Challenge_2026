import { clockUtc, solToUtc, SOL_S } from "./marsclock.js";

const MARS_H_MS = (SOL_S * 1000) / 24;
const SIM = { deviceId: "sim", crew: "SIM" };
const ALL_PROFILES = ["foot", "vehicle", "cargo"];
const MIN_MAX_JUMP_S = 3600;
const MAX_JUMP_WALL_S = 30;

const toCell = (rowCol, cols) => rowCol[0] * cols + rowCol[1];
const rowOf = (cell, cols) => (cell / cols) | 0;
const colOf = (cell, cols) => cell % cols;

export function scenarioStartUtc(scn) {
  const { replaySol, ltst } = scn.start.clock;
  return solToUtc(replaySol, ltst);
}

function eventSeconds(scn, ltst) {
  return ((ltst - scn.start.clock.ltst) * SOL_S) / 24;
}

export function scenarioSeconds(doc, nowMs) {
  return (clockUtc(doc.clock, nowMs) - doc.scenario.startUtcMs) / 1000;
}

function actorBy(scn, actorId) {
  const actor = scn.actors.find((a) => a.id === actorId);
  return actor ? { deviceId: actor.id, crew: actor.crew } : SIM;
}

export function simStepper(initial = -1) {
  let last = initial;
  let highest = initial;
  return (clock, tS) => {
    const delta = tS - last;
    const from = Math.max(last, highest);
    last = tS;
    const playing = clock.mode === "replay" || clock.mode === "scenario";
    const maxJump = Math.max(MIN_MAX_JUMP_S, (clock.rate ?? 1) * MAX_JUMP_WALL_S);
    if (!playing || !(delta >= 0) || delta > maxJump) return null;
    highest = Math.max(highest, tS);
    return [from, tS];
  };
}

export function simStartOps(scn, data, nowMs) {
  const clock = scn.start.clock;
  const startUtcMs = scenarioStartUtc(scn);
  const clockValue = {
    mode: clock.mode,
    replaySol: clock.replaySol,
    anchorUtcMs: startUtcMs,
    anchorWallMs: nowMs,
    rate: clock.rate,
    paused: false,
  };
  const assetOps = (scn.assets ?? []).map((a) => ({
    t: "set",
    path: `assets.${a.id}`,
    v: { id: a.id, kind: a.kind, name: a.name, cell: toCell(a.cell, data.cols), tag: "SIMULATED" },
    by: SIM,
  }));
  return [
    { t: "set", path: "clock", v: clockValue, by: SIM },
    { t: "set", path: "scenario", v: { id: scn.id, running: true, startUtcMs }, by: SIM },
    { t: "set", path: "env.override", v: null, by: SIM },
    ...assetOps,
  ];
}

function pathCells(actor, data) {
  if (actor.path.traverse) {
    const [from, to] = actor.path.traverse;
    return data.traverse.slice(from, to + 1);
  }
  return actor.path.map((p) => toCell(p, data.cols));
}

function segmentLength(cellA, cellB, data) {
  const dRow = rowOf(cellB, data.cols) - rowOf(cellA, data.cols);
  const dCol = colOf(cellB, data.cols) - colOf(cellA, data.cols);
  return Math.hypot(dRow, dCol) * data.cellM;
}

function pathLength(cells, data) {
  let total = 0;
  for (let i = 1; i < cells.length; i++) {
    total += segmentLength(cells[i - 1], cells[i], data);
  }
  return total;
}

function cellAt(cells, data, distM) {
  if (cells.length === 1) return cells[0];
  let remaining = distM;
  for (let i = 1; i < cells.length; i++) {
    const row0 = rowOf(cells[i - 1], data.cols);
    const col0 = colOf(cells[i - 1], data.cols);
    const row1 = rowOf(cells[i], data.cols);
    const col1 = colOf(cells[i], data.cols);
    const segment = segmentLength(cells[i - 1], cells[i], data);
    if (remaining <= segment) {
      const fraction = segment ? remaining / segment : 0;
      const row = Math.round(row0 + (row1 - row0) * fraction);
      const col = Math.round(col0 + (col1 - col0) * fraction);
      return row * data.cols + col;
    }
    remaining -= segment;
  }
  return cells.at(-1);
}

export function simPresence(scn, data, tS) {
  return scn.actors.map((actor) => {
    const cells = pathCells(actor, data);
    const total = pathLength(cells, data);
    const travelled = Math.max(0, tS) * actor.speed_ms;
    const distM = actor.loop && total > 0 ? travelled % total : Math.min(travelled, total);
    return {
      deviceId: actor.id,
      crew: actor.crew,
      role: "crew",
      kind: actor.kind,
      cell: cellAt(cells, data, distM),
      online: true,
      sim: true,
    };
  });
}

function logOp(scn, data, event, index, by, utcMs) {
  const entry = event.entry;
  return {
    t: "log.append",
    by,
    entry: {
      id: `${event.as}:e${index}`,
      section: entry.section,
      severity: entry.severity,
      cell: toCell(entry.cell, data.cols),
      radius_m: entry.radius_m ?? 40,
      profiles: entry.profiles ?? [...ALL_PROFILES],
      title: entry.title,
      note: entry.note ?? "",
      data: entry.data ?? {},
      utcMs,
      wallMs: utcMs,
      sol: scn.start.clock.replaySol,
      ltst: event.at,
    },
  };
}

function lockOp(event, by) {
  return {
    t: "lock.request",
    by,
    target: event.lock.target,
    kind: event.lock.kind,
    cells: [],
    profiles: [...ALL_PROFILES],
    reason: event.lock.reason ?? "",
    sticky: !!event.lock.sticky,
  };
}

function weatherOp(data, event, by, utcMs) {
  const override = event.override;
  const value =
    override === null
      ? null
      : {
          tau: override.tau,
          wind_ms: override.wind_ms,
          wind_dir_deg: override.wind_dir_deg,
          t0Utc: utcMs,
          t1Utc: utcMs + override.over_h * MARS_H_MS,
          cell: override.cell ? toCell(override.cell, data.cols) : null,
          radius_m: override.radius_m ?? null,
          label: override.label ?? "",
        };
  return { t: "set", path: "env.override", by, v: value };
}

export function simOps(scn, data, t0S, t1S, startUtcMs) {
  const ops = [];
  const logEvents = scn.events
    .map((event, index) => ({ event, index }))
    .filter((entry) => entry.event.do === "log");
  const logId = (logIndex) => `${logEvents[logIndex].event.as}:e${logEvents[logIndex].index}`;

  scn.events.forEach((event, index) => {
    const seconds = eventSeconds(scn, event.at);
    if (!(seconds > t0S && seconds <= t1S)) return;
    const utcMs = startUtcMs + seconds * 1000;
    const by = event.as ? actorBy(scn, event.as) : SIM;

    if (event.do === "log") {
      ops.push(logOp(scn, data, event, index, by, utcMs));
    } else if (event.do === "lock") {
      ops.push(lockOp(event, by));
    } else if (event.do === "weather") {
      ops.push(weatherOp(data, event, by, utcMs));
    } else if (event.do === "resolve") {
      const resolver = actorBy(scn, logEvents[event.ref].event.as);
      ops.push({ t: "log.status", by: resolver, ref: logId(event.ref), status: "resolved" });
    } else if (event.do === "release") {
      const lockEvent = scn.events.find(
        (candidate) => candidate.do === "lock" && candidate.lock.target === event.target,
      );
      const releaser = lockEvent?.as ? actorBy(scn, lockEvent.as) : SIM;
      ops.push({ t: "lock.release", by: releaser, target: event.target });
    }
  });
  return ops;
}

export const simFrom = (op) => ({ ...op.by, role: "crew", sim: true });
