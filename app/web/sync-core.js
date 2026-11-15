export function initialDoc(nowMs) {
  return {
    seq: 0,
    settings: { goal: null, weights: { energy: 1, risk: 1, comms: 0.5, radiation: 0.5, science: 1 }, evaStartLtst: 12 },
    clock: { mode: "replay", replaySol: 1210, anchorUtcMs: 1721083230000, anchorWallMs: nowMs, rate: 60, paused: false },
    env: { override: null },
    scenario: { id: null, running: false, startUtcMs: null },
    assets: {},
    locks: {},
    log: {}, logOrder: [],
  };
}

export const LIMITS = { title: 60, note: 500, reason: 80, crew: 12, cells: 9000, poly: 64, ttlMin: 10000, ttlMax: 300000, ttlDef: 30000 };
const SECTIONS = ["fault", "env_change", "route_deviation", "hazard", "sample", "equipment", "note"];
const PROFILES = ["foot", "vehicle", "cargo"];
const ASSET_KINDS = ["base", "supply", "equipment"];
const TAGS = ["REPORTED", "SIMULATED"];
const SET_PATHS = ["settings.goal", "settings.weights", "settings.evaStartLtst", "clock", "env.override", "scenario"];
const WEIGHTS = ["energy", "risk", "comms", "radiation", "science"];
const PHOTO_MAX = 45000, PHOTO_RE = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/;
const ASSET_PATH = /^assets\.((?!(?:constructor|prototype)$)[A-Za-z][\w-]{0,31})$/;
const ID = /^[\w-]{1,24}:[\w-]{1,24}$/, TARGET = { zone: /^zone:[\w-]{1,24}:\d{1,9}$/, route: /^route:[\w-]{1,24}$/, equipment: /^equip:[\w-]{1,32}$/ };

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v, lo = -Infinity, hi = Infinity) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const isStr = (v, max) => typeof v === "string" && v.length <= max;
const bad = (why) => ({ err: why ?? "invalid" });

const cellOk = (v, g) => Number.isInteger(v) && v >= 0 && (g?.rows && g?.cols ? v < g.rows * g.cols : true);
const cellsOk = (a, g, max) => Array.isArray(a) && a.length <= max && a.every((v) => cellOk(v, g));
const profilesOk = (a) => Array.isArray(a) && a.length >= 1 && a.length <= 3 && a.every((p) => PROFILES.includes(p));
const small = (v, max) => { try { return JSON.stringify(v).length <= max; } catch { return false; } };

function checkSetValue(path, v, g) {
  if (path === "settings.goal") return v === null || cellOk(v, g) ? { v } : null;
  if (path === "settings.weights") return isObj(v) && WEIGHTS.every((k) => isNum(v[k], 0, 5)) ? { v: Object.fromEntries(WEIGHTS.map((k) => [k, v[k]])) } : null;
  if (path === "settings.evaStartLtst") return isNum(v, 0, 24) ? { v } : null;
  if (path === "clock") {
    if (!isObj(v) || !["replay", "live", "scenario"].includes(v.mode) || !isNum(v.anchorUtcMs) || !isNum(v.anchorWallMs) || !isNum(v.rate, 0, 100000) || typeof v.paused !== "boolean") return null;
    if (v.replaySol != null && !Number.isInteger(v.replaySol)) return null;
    return { v: { mode: v.mode, replaySol: v.replaySol ?? null, anchorUtcMs: v.anchorUtcMs, anchorWallMs: v.anchorWallMs, rate: v.rate, paused: v.paused } };
  }
  if (path === "env.override") {
    if (v === null) return { v };
    const pair = (p, hi) => Array.isArray(p) && p.length === 2 && p.every((x) => isNum(x, 0, hi));
    if (!isObj(v) || !pair(v.tau, 20) || !pair(v.wind_ms, 150) || !isNum(v.wind_dir_deg, 0, 360) || !isNum(v.t0Utc) || !isNum(v.t1Utc)) return null;
    if ((v.cell != null && !cellOk(v.cell, g)) || (v.radius_m != null && !isNum(v.radius_m, 0, 1e6)) || (v.label != null && !isStr(v.label, LIMITS.title))) return null;
    return { v: { tau: v.tau, wind_ms: v.wind_ms, wind_dir_deg: v.wind_dir_deg, t0Utc: v.t0Utc, t1Utc: v.t1Utc, cell: v.cell ?? null, radius_m: v.radius_m ?? null, label: v.label ?? "" } };
  }
  if (path === "scenario") {
    if (!isObj(v) || (v.id !== null && !isStr(v.id, 24)) || typeof v.running !== "boolean" || (v.startUtcMs !== null && !isNum(v.startUtcMs))) return null;
    return { v: { id: v.id, running: v.running, startUtcMs: v.startUtcMs } };
  }
  const m = ASSET_PATH.exec(path);
  if (m) {
    if (v === null) return { v };
    if (!isObj(v) || v.id !== m[1] || !ASSET_KINDS.includes(v.kind) || !isStr(v.name, LIMITS.title) || !cellOk(v.cell, g)) return null;
    return { v: { id: v.id, kind: v.kind, name: v.name.trim(), cell: v.cell, tag: TAGS.includes(v.tag) ? v.tag : "SIMULATED" } };
  }
  return null;
}

function checkEntry(e, g) {
  if (!isObj(e) || !ID.test(e.id ?? "") || !SECTIONS.includes(e.section) || ![1, 2, 3].includes(e.severity)) return null;
  if (!cellOk(e.cell, g) || !isNum(e.radius_m ?? 0, 0, 200) || !isStr(e.title, LIMITS.title) || !e.title.trim() || !isStr(e.note ?? "", LIMITS.note)) return null;
  if (e.profiles != null && !profilesOk(e.profiles)) return null;
  if (!isNum(e.utcMs) || !isNum(e.wallMs ?? 0)) return null;
  const data = e.data ?? {};
  if (!isObj(data)) return null;
  const { photo, ...rest } = data;
  if (photo !== undefined && !(isStr(photo, PHOTO_MAX) && PHOTO_RE.test(photo))) return null;
  if (!small(rest, 8000) || (data.path != null && !cellsOk(data.path, g, 2000)) || (data.supersedes != null && !ID.test(data.supersedes))) return null;
  return {
    id: e.id, section: e.section, severity: ["sample", "equipment", "note"].includes(e.section) ? 1 : e.severity, cell: e.cell, radius_m: e.radius_m ?? 0,
    profiles: e.profiles ?? [...PROFILES], title: e.title.trim(), note: (e.note ?? "").trim(), data,
    utcMs: e.utcMs, wallMs: e.wallMs ?? e.utcMs, sol: Number.isInteger(e.sol) ? e.sol : null, ltst: isNum(e.ltst, 0, 24) ? e.ltst : null,
  };
}

export function check(op, g) {
  if (!isObj(op)) return bad();
  if (op.t === "set") {
    const r = SET_PATHS.includes(op.path) || /^assets\./.test(op.path ?? "") ? checkSetValue(op.path, op.v, g) : null;
    return r ? { op: { t: "set", path: op.path, v: r.v } } : bad();
  }
  if (op.t === "log.append") { const entry = checkEntry(op.entry, g); return entry ? { op: { t: "log.append", entry } } : bad(); }
  if (op.t === "log.status") {
    if (!ID.test(op.ref ?? "") || !["confirmed", "resolved"].includes(op.status) || !isStr(op.note ?? "", LIMITS.note)) return bad();
    return { op: { t: "log.status", ref: op.ref, status: op.status, ...(op.note ? { note: op.note.trim() } : {}) } };
  }
  if (op.t === "lock.request") {
    const kind = op.kind;
    if (!TARGET[kind]?.test(op.target ?? "") || !isStr(op.reason ?? "", LIMITS.reason) || !profilesOk(op.profiles ?? PROFILES)) return bad();
    if (!cellsOk(op.cells ?? [], g, LIMITS.cells) || (op.poly != null && !cellsOk(op.poly, g, LIMITS.poly))) return bad();
    if ((kind === "zone" || kind === "route") && !(op.cells?.length > 0)) return bad();
    if (op.ttlMs != null && !isNum(op.ttlMs, 0, 1e9)) return bad();
    return { op: { t: "lock.request", target: op.target, kind, cells: op.cells ?? [], ...(op.poly ? { poly: op.poly } : {}), profiles: op.profiles ?? [...PROFILES],
      reason: (op.reason ?? "").trim(), sticky: op.sticky === true, ...(op.ttlMs != null ? { ttlMs: op.ttlMs } : {}) } };
  }
  if (op.t === "lock.release") {
    if (!isStr(op.target, 64) || !/^(zone|route|equip):/.test(op.target) || (op.fence != null && !Number.isInteger(op.fence))) return bad();
    return { op: { t: "lock.release", target: op.target, ...(op.fence != null ? { fence: op.fence } : {}) } };
  }
  return bad();
}
export const validateOp = (op, grid) => check(op, grid).err ?? null;

function setPath(doc, path, v) {
  const keys = path.split("."), out = { ...doc };
  let cur = out;
  for (let i = 0; i < keys.length - 1; i++) { cur[keys[i]] = { ...cur[keys[i]] }; cur = cur[keys[i]]; }
  const last = keys.at(-1);
  if (v === null && keys[0] === "assets") delete cur[last]; else cur[last] = v;
  return out;
}
const without = (locks, target) => { const { [target]: _, ...rest } = locks; return rest; };

export function applyOp(doc, op, meta = {}) {
  const out = reduce(doc, op, meta);
  return meta.seq != null && !meta.provisional && out.seq !== meta.seq ? { ...out, seq: meta.seq } : out;
}
function reduce(doc, op, meta) {
  let out = doc;
  const prov = meta.provisional ? { provisional: true } : {};
  if (op.t === "set") {
    if (!(SET_PATHS.includes(op.path) || ASSET_PATH.test(op.path))) return doc;
    out = setPath(doc, op.path, op.v);
  } else if (op.t === "log.append") {
    const e = op.entry;
    if (!e?.id || doc.log[e.id]) return doc;
    out = { ...doc, log: { ...doc.log, [e.id]: { ...e, status: e.status ?? "open", ...prov } }, logOrder: [...doc.logOrder, e.id] };
  } else if (op.t === "log.status") {
    const e = doc.log[op.ref];
    if (!e || e.status === op.status) return doc;
    out = { ...doc, log: { ...doc.log, [op.ref]: { ...e, status: op.status, statusBy: meta.by?.crew ?? null, ...(op.note ? { statusNote: op.note } : {}) } } };
  } else if (op.t === "lock.grant") {
    const L = op.lock;
    out = { ...doc, locks: { ...doc.locks, [L.target]: { ...L, fence: meta.provisional ? null : meta.seq ?? L.fence ?? null, ...prov } } };
  } else if (op.t === "lock.request") {
    if (!meta.provisional || !meta.by || doc.locks[op.target]) return doc;
    const { t, ...rest } = op;
    out = { ...doc, locks: { ...doc.locks, [op.target]: { ...rest, holder: { deviceId: meta.by.deviceId, crew: meta.by.crew }, fence: null, expiresAt: null, provisional: true } } };
  } else if (op.t === "lock.release" || op.t === "lock.expired") {
    const L = doc.locks[op.target];
    if (!L || (!meta.provisional && op.fence != null && op.fence !== L.fence)) return doc;
    out = { ...doc, locks: without(doc.locks, op.target) };
  } else return doc;
  return out;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const meOf = (from) => ({ deviceId: from.deviceId, crew: from.crew });

export function decide(doc, msg, from, nowMs, env = {}) {
  const r = check(msg?.op, env.grid);
  if (r.err) return { nack: "invalid" };
  const op = r.op;
  if (op.t === "set") return { ops: [op] };

  if (op.t === "log.append") {
    if (!op.entry.id.startsWith(`${from.deviceId}:`)) return { nack: "forbidden" };
    if (doc.log[op.entry.id]) return { ops: [] };
    const sup = op.entry.data?.supersedes;
    if (sup && (!doc.log[sup] || (doc.log[sup].author?.deviceId !== from.deviceId && from.role !== "base"))) return { nack: "forbidden" };
    return { ops: [{ t: "log.append", entry: { ...op.entry, author: meOf(from), tag: from.sim ? "SIMULATED" : "REPORTED", status: "open" } }] };
  }

  if (op.t === "log.status") {
    const e = doc.log[op.ref];
    if (!e) return { nack: "unknown" };
    const author = e.author?.deviceId === from.deviceId;
    if (op.status === "resolved" && !author && from.role !== "base") return { nack: "forbidden" };
    if (op.status === "confirmed" && author) return { nack: "forbidden" };
    return { ops: e.status === op.status || e.status === "resolved" ? [] : [op] };
  }

  if (op.t === "lock.request") {
    const mine = (id) => id === from.deviceId;
    const own = op.kind === "equipment" ? true : op.target.split(":")[1] === from.deviceId;
    if (!own) return { nack: "forbidden" };
    const cur = doc.locks[op.target];
    if (op.kind !== "route" && cur && !mine(cur.holder.deviceId)) return { nack: "held", holder: cur.holder };
    if (op.kind === "zone") {
      const mineSet = new Set(op.cells);
      for (const L of Object.values(doc.locks)) {
        if (L.kind !== "zone" || mine(L.holder.deviceId)) continue;
        if (L.cells.some((c) => mineSet.has(c))) return { nack: "overlap", holder: L.holder };
      }
    }
    const ttlMs = clamp(op.ttlMs ?? LIMITS.ttlDef, env.minTtlMs ?? LIMITS.ttlMin, LIMITS.ttlMax);
    const { t, ttlMs: _t, ...rest } = op;
    return { ops: [{ t: "lock.grant", lock: { ...rest, holder: meOf(from), ttlMs, expiresAt: op.sticky || from.sim ? null : nowMs + ttlMs } }] };
  }

  if (op.t === "lock.release") {
    const L = doc.locks[op.target];
    if (!L) return { ops: [] };
    if (op.fence == null && !from.sim) return { nack: "invalid" };
    if (op.fence != null && op.fence !== L.fence) return { ops: [] };
    if (L.holder.deviceId !== from.deviceId && from.role !== "base") return { nack: "forbidden" };
    return { ops: [{ t: "lock.release", target: op.target, fence: L.fence }] };
  }
  return { nack: "invalid" };
}

export function sweep(doc, nowMs) {
  return Object.values(doc.locks).filter((L) => L.expiresAt != null && L.expiresAt <= nowMs).map((L) => ({ t: "lock.expired", target: L.target, fence: L.fence }));
}

export function renew(doc, target, from, nowMs) {
  const L = doc.locks[target];
  if (!L || L.holder.deviceId !== from.deviceId || L.expiresAt == null) return doc;
  return { ...doc, locks: { ...doc.locks, [target]: { ...L, expiresAt: nowMs + (L.ttlMs ?? LIMITS.ttlDef) } } };
}

export function view(confirmed, pending = []) {
  return pending.reduce((d, p) => applyOp(d, p.op ?? p, { provisional: true, by: p.by }), confirmed);
}
