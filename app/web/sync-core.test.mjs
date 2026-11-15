import test from "node:test";
import assert from "node:assert/strict";
import { initialDoc, applyOp, validateOp, decide, sweep, renew, view } from "./sync-core.js";

const G = { rows: 10, cols: 10 }, ENV = { grid: G, minTtlMs: 100 };
const A = { deviceId: "a1", crew: "EV1", role: "crew" }, B = { deviceId: "b1", crew: "EV2", role: "crew" }, BASE = { deviceId: "ba", crew: "BASE", role: "base" };
const entry = (id, o = {}) => ({ id, section: "hazard", severity: 3, cell: 5, radius_m: 40, title: "Rock", utcMs: 1, ...o });
const zone = (dev, n, cells, o = {}) => ({ t: "lock.request", target: `zone:${dev}:${n}`, kind: "zone", cells, profiles: ["foot"], reason: "r", sticky: false, ...o });
function run(doc, from, op, now = 1000) {
  const r = decide(doc, { t: "op", op }, from, now, ENV);
  if (r.nack) return { doc, r };
  let d = doc;
  for (const o of r.ops) d = applyOp(d, o, { seq: d.seq + 1, by: { deviceId: from.deviceId, crew: from.crew } });
  return { doc: d, r };
}
const d0 = () => initialDoc(0);

test("set is last-writer-wins in sequence order and keeps untouched subtrees by identity", () => {
  let d = d0();
  const { log, locks } = d;
  d = applyOp(d, { t: "set", path: "settings.goal", v: 7 }, { seq: 1 });
  d = applyOp(d, { t: "set", path: "settings.goal", v: 9 }, { seq: 2 });
  assert.equal(d.settings.goal, 9); assert.equal(d.seq, 2);
  assert.equal(d.log, log); assert.equal(d.locks, locks);
  d = applyOp(d, { t: "set", path: "assets.x", v: { id: "x", kind: "supply", name: "S", cell: 3 } }, { seq: 3 });
  assert.ok(d.assets.x);
  d = applyOp(d, { t: "set", path: "assets.x", v: null }, { seq: 4 });
  assert.equal(d.assets.x, undefined);
  assert.equal(applyOp(d, { t: "set", path: "__proto__.x", v: 1 }, { seq: 5 }).seq, 5);
});

test("log.append is idempotent by id and never edits", () => {
  let d = run(d0(), A, { t: "log.append", entry: entry("a1:1") }).doc;
  const again = run(d, A, { t: "log.append", entry: entry("a1:1", { title: "Edited" }) });
  assert.deepEqual(again.r.ops, []); assert.equal(again.doc, d);
  assert.equal(d.log["a1:1"].title, "Rock"); assert.deepEqual(d.logOrder, ["a1:1"]);
  assert.equal(d.log["a1:1"].author.crew, "EV1");
  assert.equal(d.log["a1:1"].tag, "REPORTED");
  assert.equal(decide(d, { op: { t: "log.append", entry: entry("b1:1") } }, A, 0, ENV).nack, "forbidden");
});

test("only the scenario writes SIMULATED, and sample/equipment/note are fixed at severity 1", () => {
  const sim = { deviceId: "sim-EV2", crew: "EV2", role: "crew", sim: true };
  let r = decide(d0(), { op: { t: "log.append", entry: { ...entry("sim-EV2:e1"), tag: "REPORTED" } } }, sim, 0, ENV);
  assert.equal(r.ops[0].entry.tag, "SIMULATED");
  r = decide(d0(), { op: { t: "log.append", entry: { ...entry("a1:1", { section: "note", severity: 3 }), tag: "SIMULATED" } } }, A, 0, ENV);
  assert.equal(r.ops[0].entry.tag, "REPORTED"); assert.equal(r.ops[0].entry.severity, 1);
});

test("log.status: resolved by the author or base, confirmed by anyone but the author", () => {
  const d = run(d0(), A, { t: "log.append", entry: entry("a1:1") }).doc;
  const st = (from, status, ref = "a1:1") => decide(d, { op: { t: "log.status", ref, status } }, from, 0, ENV);
  assert.equal(st(B, "resolved").nack, "forbidden");
  assert.equal(st(A, "confirmed").nack, "forbidden");
  assert.equal(st(B, "confirmed").ops[0].status, "confirmed");
  assert.equal(st(A, "resolved").ops.length, 1);
  assert.equal(st(BASE, "resolved").ops.length, 1);
  assert.equal(st(BASE, "resolved", "zz:1").nack, "unknown");
  const r = run(d, BASE, { t: "log.status", ref: "a1:1", status: "resolved" }).doc;
  assert.equal(r.log["a1:1"].status, "resolved"); assert.equal(r.log["a1:1"].statusBy, "BASE");
  assert.deepEqual(decide(r, { op: { t: "log.status", ref: "a1:1", status: "confirmed" } }, B, 0, ENV).ops, []);
});

test("zone locks: overlap -> nack with the holder; own zones may overlap; disjoint zones are granted", () => {
  const d = run(d0(), A, zone("a1", 1, [1, 2, 3])).doc;
  const r = decide(d, { op: zone("b1", 1, [3, 4]) }, B, 0, ENV);
  assert.equal(r.nack, "overlap"); assert.equal(r.holder.crew, "EV1");
  assert.ok(run(d, B, zone("b1", 1, [4, 5])).doc.locks["zone:b1:1"]);
  assert.ok(run(d, A, zone("a1", 2, [3, 9])).doc.locks["zone:a1:2"]);
  assert.equal(decide(d, { op: zone("a1", 9, [1]) }, B, 0, ENV).nack, "forbidden");
  assert.equal(decide(d, { op: zone("b1", 1, []) }, B, 0, ENV).nack, "invalid");
});

test("equipment locks are exclusive; route locks never conflict and are one per device", () => {
  const eq = { t: "lock.request", target: "equip:drill", kind: "equipment", profiles: ["foot"], reason: "Drilling", sticky: true };
  const d = run(d0(), A, eq).doc;
  assert.equal(decide(d, { op: eq }, B, 0, ENV).nack, "held");
  assert.ok(run(d, A, eq).doc.locks["equip:drill"], "the holder can re-request");
  const rt = (dev) => ({ t: "lock.request", target: `route:${dev}`, kind: "route", cells: [1, 2, 3], profiles: ["foot"], reason: "", sticky: false });
  let r = run(run(d0(), A, rt("a1")).doc, B, rt("b1")).doc;
  assert.ok(r.locks["route:a1"] && r.locks["route:b1"]);
  const f1 = r.locks["route:a1"].fence;
  r = run(r, A, rt("a1")).doc;
  assert.ok(r.locks["route:a1"].fence > f1, "re-request replaces and re-fences");
});

test("fencing: the grant carries seq as its fence; a stale release is ignored; only holder or base release", () => {
  let d = run(d0(), A, zone("a1", 1, [1], { sticky: true })).doc;
  const L = d.locks["zone:a1:1"];
  assert.equal(L.fence, d.seq); assert.equal(L.expiresAt, null);
  const stale = decide(d, { op: { t: "lock.release", target: "zone:a1:1", fence: L.fence - 1 } }, A, 0, ENV);
  assert.deepEqual(stale.ops, []);
  assert.equal(applyOp(d, { t: "lock.release", target: "zone:a1:1", fence: L.fence - 1 }, { seq: 99 }).locks["zone:a1:1"] !== undefined, true);
  assert.equal(decide(d, { op: { t: "lock.release", target: "zone:a1:1", fence: L.fence } }, B, 0, ENV).nack, "forbidden");
  assert.equal(decide(d, { op: { t: "lock.release", target: "zone:a1:1" } }, A, 0, ENV).nack, "invalid");
  assert.equal(run(d, BASE, { t: "lock.release", target: "zone:a1:1", fence: L.fence }).doc.locks["zone:a1:1"], undefined);
  assert.equal(run(d, A, { t: "lock.release", target: "zone:a1:1", fence: L.fence }).doc.locks["zone:a1:1"], undefined);
  assert.deepEqual(decide(d, { op: { t: "lock.release", target: "zone:zz:1", fence: 3 } }, A, 0, ENV).ops, []);
});

test("sweep expires non-sticky locks only; renew extends the lease", () => {
  let d = run(d0(), A, zone("a1", 1, [1], { ttlMs: 500 }), 1000).doc;
  d = run(d, A, zone("a1", 2, [2], { sticky: true }), 1000).doc;
  assert.equal(d.locks["zone:a1:1"].expiresAt, 1500);
  assert.deepEqual(sweep(d, 1499), []);
  d = renew(d, "zone:a1:1", A, 1400);
  assert.equal(d.locks["zone:a1:1"].expiresAt, 1900);
  assert.equal(renew(d, "zone:a1:1", B, 1400), d, "only the holder renews");
  assert.equal(renew(d, "zone:a1:2", A, 1400), d, "sticky has nothing to renew");
  const ops = sweep(d, 2000);
  assert.deepEqual(ops.map((o) => o.target), ["zone:a1:1"]);
  d = applyOp(d, ops[0], { seq: d.seq + 1 });
  assert.equal(d.locks["zone:a1:1"], undefined); assert.ok(d.locks["zone:a1:2"]);
});

test("the lease is clamped (default 30 s, 10 s..300 s) and sim holders carry none", () => {
  const prod = (op, from = A) => decide(d0(), { op }, from, 0, { grid: G }).ops[0].lock;
  assert.equal(prod(zone("a1", 1, [1])).expiresAt, 30000);
  assert.equal(prod(zone("a1", 1, [1], { ttlMs: 1 })).expiresAt, 10000);
  assert.equal(prod(zone("a1", 1, [1], { ttlMs: 9e8 })).expiresAt, 300000);
  assert.equal(prod(zone("sim-X", 1, [1]), { deviceId: "sim-X", crew: "X", role: "crew", sim: true }).expiresAt, null);
});

test("view(): pending ops are applied as provisional and never move seq or confirmed state", () => {
  const confirmed = run(d0(), B, zone("b1", 1, [1, 2], { sticky: true })).doc;
  const pending = [
    { op: { t: "log.append", entry: entry("a1:1") }, by: { deviceId: "a1", crew: "EV1" } },
    { op: zone("a1", 1, [7, 8]), by: { deviceId: "a1", crew: "EV1" } },
    { op: zone("b1", 1, [9]), by: { deviceId: "a1", crew: "EV1" } },
  ];
  const v = view(confirmed, pending);
  assert.equal(v.seq, confirmed.seq);
  assert.equal(v.log["a1:1"].provisional, true);
  assert.equal(v.locks["zone:a1:1"].provisional, true); assert.equal(v.locks["zone:a1:1"].holder.crew, "EV1"); assert.equal(v.locks["zone:a1:1"].fence, null);
  assert.equal(v.locks["zone:b1:1"].provisional, undefined);
  assert.equal(confirmed.log["a1:1"], undefined, "confirmed is untouched");
  assert.equal(view(confirmed, []), confirmed);
  const gone = view(run(confirmed, A, zone("a1", 5, [30], { sticky: true })).doc, [{ op: { t: "lock.release", target: "zone:a1:5" } }]);
  assert.equal(gone.locks["zone:a1:5"], undefined, "a pending release hides the lock at once");
});

test("validateOp rejects out-of-range cells, unknown paths and oversize strings", () => {
  const ok = (op) => assert.equal(validateOp(op, G), null, JSON.stringify(op).slice(0, 80));
  const no = (op) => assert.equal(validateOp(op, G), "invalid", JSON.stringify(op).slice(0, 80));
  ok({ t: "set", path: "settings.goal", v: 99 }); ok({ t: "set", path: "settings.goal", v: null });
  no({ t: "set", path: "settings.goal", v: 100 }); no({ t: "set", path: "settings.goal", v: -1 }); no({ t: "set", path: "settings.goal", v: 1.5 });
  no({ t: "set", path: "settings.secret", v: 1 }); no({ t: "set", path: "locks.x", v: 1 }); no({ t: "set", path: "assets.x", v: { id: "y", kind: "base", name: "n", cell: 1 } });
  ok({ t: "set", path: "settings.weights", v: { energy: 5, risk: 0, comms: 1, radiation: 1, science: 1 } });
  no({ t: "set", path: "settings.weights", v: { energy: 5.1, risk: 0, comms: 1, radiation: 1, science: 1 } });
  no({ t: "set", path: "settings.weights", v: { energy: 1 } });
  ok({ t: "set", path: "clock", v: { mode: "replay", replaySol: 1210, anchorUtcMs: 1, anchorWallMs: 2, rate: 60, paused: false } });
  no({ t: "set", path: "clock", v: { mode: "warp", replaySol: 1210, anchorUtcMs: 1, anchorWallMs: 2, rate: 60, paused: false } });
  no({ t: "set", path: "clock", v: { mode: "live", anchorUtcMs: NaN, anchorWallMs: 2, rate: 1, paused: false } });
  ok({ t: "log.append", entry: entry("a1:1") });
  no({ t: "log.append", entry: entry("a1:1", { cell: 100 }) }); no({ t: "log.append", entry: entry("a1:1", { radius_m: 201 }) });
  no({ t: "log.append", entry: entry("a1:1", { section: "gossip" }) }); no({ t: "log.append", entry: entry("a1:1", { title: "t".repeat(61) }) });
  no({ t: "log.append", entry: entry("a1:1", { note: "n".repeat(501) }) }); no({ t: "log.append", entry: entry("a1:1", { data: { path: [1, 2, 400] } }) });
  no({ t: "log.append", entry: entry("a1:1", { profiles: ["hover"] }) }); no({ t: "log.append", entry: entry("bad id") });
  ok(zone("a1", 1, [1, 2])); no(zone("a1", 1, [1, 2, 100])); no(zone("a1", 1, [1], { reason: "r".repeat(81) })); no(zone("a1", 1, [1], { profiles: [] }));
  no({ ...zone("a1", 1, [1]), poly: Array.from({ length: 65 }, (_, i) => i % 10) });
  no({ t: "lock.request", target: "equip:x", kind: "zone", cells: [1] });
  no({ t: "lock.grant", lock: {} }); no({ t: "lock.expired", target: "zone:a1:1" }); no({ t: "nope" }); no(null); no("x");
  assert.equal(validateOp({ t: "set", path: "settings.goal", v: 1_000_000 }), null, "no grid given: only non-negative integers are checked");
});

test("check() rebuilds ops from known fields: extra keys never reach the document", () => {
  const r = decide(d0(), { op: { t: "log.append", entry: { ...entry("a1:1"), author: { deviceId: "evil" }, status: "resolved", __proto__x: 1, tag: "SIMULATED" } } }, A, 0, ENV);
  const e = r.ops[0].entry;
  assert.equal(e.author.deviceId, "a1"); assert.equal(e.status, "open"); assert.equal(e.tag, "REPORTED"); assert.equal(e.__proto__x, undefined);
});

test("zone cells are capped at 9 000 (one 64 KB frame) and asset ids cannot be prototype keys", () => {
  const cells = (n) => Array.from({ length: n }, (_, i) => i);
  assert.equal(validateOp(zone("a1", 1, cells(9000)), { rows: 200, cols: 200 }), null);
  assert.equal(validateOp(zone("a1", 1, cells(9001)), { rows: 200, cols: 200 }), "invalid");
  const asset = (id) => ({ t: "set", path: `assets.${id}`, v: { id, kind: "supply", name: "n", cell: 1 } });
  assert.equal(validateOp(asset("cache-1"), G), null);
  for (const id of ["__proto__", "constructor", "prototype", "1x", "a:b"]) assert.equal(validateOp(asset(id), G), "invalid", id);
  const d = applyOp(initialDoc(0), { t: "set", path: "assets.__proto__", v: { polluted: 1 } }, { seq: 1 });
  assert.equal(Object.getPrototypeOf(d.assets), Object.prototype); assert.equal(d.assets.polluted, undefined);
});
