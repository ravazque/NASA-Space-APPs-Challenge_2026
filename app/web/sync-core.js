export function initialDoc(nowMs) {
  return {
    seq: 0,
    settings: {
      goal: null,
      weights: { energy: 1, risk: 1, comms: 0.5, radiation: 0.5, science: 1 },
      evaStartLtst: 12,
    },
    clock: {
      mode: "live",
      replaySol: null,
      anchorUtcMs: nowMs,
      anchorWallMs: nowMs,
      rate: 1,
      paused: false,
    },
    env: { override: null },
    scenario: { id: null, running: false, startUtcMs: null },
    assets: {},
    locks: {},
    log: {},
    logOrder: [],
  };
}

export const LIMITS = {
  title: 60,
  note: 500,
  reason: 80,
  crew: 12,
  cells: 9000,
  poly: 64,
  ttlMin: 10000,
  ttlMax: 300000,
  ttlDef: 30000,
};

const SECTIONS = [
  "fault",
  "env_change",
  "route_deviation",
  "hazard",
  "sample",
  "equipment",
  "note",
];
const LOW_SEVERITY_SECTIONS = ["sample", "equipment", "note"];
const PROFILES = ["foot", "vehicle", "cargo"];
const ASSET_KINDS = ["base", "supply", "equipment"];
const TAGS = ["REPORTED", "SIMULATED"];
const CLOCK_MODES = ["replay", "live", "scenario"];
const SET_PATHS = [
  "settings.goal",
  "settings.weights",
  "settings.evaStartLtst",
  "clock",
  "env.override",
  "scenario",
];
const WEIGHTS = ["energy", "risk", "comms", "radiation", "science"];
const PHOTO_MAX = 45000;
const PHOTO_RE = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/;
const ASSET_PATH = /^assets\.((?!(?:constructor|prototype)$)[A-Za-z][\w-]{0,31})$/;
const ID = /^[\w-]{1,24}:[\w-]{1,24}$/;
const LOCK_TARGETS = {
  zone: /^zone:[\w-]{1,24}:\d{1,9}$/,
  route: /^route:[\w-]{1,24}$/,
  equipment: /^equip:[\w-]{1,32}$/,
};
const MAX_UTC_MS = 8.64e15;
const MAX_ZONES = 8;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v, max) => typeof v === "string" && v.length <= max;
const bad = (why) => ({ err: why ?? "invalid" });

function isNum(v, lo = -Infinity, hi = Infinity) {
  return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
}

function cellOk(v, grid) {
  if (!Number.isInteger(v) || v < 0) return false;
  if (grid?.rows && grid?.cols) return v < grid.rows * grid.cols;
  return true;
}

function cellsOk(list, grid, max) {
  return Array.isArray(list) && list.length <= max && list.every((v) => cellOk(v, grid));
}

function profilesOk(list) {
  if (!Array.isArray(list)) return false;
  if (list.length < 1 || list.length > 3) return false;
  return list.every((profile) => PROFILES.includes(profile));
}

function smallEnough(v, max) {
  try {
    return JSON.stringify(v).length <= max;
  } catch {
    return false;
  }
}

function checkWeights(v) {
  if (!isObj(v) || !WEIGHTS.every((k) => isNum(v[k], 0, 5))) return null;
  return { v: Object.fromEntries(WEIGHTS.map((k) => [k, v[k]])) };
}

function checkClock(v) {
  const valid =
    isObj(v) &&
    CLOCK_MODES.includes(v.mode) &&
    isNum(v.anchorUtcMs, -MAX_UTC_MS, MAX_UTC_MS) &&
    isNum(v.anchorWallMs, 0, MAX_UTC_MS) &&
    isNum(v.rate, 0, 100000) &&
    typeof v.paused === "boolean";
  if (!valid) return null;
  if (v.replaySol != null && !Number.isInteger(v.replaySol)) return null;
  return {
    v: {
      mode: v.mode,
      replaySol: v.replaySol ?? null,
      anchorUtcMs: v.anchorUtcMs,
      anchorWallMs: v.anchorWallMs,
      rate: v.rate,
      paused: v.paused,
    },
  };
}

function isRange(pair, hi) {
  return Array.isArray(pair) && pair.length === 2 && pair.every((x) => isNum(x, 0, hi));
}

function checkEnvOverride(v, grid) {
  if (v === null) return { v };
  const valid =
    isObj(v) &&
    isRange(v.tau, 20) &&
    isRange(v.wind_ms, 150) &&
    isNum(v.wind_dir_deg, 0, 360) &&
    isNum(v.t0Utc) &&
    isNum(v.t1Utc);
  if (!valid) return null;
  if (v.cell != null && !cellOk(v.cell, grid)) return null;
  if (v.radius_m != null && !isNum(v.radius_m, 0, 1e6)) return null;
  if (v.label != null && !isStr(v.label, LIMITS.title)) return null;
  return {
    v: {
      tau: v.tau,
      wind_ms: v.wind_ms,
      wind_dir_deg: v.wind_dir_deg,
      t0Utc: v.t0Utc,
      t1Utc: v.t1Utc,
      cell: v.cell ?? null,
      radius_m: v.radius_m ?? null,
      label: v.label ?? "",
    },
  };
}

function checkScenario(v) {
  const valid =
    isObj(v) &&
    (v.id === null || isStr(v.id, 24)) &&
    typeof v.running === "boolean" &&
    (v.startUtcMs === null || isNum(v.startUtcMs));
  if (!valid) return null;
  return { v: { id: v.id, running: v.running, startUtcMs: v.startUtcMs } };
}

function checkAsset(v, assetId, grid) {
  if (v === null) return { v };
  const valid =
    isObj(v) &&
    v.id === assetId &&
    ASSET_KINDS.includes(v.kind) &&
    isStr(v.name, LIMITS.title) &&
    cellOk(v.cell, grid);
  if (!valid) return null;
  return {
    v: {
      id: v.id,
      kind: v.kind,
      name: v.name.trim(),
      cell: v.cell,
      tag: TAGS.includes(v.tag) ? v.tag : "SIMULATED",
    },
  };
}

function checkSetValue(path, v, grid) {
  if (path === "settings.goal") return v === null || cellOk(v, grid) ? { v } : null;
  if (path === "settings.weights") return checkWeights(v);
  if (path === "settings.evaStartLtst") return isNum(v, 0, 24) ? { v } : null;
  if (path === "clock") return checkClock(v);
  if (path === "env.override") return checkEnvOverride(v, grid);
  if (path === "scenario") return checkScenario(v);
  const asset = ASSET_PATH.exec(path);
  if (asset) return checkAsset(v, asset[1], grid);
  return null;
}

function checkEntryData(data, grid) {
  if (!isObj(data)) return false;
  const { photo, ...rest } = data;
  if (photo !== undefined && !(isStr(photo, PHOTO_MAX) && PHOTO_RE.test(photo))) return false;
  if (!smallEnough(rest, 8000)) return false;
  if (data.path != null && !cellsOk(data.path, grid, 2000)) return false;
  if (data.supersedes != null && !ID.test(data.supersedes)) return false;
  return true;
}

function checkEntry(e, grid) {
  if (!isObj(e) || !ID.test(e.id ?? "")) return null;
  if (!SECTIONS.includes(e.section) || ![1, 2, 3].includes(e.severity)) return null;
  if (!cellOk(e.cell, grid) || !isNum(e.radius_m ?? 0, 0, 200)) return null;
  if (!isStr(e.title, LIMITS.title) || !e.title.trim()) return null;
  if (!isStr(e.note ?? "", LIMITS.note)) return null;
  if (e.profiles != null && !profilesOk(e.profiles)) return null;
  if (!isNum(e.utcMs) || !isNum(e.wallMs ?? 0)) return null;
  const data = e.data ?? {};
  if (!checkEntryData(data, grid)) return null;
  return {
    id: e.id,
    section: e.section,
    severity: LOW_SEVERITY_SECTIONS.includes(e.section) ? 1 : e.severity,
    cell: e.cell,
    radius_m: e.radius_m ?? 0,
    profiles: e.profiles ?? [...PROFILES],
    title: e.title.trim(),
    note: (e.note ?? "").trim(),
    data,
    utcMs: e.utcMs,
    wallMs: e.wallMs ?? e.utcMs,
    sol: Number.isInteger(e.sol) ? e.sol : null,
    ltst: isNum(e.ltst, 0, 24) ? e.ltst : null,
  };
}

function checkSet(op, grid) {
  const known = SET_PATHS.includes(op.path) || /^assets\./.test(op.path ?? "");
  const checked = known ? checkSetValue(op.path, op.v, grid) : null;
  if (!checked) return bad();
  return { op: { t: "set", path: op.path, v: checked.v } };
}

function checkLogStatus(op) {
  const valid =
    ID.test(op.ref ?? "") &&
    ["confirmed", "resolved"].includes(op.status) &&
    isStr(op.note ?? "", LIMITS.note);
  if (!valid) return bad();
  const note = op.note ? { note: op.note.trim() } : {};
  return { op: { t: "log.status", ref: op.ref, status: op.status, ...note } };
}

function checkLockRequest(op, grid) {
  const kind = op.kind;
  if (!LOCK_TARGETS[kind]?.test(op.target ?? "")) return bad();
  if (!isStr(op.reason ?? "", LIMITS.reason)) return bad();
  if (!profilesOk(op.profiles ?? PROFILES)) return bad();
  if (!cellsOk(op.cells ?? [], grid, LIMITS.cells)) return bad();
  if (op.poly != null && !cellsOk(op.poly, grid, LIMITS.poly)) return bad();
  const needsCells = kind === "zone" || kind === "route";
  if (needsCells && !(op.cells?.length > 0)) return bad();
  if (op.ttlMs != null && !isNum(op.ttlMs, 0, 1e9)) return bad();
  return {
    op: {
      t: "lock.request",
      target: op.target,
      kind,
      cells: op.cells ?? [],
      ...(op.poly ? { poly: op.poly } : {}),
      profiles: op.profiles ?? [...PROFILES],
      reason: (op.reason ?? "").trim(),
      sticky: op.sticky === true,
      ...(op.ttlMs != null ? { ttlMs: op.ttlMs } : {}),
    },
  };
}

function checkLockRelease(op) {
  const valid =
    isStr(op.target, 64) &&
    /^(zone|route|equip):/.test(op.target) &&
    (op.fence == null || Number.isInteger(op.fence));
  if (!valid) return bad();
  const fence = op.fence != null ? { fence: op.fence } : {};
  return { op: { t: "lock.release", target: op.target, ...fence } };
}

export function check(op, grid) {
  if (!isObj(op)) return bad();
  if (op.t === "set") return checkSet(op, grid);
  if (op.t === "log.append") {
    const entry = checkEntry(op.entry, grid);
    return entry ? { op: { t: "log.append", entry } } : bad();
  }
  if (op.t === "log.status") return checkLogStatus(op);
  if (op.t === "lock.request") return checkLockRequest(op, grid);
  if (op.t === "lock.release") return checkLockRelease(op);
  return bad();
}

export const validateOp = (op, grid) => check(op, grid).err ?? null;

function setPath(doc, path, value) {
  const keys = path.split(".");
  const out = { ...doc };
  let current = out;
  for (let i = 0; i < keys.length - 1; i++) {
    current[keys[i]] = { ...current[keys[i]] };
    current = current[keys[i]];
  }
  const last = keys.at(-1);
  if (value === null && keys[0] === "assets") {
    delete current[last];
  } else {
    current[last] = value;
  }
  return out;
}

function without(locks, target) {
  const { [target]: _removed, ...rest } = locks;
  return rest;
}

export function applyOp(doc, op, meta = {}) {
  const out = reduce(doc, op, meta);
  const needsSeq = meta.seq != null && !meta.provisional && out.seq !== meta.seq;
  return needsSeq ? { ...out, seq: meta.seq } : out;
}

function reduce(doc, op, meta) {
  const provisional = meta.provisional ? { provisional: true } : {};

  if (op.t === "set") {
    if (!(SET_PATHS.includes(op.path) || ASSET_PATH.test(op.path))) return doc;
    return setPath(doc, op.path, op.v);
  }

  if (op.t === "log.append") {
    const entry = op.entry;
    if (!entry?.id || doc.log[entry.id]) return doc;
    const stored = { ...entry, status: entry.status ?? "open", ...provisional };
    return {
      ...doc,
      log: { ...doc.log, [entry.id]: stored },
      logOrder: [...doc.logOrder, entry.id],
    };
  }

  if (op.t === "log.status") {
    const entry = doc.log[op.ref];
    if (!entry || entry.status === op.status) return doc;
    const updated = {
      ...entry,
      status: op.status,
      statusBy: meta.by?.crew ?? null,
      ...(op.note ? { statusNote: op.note } : {}),
    };
    return { ...doc, log: { ...doc.log, [op.ref]: updated } };
  }

  if (op.t === "lock.grant") {
    const lock = op.lock;
    const fence = meta.provisional ? null : meta.seq ?? lock.fence ?? null;
    return {
      ...doc,
      locks: { ...doc.locks, [lock.target]: { ...lock, fence, ...provisional } },
    };
  }

  if (op.t === "lock.request") {
    if (!meta.provisional || !meta.by || doc.locks[op.target]) return doc;
    const { t: _type, ...rest } = op;
    const lock = {
      ...rest,
      holder: { deviceId: meta.by.deviceId, crew: meta.by.crew },
      fence: null,
      expiresAt: null,
      provisional: true,
    };
    return { ...doc, locks: { ...doc.locks, [op.target]: lock } };
  }

  if (op.t === "lock.release" || op.t === "lock.expired") {
    const lock = doc.locks[op.target];
    if (!lock) return doc;
    const staleFence = !meta.provisional && op.fence != null && op.fence !== lock.fence;
    if (staleFence) return doc;
    return { ...doc, locks: without(doc.locks, op.target) };
  }

  return doc;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const meOf = (from) => ({ deviceId: from.deviceId, crew: from.crew });

const GUARDED_SET = /^(assets\.|scenario$|env\.override$|clock$)/;
const CLOCK_MIN = Date.UTC(1990, 0, 1);
const CLOCK_MAX = Date.UTC(2200, 0, 1);
const DAY_MS = 864e5;

function clockSane(clock, nowMs) {
  if (Math.abs(clock.anchorWallMs - nowMs) > DAY_MS) return false;
  if (clock.mode === "replay") return true;
  const utc = clock.paused
    ? clock.anchorUtcMs
    : clock.anchorUtcMs + (nowMs - clock.anchorWallMs) * clock.rate;
  return utc >= CLOCK_MIN && utc <= CLOCK_MAX;
}

function decideSet(op, from, nowMs, env) {
  const guarded = env.guarded && GUARDED_SET.test(op.path);
  if (guarded && from.role !== "base" && !from.sim) return { nack: "forbidden" };
  if (op.path === "clock" && !clockSane(op.v, nowMs)) return { nack: "invalid" };
  return { ops: [op] };
}

function decideLogAppend(doc, op, from) {
  if (!op.entry.id.startsWith(`${from.deviceId}:`)) return { nack: "forbidden" };
  if (doc.log[op.entry.id]) return { ops: [] };
  const supersedes = op.entry.data?.supersedes;
  if (supersedes) {
    const original = doc.log[supersedes];
    const ownsOriginal = original?.author?.deviceId === from.deviceId;
    if (!original || (!ownsOriginal && from.role !== "base")) return { nack: "forbidden" };
  }
  const entry = {
    ...op.entry,
    author: meOf(from),
    tag: from.sim ? "SIMULATED" : "REPORTED",
    status: "open",
  };
  return { ops: [{ t: "log.append", entry }] };
}

function decideLogStatus(doc, op, from) {
  const entry = doc.log[op.ref];
  if (!entry) return { nack: "unknown" };
  const isAuthor = entry.author?.deviceId === from.deviceId;
  if (op.status === "resolved" && !isAuthor && from.role !== "base") return { nack: "forbidden" };
  if (op.status === "confirmed" && isAuthor) return { nack: "forbidden" };
  const unchanged = entry.status === op.status || entry.status === "resolved";
  return { ops: unchanged ? [] : [op] };
}

function decideLockRequest(doc, op, from, nowMs, env) {
  const isMine = (deviceId) => deviceId === from.deviceId;
  const ownsTarget = op.kind === "equipment" || op.target.split(":")[1] === from.deviceId;
  if (!ownsTarget) return { nack: "forbidden" };

  const current = doc.locks[op.target];
  if (op.kind !== "route" && current && !isMine(current.holder.deviceId)) {
    return { nack: "held", holder: current.holder };
  }

  if (op.kind === "zone") {
    if (!current && !from.sim) {
      const zones = Object.values(doc.locks).filter(
        (lock) => lock.kind === "zone" && isMine(lock.holder.deviceId),
      );
      if (zones.length >= MAX_ZONES) return { nack: "limit" };
    }
    const requested = new Set(op.cells);
    for (const lock of Object.values(doc.locks)) {
      if (lock.kind !== "zone" || isMine(lock.holder.deviceId)) continue;
      if (lock.cells.some((cell) => requested.has(cell))) {
        return { nack: "overlap", holder: lock.holder };
      }
    }
  }

  const ttlMs = clamp(op.ttlMs ?? LIMITS.ttlDef, env.minTtlMs ?? LIMITS.ttlMin, LIMITS.ttlMax);
  const { t: _type, ttlMs: _requestedTtl, ...rest } = op;
  const expiresAt = op.sticky || from.sim ? null : nowMs + ttlMs;
  const lock = { ...rest, holder: meOf(from), ttlMs, expiresAt };
  return { ops: [{ t: "lock.grant", lock }] };
}

function decideLockRelease(doc, op, from) {
  const lock = doc.locks[op.target];
  if (!lock) return { ops: [] };
  if (op.fence == null && !from.sim) return { nack: "invalid" };
  if (op.fence != null && op.fence !== lock.fence) return { ops: [] };
  if (lock.holder.deviceId !== from.deviceId && from.role !== "base") return { nack: "forbidden" };
  return { ops: [{ t: "lock.release", target: op.target, fence: lock.fence }] };
}

export function decide(doc, msg, from, nowMs, env = {}) {
  const checked = check(msg?.op, env.grid);
  if (checked.err) return { nack: "invalid" };
  const op = checked.op;
  if (op.t === "set") return decideSet(op, from, nowMs, env);
  if (op.t === "log.append") return decideLogAppend(doc, op, from);
  if (op.t === "log.status") return decideLogStatus(doc, op, from);
  if (op.t === "lock.request") return decideLockRequest(doc, op, from, nowMs, env);
  if (op.t === "lock.release") return decideLockRelease(doc, op, from);
  return { nack: "invalid" };
}

export function sweep(doc, nowMs) {
  return Object.values(doc.locks)
    .filter((lock) => lock.expiresAt != null && lock.expiresAt <= nowMs)
    .map((lock) => ({ t: "lock.expired", target: lock.target, fence: lock.fence }));
}

export function renew(doc, target, from, nowMs) {
  const lock = doc.locks[target];
  if (!lock || lock.holder.deviceId !== from.deviceId || lock.expiresAt == null) return doc;
  const expiresAt = nowMs + (lock.ttlMs ?? LIMITS.ttlDef);
  return { ...doc, locks: { ...doc.locks, [target]: { ...lock, expiresAt } } };
}

export function view(confirmed, pending = []) {
  return pending.reduce(
    (doc, p) => applyOp(doc, p.op ?? p, { provisional: true, by: p.by }),
    confirmed,
  );
}
