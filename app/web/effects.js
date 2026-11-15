export const SOL_MS = 88775244;

const BASE_FACTOR = 3;
const CAUTION_FACTOR = 3;
const ENV_FACTOR = 2;
const ROUTE_LOCK_FACTOR = 4;
const MAX_RADIUS_M = 200;
const DEFAULT_RADIUS_M = 40;
const ROUTING_SECTIONS = ["fault", "hazard", "env_change"];

let lastGrid = null;
let lastSuperseded = new Set();

const inRange = (i, n) => Number.isInteger(i) && i >= 0 && i < n;

function appliesTo(item, profile) {
  if (!Array.isArray(item.profiles) || !item.profiles.length) return true;
  return item.profiles.includes(profile);
}

function entryRadius(entry) {
  return Math.min(MAX_RADIUS_M, Math.max(0, entry.radius_m ?? DEFAULT_RADIUS_M));
}

function circle(cell, radiusM, { rows, cols, cellM }) {
  const centerRow = (cell / cols) | 0;
  const centerCol = cell % cols;
  const reach = Math.ceil(radiusM / cellM);
  const rowMin = Math.max(0, centerRow - reach);
  const rowMax = Math.min(rows - 1, centerRow + reach);
  const colMin = Math.max(0, centerCol - reach);
  const colMax = Math.min(cols - 1, centerCol + reach);
  const inside = [];

  for (let row = rowMin; row <= rowMax; row++) {
    for (let col = colMin; col <= colMax; col++) {
      if (Math.hypot(row - centerRow, col - centerCol) * cellM <= radiusM) {
        inside.push(row * cols + col);
      }
    }
  }
  return inside;
}

function withBuffer(cells, { rows, cols }) {
  const buffered = new Set();
  for (const cell of cells) {
    if (!inRange(cell, rows * cols)) continue;
    const row = (cell / cols) | 0;
    const col = cell % cols;
    for (let r = Math.max(0, row - 1); r <= Math.min(rows - 1, row + 1); r++) {
      for (let c = Math.max(0, col - 1); c <= Math.min(cols - 1, col + 1); c++) {
        buffered.add(r * cols + c);
      }
    }
  }
  return [...buffered];
}

export function supersededIds(entries) {
  return new Set(entries.map((entry) => entry?.data?.supersedes).filter(Boolean));
}

export function entryFactor(entry, nowUtcMs) {
  if (!entry || entry.status === "resolved") return 1;
  const severity = entry.severity;

  if (entry.section === "fault" || entry.section === "hazard") {
    if (severity >= 3) return Infinity;
    return severity === 2 ? CAUTION_FACTOR : 1;
  }
  if (entry.section === "env_change") {
    const isRecent = nowUtcMs - entry.utcMs < SOL_MS;
    return severity >= 2 && isRecent ? ENV_FACTOR : 1;
  }
  return 1;
}

export function overlay({
  entries = [],
  locks = [],
  me,
  profile,
  rows,
  cols,
  cellM,
  nowUtcMs = Date.now(),
  protect = [],
}) {
  const grid = { rows, cols, cellM };
  const size = rows * cols;
  const mult = new Float32Array(size).fill(1);
  lastGrid = grid;

  const raise = (cells, factor) => {
    for (const i of cells) {
      if (inRange(i, size) && factor > mult[i]) mult[i] = factor;
    }
  };

  const superseded = supersededIds(entries);
  lastSuperseded = superseded;

  for (const entry of entries) {
    if (!entry || superseded.has(entry.id)) continue;
    if (!appliesTo(entry, profile) || !inRange(entry.cell, size)) continue;
    const factor = entryFactor(entry, nowUtcMs);
    if (factor > 1) raise(circle(entry.cell, entryRadius(entry), grid), factor);
  }

  for (const lock of locks) {
    if (!lock || lock.holder?.deviceId === me?.deviceId || !appliesTo(lock, profile)) continue;
    if (lock.kind === "zone") {
      raise(lock.cells ?? [], Infinity);
    } else if (lock.kind === "route") {
      raise(withBuffer(lock.cells ?? [], grid), ROUTE_LOCK_FACTOR);
    }
  }

  for (const cell of protect) {
    if (inRange(cell, size) && mult[cell] > BASE_FACTOR) mult[cell] = BASE_FACTOR;
  }

  let blocked = 0;
  for (let i = 0; i < size; i++) {
    if (mult[i] === Infinity) blocked++;
  }
  return { mult, blocked };
}

export function entryCells(entry) {
  const none = new Int32Array(0);
  if (!lastGrid || !entry || lastSuperseded.has(entry.id)) return none;
  if (entry.status === "resolved" || !ROUTING_SECTIONS.includes(entry.section)) return none;
  if (entry.severity < 2 || !inRange(entry.cell, lastGrid.rows * lastGrid.cols)) return none;
  return Int32Array.from(circle(entry.cell, entryRadius(entry), lastGrid));
}

export function lockCells(lock) {
  if (!lastGrid || !lock) return new Int32Array(0);
  if (lock.kind === "zone") {
    const size = lastGrid.rows * lastGrid.cols;
    return Int32Array.from((lock.cells ?? []).filter((i) => inRange(i, size)));
  }
  if (lock.kind === "route") return Int32Array.from(withBuffer(lock.cells ?? [], lastGrid));
  return new Int32Array(0);
}
