import { state, set } from "./store.js";
import { applyOp } from "./sync-core.js";

let n = 0, confirmed = null;
const NET0 = { status: "solo", hub: null, rttMs: null, offsetMs: 0, peers: 0, pending: 0 };

export async function init(ctx) { confirmed = state.doc; set("net", NET0, true); }

export function submit(op) {
  confirmed ??= state.doc;
  const cid = `${state.ui.me.deviceId}:${++n}`;
  confirmed = applyOp(confirmed, op, { seq: confirmed.seq + 1, by: { deviceId: state.ui.me.deviceId, crew: state.ui.me.crew }, cid });
  set("doc", confirmed, true);
  return cid;
}
export const connect = (hub) => {};
export const disconnect = () => {};
export const hubNow = () => Date.now() + (state.net.offsetMs || 0);
