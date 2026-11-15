export const SOL_MS = 88775244;
const BASE_X = 3, CAUTION_X = 3, ENV_X = 2, ROUTE_LOCK_X = 4;
let G = null, S = new Set();

const inRange = (i, n) => Number.isInteger(i) && i >= 0 && i < n;
const appliesTo = (o, profile) => !Array.isArray(o.profiles) || !o.profiles.length || o.profiles.includes(profile);

function circle(cell, r_m, { rows, cols, cellM }) {
  const cr = (cell / cols) | 0, cc = cell % cols, n = Math.ceil(r_m / cellM), out = [];
  for (let r = Math.max(0, cr - n); r <= Math.min(rows - 1, cr + n); r++) for (let k = Math.max(0, cc - n); k <= Math.min(cols - 1, cc + n); k++) {
    if (Math.hypot(r - cr, k - cc) * cellM <= r_m) out.push(r * cols + k);
  }
  return out;
}
function withBuffer(cells, { rows, cols }) {
  const s = new Set();
  for (const c of cells) {
    if (!inRange(c, rows * cols)) continue;
    const r = (c / cols) | 0, k = c % cols;
    for (let a = Math.max(0, r - 1); a <= Math.min(rows - 1, r + 1); a++) for (let b = Math.max(0, k - 1); b <= Math.min(cols - 1, k + 1); b++) s.add(a * cols + b);
  }
  return [...s];
}

export const supersededIds = (entries) => new Set(entries.map((e) => e?.data?.supersedes).filter(Boolean));

export function entryFactor(e, nowUtcMs) {
  if (!e || e.status === "resolved") return 1;
  const sev = e.severity;
  if (e.section === "fault" || e.section === "hazard") return sev >= 3 ? Infinity : sev === 2 ? CAUTION_X : 1;
  if (e.section === "env_change") return sev >= 2 && nowUtcMs - e.utcMs < SOL_MS ? ENV_X : 1;
  return 1;
}

export function overlay({ entries = [], locks = [], me, profile, rows, cols, cellM, nowUtcMs = Date.now(), protect = [] }) {
  const dims = (G = { rows, cols, cellM }), n = rows * cols, mult = new Float32Array(n).fill(1);
  const bump = (cells, v) => { for (const i of cells) if (inRange(i, n) && v > mult[i]) mult[i] = v; };
  const sup = (S = supersededIds(entries));
  for (const e of entries) {
    if (!e || sup.has(e.id) || !appliesTo(e, profile) || !inRange(e.cell, n)) continue;
    const v = entryFactor(e, nowUtcMs);
    if (v > 1) bump(circle(e.cell, Math.min(200, Math.max(0, e.radius_m ?? 40)), dims), v);
  }
  for (const l of locks) {
    if (!l || l.holder?.deviceId === me?.deviceId || !appliesTo(l, profile)) continue;
    if (l.kind === "zone") bump(l.cells ?? [], Infinity);
    else if (l.kind === "route") bump(withBuffer(l.cells ?? [], dims), ROUTE_LOCK_X);
  }
  for (const c of protect) if (inRange(c, n) && mult[c] > BASE_X) mult[c] = BASE_X;
  let blocked = 0;
  for (let i = 0; i < n; i++) if (mult[i] === Infinity) blocked++;
  return { mult, blocked };
}

export function entryCells(e) {
  if (!G || !e || S.has(e.id) || e.status === "resolved" || !["fault", "hazard", "env_change"].includes(e.section) || e.severity < 2 || !inRange(e.cell, G.rows * G.cols)) return new Int32Array(0);
  return Int32Array.from(circle(e.cell, Math.min(200, Math.max(0, e.radius_m ?? 40)), G));
}
export function lockCells(l) {
  if (!G || !l) return new Int32Array(0);
  if (l.kind === "zone") return Int32Array.from((l.cells ?? []).filter((i) => inRange(i, G.rows * G.cols)));
  if (l.kind === "route") return Int32Array.from(withBuffer(l.cells ?? [], G));
  return new Int32Array(0);
}
