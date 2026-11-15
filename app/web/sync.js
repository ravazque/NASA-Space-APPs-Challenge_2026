import { state, set, on } from "./store.js";
import { applyOp, decide, sweep, renew, view } from "./sync-core.js";
import { t } from "./i18n.js";
import { toast } from "./ui.js";

const BACKOFF = [500, 1000, 2000, 4000, 5000];
const SOLO_QUEUE = ["log.append", "log.status"];
const NET0 = { status: "solo", hub: null, rttMs: null, offsetMs: 0, peers: 0, pending: 0 };

let grid = null, confirmed = null, pending = [], n = 0;
let ws = null, hub = null, attempts = 0, retry = 0, stopped = false, lastPong = 0, pid = 0, ticks = 0;
let samples = [], lastPresence = {}, store = null;
const sent = new Map();
const q = new URLSearchParams(globalThis.location?.search ?? "");

const rd = (k) => { try { return store?.getItem(k) ?? null; } catch { return null; } };
const wr = (k, v) => { try { v == null ? store?.removeItem(k) : store?.setItem(k, v); } catch { } };
const lsRead = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsWrite = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { } };
const clean = (s, d) => (String(s ?? "").replace(/[^\w .-]/g, "").trim().slice(0, 12) || d);

function loadIdentity() {
  const win = q.has("crew");
  try { store = win ? sessionStorage : localStorage; } catch { store = null; }
  const me = state.ui.me;
  let deviceId = rd("ariadne.device");
  if (!deviceId) { deviceId = win ? [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("") : me.deviceId; wr("ariadne.device", deviceId); }
  const role = ["crew", "base"].includes(q.get("role") ?? rd("ariadne.role")) ? (q.get("role") ?? rd("ariadne.role")) : "crew";
  const kind = ["astronaut", "vehicle", "base"].includes(q.get("kind") ?? rd("ariadne.kind")) ? (q.get("kind") ?? rd("ariadne.kind")) : role === "base" ? "base" : "astronaut";
  set("ui", { me: { ...me, deviceId, crew: clean(q.get("crew") ?? rd("ariadne.crew"), `EV-${deviceId.slice(-2).toUpperCase()}`), role, kind } });
}

const saveOutbox = () => { const id = state.ui.me.deviceId; wr(`ariadne.outbox.${id}`, pending.length ? JSON.stringify(pending) : null); wr(`ariadne.n.${id}`, String(n)); };
function loadOutbox() {
  const id = state.ui.me.deviceId;
  n = Number(rd(`ariadne.n.${id}`)) || 0;
  try { const a = JSON.parse(rd(`ariadne.outbox.${id}`) ?? "[]"); pending = Array.isArray(a) ? a.filter((p) => p?.cid && p?.op) : []; } catch { pending = []; }
}

const netSet = (patch) => set("net", patch);
function publish() {
  set("doc", view(confirmed, pending), true);
  if (state.net.pending !== pending.length) netSet({ pending: pending.length });
}
const me = () => ({ deviceId: state.ui.me.deviceId, crew: state.ui.me.crew });
const from = () => ({ ...me(), role: state.ui.me.role });
const live = () => ws?.readyState === 1 && state.net.status === "synced";
const send = (m) => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };
const drop = (cid) => { const k = pending.findIndex((p) => p.cid === cid); if (k < 0) return false; pending.splice(k, 1); saveOutbox(); return true; };

export const hubNow = () => Date.now() + (state.net.offsetMs || 0);
export const getHub = () => hub;

export function submit(op) {
  confirmed ??= state.doc;
  const cid = `${state.ui.me.deviceId}:${++n}`, by = me();
  if (hub) {
    pending.push({ cid, op, by }); saveOutbox(); publish();
    if (live()) send({ t: "op", cid, op });
    return cid;
  }
  saveOutbox();
  const r = localApply(op, from());
  if (r.nack) toast(nackText(r), "warning");
  else if (SOLO_QUEUE.includes(op.t)) { pending.push({ cid, op, by }); saveOutbox(); }
  publish();
  return cid;
}
function localApply(op, f) {
  const r = decide(confirmed, { t: "op", op }, f, Date.now(), { grid });
  if (!r.nack) for (const o of r.ops) confirmed = applyOp(confirmed, o, { seq: confirmed.seq + 1, by: { deviceId: f.deviceId, crew: f.crew } });
  return r;
}

const normalize = (h) => String(h ?? "").trim().replace(/^(https?|wss?):\/\//i, "").replace(/\/.*$/, "");
export function connect(h) {
  const target = normalize(h);
  if (!target) return;
  clearTimeout(retry); closeSocket();
  hub = target; stopped = false; attempts = 0;
  netSet({ hub, status: "connecting" });
  open();
}
export function disconnect() {
  stopped = true; clearTimeout(retry); closeSocket();
  hub = null; lsWrite("ariadne.hub", null);
  set("net", NET0, true); set("presence", {}, true);
}
export function identify(patch) {
  const next = { ...state.ui.me, ...patch };
  next.crew = clean(next.crew, "EV1");
  for (const k of ["crew", "role", "kind"]) wr(`ariadne.${k}`, next[k]);
  set("ui", { me: next });
  lastPresence = {};
  if (live()) hello();
}

function closeSocket() { const w = ws; ws = null; if (w) { w.onclose = w.onmessage = w.onerror = null; try { w.close(); } catch { } } }
function open() {
  clearTimeout(retry);
  const url = `ws://${hub}/sync`;
  let w;
  try { w = ws = new WebSocket(url); } catch (e) { return scheduleRetry(); }
  let ended = false;
  const end = (code) => {
    if (ended) return;
    ended = true; clearTimeout(guard);
    if (w !== ws) return;
    ws = null;
    try { w.close(); } catch { }
    onClosed(code);
  };
  const guard = setTimeout(() => { if (w.readyState === 0) end(1006); }, 4000);
  w.onopen = () => { clearTimeout(guard); hello(); };
  w.onmessage = (e) => { if (w === ws) { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error("ARIADNE sync:", err); } } };
  w.onclose = (e) => end(e.code);
  w.onerror = () => end(1006);
}
function hello() { send({ t: "hello", v: 1, ...me(), role: state.ui.me.role, kind: state.ui.me.kind, lastSeq: confirmed?.seq ?? 0 }); }

function onClosed(code) {
  samples = [];
  netSet({ rttMs: null });
  if (stopped) return;
  if (code === 4001) { stopped = true; netSet({ status: "offline" }); toast(t("hub.replaced"), "warning"); return; }
  scheduleRetry();
}
function scheduleRetry() {
  attempts++;
  netSet({ status: attempts > 2 ? "offline" : "connecting" });
  const d = BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)] * (0.8 + Math.random() * 0.4);
  clearTimeout(retry);
  retry = setTimeout(() => { if (!stopped && hub) { if (attempts <= 2) netSet({ status: "connecting" }); open(); } }, d);
}
function retryNow() { if (hub && !stopped && !live() && ws?.readyState !== 0) { attempts = 0; clearTimeout(retry); netSet({ status: "connecting" }); closeSocket(); open(); } }

function onMessage(m) {
  if (!m || typeof m !== "object") return;
  if (m.t === "snapshot") return onSnapshot(m);
  if (m.t === "op") return onOp(m);
  if (m.t === "ack") { if (drop(m.cid)) publish(); return; }
  if (m.t === "nack") { if (drop(m.cid)) publish(); toast(nackText(m), "warning"); return; }
  if (m.t === "presence") return onPresence(m);
  if (m.t === "pong") return onPong(m);
}
function nackText(m) { return t(`hub.nack.${m.reason ?? m.nack}`, { who: m.holder?.crew ?? "?" }); }

function onSnapshot(m) {
  confirmed = m.doc;
  attempts = 0; lastPong = Date.now();
  if (hub) lsWrite("ariadne.hub", hub);
  const off = Number.isFinite(m.hubNow) ? m.hubNow - Date.now() : 0;
  set("presence", m.presence ?? {}, true);
  netSet({ status: "synced", offsetMs: samples.length ? state.net.offsetMs : off, peers: peerCount(m.presence) });
  for (const p of pending) send({ t: "op", cid: p.cid, op: p.op });
  publish();
  lastPresence = {}; sendPresence(true);
  ping();
}
function onOp(m) {
  if (m.cid) drop(m.cid);
  if (m.seq <= confirmed.seq) return m.cid ? publish() : undefined;
  if (m.seq > confirmed.seq + 1) { ws?.close(); return; }
  confirmed = applyOp(confirmed, m.op, { seq: m.seq, by: m.by });
  publish();
}
const peerCount = (p) => Object.values(p ?? {}).filter((x) => x.online).length;
function onPresence(m) {
  const next = { ...state.presence };
  if (m.gone) delete next[m.deviceId]; else { const { t: _t, ...p } = m; next[m.deviceId] = p; }
  set("presence", next, true);
  const peers = peerCount(next);
  if (peers !== state.net.peers) netSet({ peers });
}

function ping() {
  if (!live()) return;
  const id = ++pid; sent.set(id, performance.now());
  if (sent.size > 20) sent.delete(sent.keys().next().value);
  send({ t: "ping", id, c: Date.now() });
}
function onPong(m) {
  const t0 = sent.get(m.id);
  if (t0 == null) return;
  sent.delete(m.id);
  const rtt = performance.now() - t0;
  lastPong = Date.now();
  samples.push({ rtt, offset: m.h - (m.c + rtt / 2) });
  if (samples.length > 10) samples.shift();
  const last5 = samples.slice(-5).map((s) => s.rtt).sort((a, b) => a - b), best = samples.reduce((a, s) => (s.rtt < a.rtt ? s : a));
  netSet({ rttMs: Math.round(last5[last5.length >> 1] * 10) / 10, offsetMs: Math.round(best.offset) });
}

const myCell = () => state.ui.me.manualCell ?? state.plan?.at?.cell ?? null;
function sendPresence(force) {
  const cell = Number.isInteger(myCell()) ? myCell() : null, kind = state.ui.me.kind;
  if (!force && cell === lastPresence.cell && kind === lastPresence.kind) return;
  lastPresence = { cell, kind };
  if (live()) send({ t: "presence", cell, kind });
}

function tick() {
  ticks++;
  const visible = document.visibilityState !== "hidden";
  if (live()) {
    if (visible && Date.now() - lastPong > 6000) { closeSocket(); onClosed(0); return; }
    if (visible && ticks % 2 === 0) ping();
    if (ticks % 5 === 0) sendPresence(true);
  }
  if (ticks % 10 === 0) renewMine();
  if (!hub) {
    const ops = sweep(confirmed, Date.now());
    if (ops.length) { for (const o of ops) confirmed = applyOp(confirmed, o, { seq: confirmed.seq + 1 }); publish(); }
  }
}
function renewMine() {
  for (const L of Object.values(confirmed?.locks ?? {})) {
    if (L.holder.deviceId !== state.ui.me.deviceId || L.sticky || L.expiresAt == null) continue;
    if (live()) send({ t: "renew", target: L.target }); else if (!hub) confirmed = renew(confirmed, L.target, from(), Date.now());
  }
}

async function resolveHub() {
  const qh = q.get("hub");
  if (qh) return qh;
  if (/^https?:$/.test(location.protocol)) {
    try {
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 1500);
      const r = await fetch("/health", { signal: ctl.signal, cache: "no-store" }).finally(() => clearTimeout(to));
      if (r.ok && (await r.json()).ariadne === true) return location.host;
    } catch { }
  }
  return lsRead("ariadne.hub");
}

async function soloSim(name, ctx) {
  const [{ simStartOps, simOps, simPresence, simFrom, scenarioSeconds, simStepper }, scn] = await Promise.all([import("./sim.js"), fetch(`data/scenarios/${name}.json`).then((r) => r.json())]);
  const d = ctx.data, data = { rows: d.rows, cols: d.cols, cellM: d.cellM, traverse: d.traverse };
  for (const op of simStartOps(scn, data, Date.now())) localApply(op, simFrom(op));
  publish();
  const step = simStepper();
  setInterval(() => {
    if (hub || !confirmed.scenario.running) return;
    const tS = scenarioSeconds(confirmed, Date.now()), span = step(confirmed.clock, tS);
    for (const op of span ? simOps(scn, data, span[0], span[1], confirmed.scenario.startUtcMs) : []) localApply(op, simFrom(op));
    set("presence", Object.fromEntries(simPresence(scn, data, tS).map((p) => [p.deviceId, { ...p, ts: Date.now() }])), true);
    publish();
  }, 1000);
}

export async function init(ctx) {
  grid = { rows: ctx.data.rows, cols: ctx.data.cols };
  loadIdentity();
  confirmed = state.doc;
  loadOutbox();
  set("net", NET0, true);
  if (pending.length) publish();
  setInterval(tick, 1000);
  on("plan", () => sendPresence(false));
  on("ui", () => sendPresence(false));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { lastPong = Date.now(); live() ? ping() : retryNow(); } });
  globalThis.addEventListener?.("online", retryNow);
  resolveHub().then((h) => {
    if (h) connect(h);
    else if (q.get("sim")) soloSim(q.get("sim"), ctx).catch((e) => { console.error("ARIADNE sim:", e); toast(t("hub.sim.error", { name: q.get("sim") }), "danger"); });
  });
}
