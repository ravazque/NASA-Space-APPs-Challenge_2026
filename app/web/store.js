import { initialDoc } from "./sync-core.js";

const rid = () => { try { return localStorage.getItem("ariadne.device") || [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join(""); } catch { return "00000000"; } };

export const state = {
  data: null,
  ui: { tab: "plan", drawer: false, raster: "none", show: {}, profile: "foot", follow: true, me: { deviceId: rid(), crew: "EV1", role: "crew" }, selected: null },
  doc: initialDoc(Date.now()),
  presence: {},
  net: { status: "solo", hub: null, rttMs: null, offsetMs: 0, peers: 0, pending: 0 },
  clock: {},
  env: {},
  plan: {},
};

const subs = new Map();
export function on(topic, fn) {
  if (!subs.has(topic)) subs.set(topic, new Set());
  subs.get(topic).add(fn);
  return () => subs.get(topic).delete(fn);
}
export function emit(topic, payload) {
  for (const fn of [...(subs.get(topic) ?? [])]) {
    try { fn(payload, state); } catch (e) { console.error(`ARIADNE listener "${topic}":`, e); }
  }
}
export function set(slice, patch, replace = false) {
  state[slice] = replace ? patch : { ...state[slice], ...patch };
  emit(slice, state[slice]);
}
