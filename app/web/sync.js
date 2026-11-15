import { state, set, on } from "./store.js";
import { applyOp, decide, sweep, renew, view } from "./sync-core.js";
import { t } from "./i18n.js";
import { toast } from "./ui.js";

const BACKOFF_MS = [500, 1000, 2000, 4000, 5000];
const SOLO_QUEUE = ["log.append", "log.status"];
const SOLO_NET = { status: "solo", hub: null, rttMs: null, offsetMs: 0, peers: 0, pending: 0 };
const WS_OPEN = 1;
const WS_CONNECTING = 0;
const CONNECT_TIMEOUT_MS = 4000;
const PONG_TIMEOUT_MS = 6000;
const MAX_RTT_SAMPLES = 10;
const MAX_PENDING_PINGS = 20;
const TOKEN_MAX = 64;
const CLOSE_BAD_TOKEN = 4403;
const CLOSE_REPLACED = 4001;
const OFFLINE_AFTER_ATTEMPTS = 2;

let grid = null;
let confirmed = null;
let pending = [];
let opCounter = 0;
let ws = null;
let hub = null;
let attempts = 0;
let retryTimer = 0;
let stopped = false;
let lastPong = 0;
let pingId = 0;
let ticks = 0;
let rttSamples = [];
let lastPresence = {};
let identityStore = null;
const pingSentAt = new Map();
const query = new URLSearchParams(globalThis.location?.search ?? "");

function identityGet(key) {
  try {
    return identityStore?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function identitySet(key, value) {
  try {
    if (value == null) identityStore?.removeItem(key);
    else identityStore?.setItem(key, value);
  } catch {}
}

function localGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function localSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

function cleanCrewName(value, fallback) {
  const name = String(value ?? "").replace(/[^\w .-]/g, "").trim().slice(0, 12);
  return name || fallback;
}

function randomDeviceId() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function oneOf(allowed, value, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function loadIdentity() {
  const ownWindow = query.has("crew");
  if (query.get("token")) localSet("ariadne.token", query.get("token").slice(0, TOKEN_MAX));
  try {
    identityStore = ownWindow ? sessionStorage : localStorage;
  } catch {
    identityStore = null;
  }

  const me = state.ui.me;
  let deviceId = identityGet("ariadne.device");
  if (!deviceId) {
    deviceId = ownWindow ? randomDeviceId() : me.deviceId;
    identitySet("ariadne.device", deviceId);
  }

  const role = oneOf(["crew", "base"], query.get("role") ?? identityGet("ariadne.role"), "crew");
  const defaultKind = role === "base" ? "base" : "astronaut";
  const kind = oneOf(
    ["astronaut", "vehicle", "base"],
    query.get("kind") ?? identityGet("ariadne.kind"),
    defaultKind,
  );
  const defaultCrew = `EV-${deviceId.slice(-2).toUpperCase()}`;
  const crew = cleanCrewName(query.get("crew") ?? identityGet("ariadne.crew"), defaultCrew);
  set("ui", { me: { ...me, deviceId, crew, role, kind } });
}

function saveOutbox() {
  const id = state.ui.me.deviceId;
  identitySet(`ariadne.outbox.${id}`, pending.length ? JSON.stringify(pending) : null);
  identitySet(`ariadne.n.${id}`, String(opCounter));
}

function loadOutbox() {
  const id = state.ui.me.deviceId;
  opCounter = Number(identityGet(`ariadne.n.${id}`)) || 0;
  try {
    const saved = JSON.parse(identityGet(`ariadne.outbox.${id}`) ?? "[]");
    pending = Array.isArray(saved) ? saved.filter((p) => p?.cid && p?.op) : [];
  } catch {
    pending = [];
  }
}

const setNet = (patch) => set("net", patch);

function publish() {
  set("doc", view(confirmed, pending), true);
  if (state.net.pending !== pending.length) setNet({ pending: pending.length });
}

const me = () => ({ deviceId: state.ui.me.deviceId, crew: state.ui.me.crew });
const sender = () => ({ ...me(), role: state.ui.me.role });
const isLive = () => ws?.readyState === WS_OPEN && state.net.status === "synced";

function send(message) {
  if (ws?.readyState === WS_OPEN) ws.send(JSON.stringify(message));
}

function dropPending(cid) {
  const index = pending.findIndex((p) => p.cid === cid);
  if (index < 0) return false;
  pending.splice(index, 1);
  saveOutbox();
  return true;
}

export const hubNow = () => Date.now() + (state.net.offsetMs || 0);
export const getHub = () => hub;

function nackText(message) {
  return t(`hub.nack.${message.reason ?? message.nack}`, { who: message.holder?.crew ?? "?" });
}

function localApply(op, from) {
  const result = decide(confirmed, { t: "op", op }, from, Date.now(), { grid });
  if (result.nack) return result;
  const by = { deviceId: from.deviceId, crew: from.crew };
  for (const accepted of result.ops) {
    confirmed = applyOp(confirmed, accepted, { seq: confirmed.seq + 1, by });
  }
  return result;
}

export function submit(op) {
  confirmed ??= state.doc;
  const cid = `${state.ui.me.deviceId}:${++opCounter}`;
  const by = me();

  if (hub) {
    pending.push({ cid, op, by });
    saveOutbox();
    publish();
    if (isLive()) send({ t: "op", cid, op });
    return cid;
  }

  saveOutbox();
  const result = localApply(op, sender());
  if (result.nack) {
    toast(nackText(result), "warning");
  } else if (SOLO_QUEUE.includes(op.t)) {
    pending.push({ cid, op, by });
    saveOutbox();
  }
  publish();
  return cid;
}

function normalizeHub(address) {
  return String(address ?? "")
    .trim()
    .replace(/^(https?|wss?):\/\//i, "")
    .replace(/\/.*$/, "");
}

export function connect(address) {
  const target = normalizeHub(address);
  if (!target) return;
  clearTimeout(retryTimer);
  closeSocket();
  hub = target;
  stopped = false;
  attempts = 0;
  setNet({ hub, status: "connecting" });
  openSocket();
}

export function disconnect() {
  stopped = true;
  clearTimeout(retryTimer);
  closeSocket();
  hub = null;
  localSet("ariadne.hub", null);
  set("net", SOLO_NET, true);
  set("presence", {}, true);
}

export function identify(patch) {
  const next = { ...state.ui.me, ...patch };
  next.crew = cleanCrewName(next.crew, "EV1");
  for (const key of ["crew", "role", "kind"]) identitySet(`ariadne.${key}`, next[key]);
  set("ui", { me: next });
  lastPresence = {};
  if (isLive()) sendHello();
}

function closeSocket() {
  const old = ws;
  ws = null;
  if (!old) return;
  old.onclose = null;
  old.onmessage = null;
  old.onerror = null;
  try {
    old.close();
  } catch {}
}

function openSocket() {
  clearTimeout(retryTimer);
  let socket;
  try {
    socket = ws = new WebSocket(`ws://${hub}/sync`);
  } catch {
    scheduleRetry();
    return;
  }

  let ended = false;
  let connectGuard = 0;

  function end(code) {
    if (ended) return;
    ended = true;
    clearTimeout(connectGuard);
    if (socket !== ws) return;
    ws = null;
    try {
      socket.close();
    } catch {}
    onClosed(code);
  }

  connectGuard = setTimeout(() => {
    if (socket.readyState === WS_CONNECTING) end(1006);
  }, CONNECT_TIMEOUT_MS);

  socket.onopen = () => {
    clearTimeout(connectGuard);
    sendHello();
  };
  socket.onmessage = (event) => {
    if (socket !== ws) return;
    try {
      onMessage(JSON.parse(event.data));
    } catch (err) {
      console.error("ARIADNE sync:", err);
    }
  };
  socket.onclose = (event) => end(event.code);
  socket.onerror = () => end(1006);
}

function token() {
  return (query.get("token") ?? localGet("ariadne.token") ?? "").slice(0, TOKEN_MAX);
}

function sendHello() {
  send({
    t: "hello",
    v: 1,
    ...me(),
    role: state.ui.me.role,
    kind: state.ui.me.kind,
    lastSeq: confirmed?.seq ?? 0,
    token: token() || undefined,
  });
}

function onClosed(code) {
  rttSamples = [];
  setNet({ rttMs: null });
  if (stopped) return;
  if (code === CLOSE_BAD_TOKEN) {
    stopped = true;
    setNet({ status: "offline" });
    toast(t("hub.badtoken"), "warning");
    return;
  }
  if (code === CLOSE_REPLACED) {
    stopped = true;
    setNet({ status: "offline" });
    toast(t("hub.replaced"), "warning");
    return;
  }
  scheduleRetry();
}

function scheduleRetry() {
  attempts++;
  setNet({ status: attempts > OFFLINE_AFTER_ATTEMPTS ? "offline" : "connecting" });
  const base = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
  const delay = base * (0.8 + Math.random() * 0.4);
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (stopped || !hub) return;
    if (attempts <= OFFLINE_AFTER_ATTEMPTS) setNet({ status: "connecting" });
    openSocket();
  }, delay);
}

function retryNow() {
  if (!hub || stopped || isLive() || ws?.readyState === WS_CONNECTING) return;
  attempts = 0;
  clearTimeout(retryTimer);
  setNet({ status: "connecting" });
  closeSocket();
  openSocket();
}

function onMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.t === "snapshot") {
    onSnapshot(message);
  } else if (message.t === "op") {
    onOp(message);
  } else if (message.t === "ack") {
    if (dropPending(message.cid)) publish();
  } else if (message.t === "nack") {
    if (dropPending(message.cid)) publish();
    toast(nackText(message), "warning");
  } else if (message.t === "presence") {
    onPresence(message);
  } else if (message.t === "pong") {
    onPong(message);
  }
}

const countOnline = (presence) => Object.values(presence ?? {}).filter((p) => p.online).length;

function onSnapshot(message) {
  confirmed = message.doc;
  attempts = 0;
  lastPong = Date.now();
  if (hub) localSet("ariadne.hub", hub);
  const hubOffset = Number.isFinite(message.hubNow) ? message.hubNow - Date.now() : 0;
  set("presence", message.presence ?? {}, true);
  setNet({
    status: "synced",
    offsetMs: rttSamples.length ? state.net.offsetMs : hubOffset,
    peers: countOnline(message.presence),
  });
  for (const p of pending) send({ t: "op", cid: p.cid, op: p.op });
  publish();
  lastPresence = {};
  sendPresence(true);
  sendPing();
}

function onOp(message) {
  if (message.cid) dropPending(message.cid);
  if (message.seq <= confirmed.seq) {
    if (message.cid) publish();
    return;
  }
  if (message.seq > confirmed.seq + 1) {
    ws?.close();
    return;
  }
  confirmed = applyOp(confirmed, message.op, { seq: message.seq, by: message.by });
  publish();
}

function onPresence(message) {
  const next = { ...state.presence };
  if (message.gone) {
    delete next[message.deviceId];
  } else {
    const { t: _type, ...peer } = message;
    next[message.deviceId] = peer;
  }
  set("presence", next, true);
  const peers = countOnline(next);
  if (peers !== state.net.peers) setNet({ peers });
}

function sendPing() {
  if (!isLive()) return;
  const id = ++pingId;
  pingSentAt.set(id, performance.now());
  if (pingSentAt.size > MAX_PENDING_PINGS) pingSentAt.delete(pingSentAt.keys().next().value);
  send({ t: "ping", id, c: Date.now() });
}

function onPong(message) {
  const sentAt = pingSentAt.get(message.id);
  if (sentAt == null) return;
  pingSentAt.delete(message.id);
  const rtt = performance.now() - sentAt;
  lastPong = Date.now();
  rttSamples.push({ rtt, offset: message.h - (message.c + rtt / 2) });
  if (rttSamples.length > MAX_RTT_SAMPLES) rttSamples.shift();

  const lastFive = rttSamples.slice(-5).map((s) => s.rtt).sort((a, b) => a - b);
  const median = lastFive[lastFive.length >> 1];
  const best = rttSamples.reduce((a, s) => (s.rtt < a.rtt ? s : a));
  setNet({ rttMs: Math.round(median * 10) / 10, offsetMs: Math.round(best.offset) });
}

const myCell = () => state.ui.me.manualCell ?? state.plan?.at?.cell ?? null;

function sendPresence(force) {
  const cell = Number.isInteger(myCell()) ? myCell() : null;
  const kind = state.ui.me.kind;
  if (!force && cell === lastPresence.cell && kind === lastPresence.kind) return;
  lastPresence = { cell, kind };
  if (isLive()) send({ t: "presence", cell, kind });
}

function expireLocksLocally() {
  const expired = sweep(confirmed, Date.now());
  if (!expired.length) return;
  for (const op of expired) {
    confirmed = applyOp(confirmed, op, { seq: confirmed.seq + 1 });
  }
  publish();
}

function tick() {
  ticks++;
  const visible = document.visibilityState !== "hidden";
  if (isLive()) {
    if (visible && Date.now() - lastPong > PONG_TIMEOUT_MS) {
      closeSocket();
      onClosed(0);
      return;
    }
    if (visible && ticks % 2 === 0) sendPing();
    if (ticks % 5 === 0) sendPresence(true);
  }
  if (ticks % 10 === 0) renewMyLocks();
  if (!hub) expireLocksLocally();
}

function renewMyLocks() {
  const myId = state.ui.me.deviceId;
  for (const lock of Object.values(confirmed?.locks ?? {})) {
    if (lock.holder.deviceId !== myId || lock.sticky || lock.expiresAt == null) continue;
    if (isLive()) {
      send({ t: "renew", target: lock.target });
    } else if (!hub) {
      confirmed = renew(confirmed, lock.target, sender(), Date.now());
    }
  }
}

function servedByHub() {
  if (!/^https?:$/.test(location.protocol)) return false;
  const navigation = performance.getEntriesByType?.("navigation")[0];
  return !!navigation?.serverTiming?.some((entry) => entry.name === "ariadne-hub");
}

async function probeHealth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  const response = await fetch("/health", { signal: controller.signal, cache: "no-store" })
    .finally(() => clearTimeout(timeout));
  return response.ok && (await response.json()).ariadne === true;
}

async function resolveHub() {
  const fromQuery = query.get("hub");
  if (fromQuery) return fromQuery;
  if (servedByHub()) {
    try {
      if (await probeHealth()) return location.host;
    } catch {}
  }
  return localGet("ariadne.hub");
}

async function soloSim(name, ctx) {
  const [sim, scenario] = await Promise.all([
    import("./sim.js"),
    fetch(`data/scenarios/${name}.json`).then((r) => r.json()),
  ]);
  const { rows, cols, cellM, traverse } = ctx.data;
  const data = { rows, cols, cellM, traverse };

  for (const op of sim.simStartOps(scenario, data, Date.now())) {
    localApply(op, sim.simFrom(op));
  }
  publish();

  const step = sim.simStepper();
  setInterval(() => {
    if (hub || !confirmed.scenario.running) return;
    const seconds = sim.scenarioSeconds(confirmed, Date.now());
    const span = step(confirmed.clock, seconds);
    if (span) {
      const ops = sim.simOps(scenario, data, span[0], span[1], confirmed.scenario.startUtcMs);
      for (const op of ops) localApply(op, sim.simFrom(op));
    }
    const now = Date.now();
    const actors = sim.simPresence(scenario, data, seconds);
    set(
      "presence",
      Object.fromEntries(actors.map((p) => [p.deviceId, { ...p, ts: now }])),
      true,
    );
    publish();
  }, 1000);
}

function onVisibilityChange() {
  if (document.visibilityState !== "visible") return;
  lastPong = Date.now();
  if (isLive()) sendPing();
  else retryNow();
}

export async function init(ctx) {
  grid = { rows: ctx.data.rows, cols: ctx.data.cols };
  loadIdentity();
  confirmed = state.doc;
  loadOutbox();
  set("net", SOLO_NET, true);
  if (pending.length) publish();

  setInterval(tick, 1000);
  on("plan", () => sendPresence(false));
  on("ui", () => sendPresence(false));
  document.addEventListener("visibilitychange", onVisibilityChange);
  globalThis.addEventListener?.("online", retryNow);

  resolveHub().then((address) => {
    if (address) {
      connect(address);
      return;
    }
    const simName = query.get("sim");
    if (!simName) return;
    soloSim(simName, ctx).catch((err) => {
      console.error("ARIADNE sim:", err);
      toast(t("hub.sim.error", { name: simName }), "danger");
    });
  });
}
