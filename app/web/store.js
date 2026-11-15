import { initialDoc } from "./sync-core.js";

function randomDeviceId() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function loadDeviceId() {
  try {
    return localStorage.getItem("ariadne.device") || randomDeviceId();
  } catch {
    return randomDeviceId();
  }
}

export const state = {
  data: null,
  ui: {
    tab: "plan",
    drawer: false,
    raster: "none",
    show: {},
    profile: "foot",
    follow: false,
    me: { deviceId: loadDeviceId(), crew: "EV1", role: "crew" },
    selected: null,
  },
  doc: initialDoc(Date.now()),
  presence: {},
  net: { status: "solo", hub: null, rttMs: null, offsetMs: 0, peers: 0, pending: 0 },
  clock: {},
  env: {},
  plan: {},
};

const subscribers = new Map();

export function on(topic, listener) {
  if (!subscribers.has(topic)) subscribers.set(topic, new Set());
  subscribers.get(topic).add(listener);
  return () => subscribers.get(topic).delete(listener);
}

export function emit(topic, payload) {
  for (const listener of [...(subscribers.get(topic) ?? [])]) {
    try {
      listener(payload, state);
    } catch (error) {
      console.error(`ARIADNE listener "${topic}":`, error);
    }
  }
}

export function set(slice, patch, replace = false) {
  state[slice] = replace ? patch : { ...state[slice], ...patch };
  emit(slice, state[slice]);
}
