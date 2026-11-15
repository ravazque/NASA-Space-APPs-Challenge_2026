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

const SET_PATHS = ["settings.goal", "settings.weights", "settings.evaStartLtst", "clock", "env.override", "scenario"];
const okPath = (p) => SET_PATHS.includes(p) || /^assets\.[\w:-]+$/.test(p);

function setPath(doc, path, v) {
  const keys = path.split("."), out = { ...doc };
  let cur = out;
  for (let i = 0; i < keys.length - 1; i++) { cur[keys[i]] = { ...cur[keys[i]] }; cur = cur[keys[i]]; }
  const last = keys.at(-1);
  if (v === null && keys[0] === "assets") delete cur[last]; else cur[last] = v;
  return out;
}

export function applyOp(doc, op, meta = {}) {
  let out = doc;
  if (op.t === "set") {
    if (!okPath(op.path)) return doc;
    out = setPath(doc, op.path, op.v);
  } else if (op.t === "log.append") {
    const e = op.entry;
    if (!e?.id || doc.log[e.id]) return doc;
    out = { ...doc, log: { ...doc.log, [e.id]: { ...e, status: e.status ?? "open", ...(meta.provisional ? { provisional: true } : {}) } }, logOrder: [...doc.logOrder, e.id] };
  } else return doc;
  if (meta.seq != null && !meta.provisional) out = { ...out, seq: meta.seq };
  return out;
}

export const validateOp = (op, grid) => (op && typeof op.t === "string" ? null : "invalid");
export const decide = (doc, msg, from, nowMs) => ({ ops: msg?.op ? [msg.op] : [] });
export const sweep = (doc, nowMs) => [];
export function view(confirmed, pending = []) {
  return pending.reduce((d, op) => applyOp(d, op, { provisional: true }), confirmed);
}
