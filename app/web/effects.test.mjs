import test from "node:test";
import assert from "node:assert/strict";
import { overlay, entryCells, lockCells, entryFactor, SOL_MS } from "./effects.js";

const rows = 21, cols = 21, cellM = 20, C = 10 * cols + 10;
const G = { rows, cols, cellM, nowUtcMs: 1_000_000_000, me: { deviceId: "A" } };
const ent = (o) => ({ id: "B:1", section: "hazard", severity: 3, cell: C, radius_m: 40, profiles: ["foot", "vehicle", "cargo"], status: "open", utcMs: G.nowUtcMs, author: { deviceId: "B", crew: "EV2" }, data: {}, ...o });
const run = (entries, extra = {}) => overlay({ ...G, entries, locks: [], profile: "foot", ...extra });
const around = (c, r) => [-r, r].flatMap((d) => [c + d, c + d * cols]);

test("sev 3 hazard blocks its circle for the listed profiles only", () => {
  const e = ent({ profiles: ["foot"] });
  const foot = run([e]), veh = run([e], { profile: "vehicle" });
  assert.equal(foot.mult[C], Infinity);
  assert.equal(foot.mult[C + 2], Infinity);
  assert.equal(foot.mult[C + 3], 1);
  assert.equal(foot.blocked, 13);
  assert.equal(veh.mult[C], 1);
  assert.equal(veh.blocked, 0);
});

test("sev 3 fault blocks, sev 2 multiplies by 3, sev 1 does nothing", () => {
  assert.equal(run([ent({ section: "fault" })]).mult[C], Infinity);
  assert.equal(run([ent({ severity: 2 })]).mult[C], 3);
  assert.equal(run([ent({ severity: 1 })]).mult[C], 1);
});

test("a provisional (not yet confirmed) entry still blocks", () => {
  assert.equal(run([ent({ provisional: true })]).mult[C], Infinity);
  assert.equal(run([ent({ status: "confirmed" })]).mult[C], Infinity);
});

test("resolved entries have no effect", () => assert.equal(run([ent({ status: "resolved" })]).blocked, 0));

test("a corrected (superseded) entry stops affecting routing", () => {
  const old = ent({ id: "B:1" }), fix = ent({ id: "B:2", severity: 1, data: { supersedes: "B:1" } });
  assert.equal(run([old]).mult[C], Infinity);
  assert.equal(run([old, fix]).mult[C], 1);
});

test("env_change: sev >= 2 is x2 for one sol, then expires", () => {
  const e = ent({ section: "env_change", severity: 2, utcMs: G.nowUtcMs - SOL_MS + 1000 });
  assert.equal(run([e]).mult[C], 2);
  assert.equal(run([{ ...e, utcMs: G.nowUtcMs - SOL_MS - 1 }]).mult[C], 1);
  assert.equal(run([{ ...e, severity: 3 }]).mult[C], 2);
  assert.equal(run([{ ...e, severity: 1 }]).mult[C], 1);
  assert.equal(entryFactor(e, G.nowUtcMs), 2);
});

test("markers-only sections never change routing", () => {
  for (const section of ["route_deviation", "sample", "equipment", "note"]) assert.equal(run([ent({ section })]).mult[C], 1, section);
});

test("max rule: factors never stack, Infinity wins", () => {
  const route = { target: "route:B", kind: "route", holder: { deviceId: "B", crew: "EV2" }, cells: [C], profiles: ["foot", "vehicle", "cargo"] };
  const both = overlay({ ...G, entries: [ent({ severity: 2 })], locks: [route], profile: "foot" });
  assert.equal(both.mult[C], 4);
  const withBlock = overlay({ ...G, entries: [ent({ severity: 2 }), ent({ id: "B:2", severity: 3, radius_m: 0 })], locks: [route], profile: "foot" });
  assert.equal(withBlock.mult[C], Infinity);
});

test("zone lock of another device blocks, my own lock and unlisted profiles are ignored", () => {
  const zone = { target: "zone:B:1", kind: "zone", holder: { deviceId: "B", crew: "EV2" }, cells: [C, C + 1], profiles: ["foot"] };
  assert.equal(overlay({ ...G, entries: [], locks: [zone], profile: "foot" }).blocked, 2);
  assert.equal(overlay({ ...G, entries: [], locks: [zone], profile: "vehicle" }).blocked, 0);
  assert.equal(overlay({ ...G, entries: [], locks: [{ ...zone, holder: { deviceId: "A" } }], profile: "foot" }).blocked, 0);
});

test("route lock: x4 on the route and a one-cell buffer, equipment locks do nothing", () => {
  const route = { target: "route:B", kind: "route", holder: { deviceId: "B" }, cells: [C, C + 1], profiles: ["foot"] };
  const o = overlay({ ...G, entries: [], locks: [route, { target: "equip:x", kind: "equipment", holder: { deviceId: "B" } }], profile: "foot" });
  assert.equal(o.mult[C], 4);
  assert.equal(o.mult[C - cols - 1], 4);
  assert.equal(o.mult[C + 2], 4);
  assert.equal(o.mult[C + 3], 1);
  assert.equal(o.blocked, 0);
});

test("protect cells (habitat, me) are never Infinity: at most x3", () => {
  const o = run([ent()], { protect: [C, 0, -5, 1e9] });
  assert.equal(o.mult[C], 3);
  assert.equal(o.mult[C + 1], Infinity);
  assert.equal(run([ent({ severity: 2 })], { protect: [C] }).mult[C], 3);
});

test("out-of-range cells and missing fields are ignored, not thrown", () => {
  assert.equal(run([ent({ cell: -1 }), ent({ cell: rows * cols }), null]).blocked, 0);
  const o = overlay({ ...G, entries: [ent({ radius_m: undefined, profiles: undefined })], locks: [{ kind: "zone", holder: {}, cells: [99999, C] }], profile: "foot" });
  assert.ok(o.blocked >= 1);
});

test("radius is capped at 200 m", () => {
  const o = run([ent({ radius_m: 5000 })]);
  assert.equal(o.mult[C + 10], Infinity);
  assert.equal(o.mult[C + 11], 1);
});

test("entryCells / lockCells report only what can change a route", () => {
  run([]);
  assert.equal(entryCells(ent()).length, 13);
  assert.equal(entryCells(ent({ severity: 1 })).length, 0);
  assert.equal(entryCells(ent({ section: "sample" })).length, 0);
  assert.equal(entryCells(ent({ status: "resolved" })).length, 0);
  assert.equal(lockCells({ kind: "zone", cells: [1, 2, -3] }).length, 2);
  assert.equal(lockCells({ kind: "route", cells: [C] }).length, 9);
  assert.equal(lockCells({ kind: "equipment" }).length, 0);
});
