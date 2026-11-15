import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { simPresence, simOps, simStartOps, simFrom, scenarioStartUtc, simStepper } from "./sim.js";
import { initialDoc, applyOp, decide } from "./sync-core.js";
import { energyGrid, planningGrid, shortestPath } from "./pathfind.js";
import { solToUtc } from "./marsclock.js";

const J = (f) => JSON.parse(fs.readFileSync(new URL(f, import.meta.url), "utf8"));
const grid = J("./data/jezero_cost_grid.json"), cfg = J("./data/mission_config.json"), scn = J("./data/scenarios/storm_eva.json"), trav = J("./data/traverse_cells.json");
const { rows, cols, cell_m: cellM } = grid.meta;
const data = { rows, cols, cellM, traverse: trav.map(([r, c]) => r * cols + c) };
const startUtc = scenarioStartUtc(scn), HOUR = 3698.9685;
const tOf = (ltst) => (ltst - scn.start.clock.ltst) * HOUR;
const stepped = (dt, end = tOf(16)) => { const out = []; for (let t = -1; t < end; t += dt) out.push(...simOps(scn, data, t, Math.min(t + dt, end), startUtc)); return out; };

test("determinism: same inputs, same outputs", () => {
  assert.deepEqual(simOps(scn, data, -1, 1e6, startUtc), simOps(scn, data, -1, 1e6, startUtc));
  assert.deepEqual(simPresence(scn, data, 5000), simPresence(scn, data, 5000));
});

test("every event fires exactly once whether the steps are 1 s, 7 s or 300 s", () => {
  const all = simOps(scn, data, -1, 1e9, startUtc);
  assert.equal(all.length, scn.events.length);
  for (const dt of [1, 7, 300, 20000]) assert.deepEqual(stepped(dt), all, `step ${dt}`);
  assert.deepEqual(simOps(scn, data, tOf(11.33), tOf(11.33), startUtc), [], "(t0, t1] excludes both ends when empty");
  assert.equal(simOps(scn, data, tOf(11.33) - 1, tOf(11.33), startUtc).length, 1, "t1 itself is included");
  assert.equal(simOps(scn, data, tOf(11.33), tOf(11.33) + 1, startUtc).length, 0, "t0 itself is excluded");
});

test("event -> op mapping, with the virtual client as `by`", () => {
  const ops = simOps(scn, data, -1, 1e9, startUtc);
  const byT = (t) => ops.filter((o) => o.t === t);
  const fault = byT("log.append")[0];
  assert.equal(fault.by.deviceId, "sim-EV2"); assert.equal(fault.entry.section, "fault"); assert.equal(fault.entry.severity, 3);
  assert.equal(fault.entry.id, "sim-EV2:e0"); assert.equal(fault.entry.cell, 81 * cols + 183);
  assert.equal(Math.round((fault.entry.utcMs - startUtc) / 1000), Math.round(tOf(11.33)));
  assert.equal(byT("lock.request")[0].by.crew, "ROVER-1"); assert.equal(byT("lock.request")[0].sticky, true);
  const w = byT("set").filter((o) => o.path === "env.override");
  assert.equal(w.length, 3);
  const storm = w.find((o) => o.v.label === "Regional dust storm").v;
  assert.deepEqual(storm.tau, [0.6, 3.0]); assert.equal(storm.wind_dir_deg, 250);
  assert.equal(storm.t1Utc - storm.t0Utc, 1.5 * (88775.244 / 24) * 1000, "the ramp lasts over_h Mars hours");
  assert.equal(storm.t0Utc, startUtc + tOf(12.5) * 1000);
  const res = byT("log.status")[0];
  assert.deepEqual([res.ref, res.status, res.by.deviceId], ["sim-EV2:e0", "resolved", "sim-EV2"]);
  const rel = byT("lock.release")[0];
  assert.deepEqual([rel.target, rel.by.deviceId], ["equip:drill", "sim-ROVER"]);
});

test("the whole drill runs through the real decide/applyOp path: SIMULATED log, drill held then released, report resolved", () => {
  const ENV = { grid: { rows, cols } };
  let doc = initialDoc(0), seq = 0;
  const feed = (op) => { const r = decide(doc, { op }, simFrom(op), 0, ENV); assert.ok(!r.nack, `${op.t} refused: ${r.nack}`); for (const o of r.ops) doc = applyOp(doc, o, { seq: ++seq, by: op.by }); };
  for (const op of simStartOps(scn, data, 12345)) feed(op);
  assert.equal(doc.scenario.running, true); assert.equal(doc.scenario.startUtcMs, startUtc); assert.equal(doc.clock.anchorWallMs, 12345);
  assert.equal(doc.assets.drill.cell, 150 * cols + 331); assert.equal(doc.assets.supply1.kind, "supply");
  const ops = simOps(scn, data, -1, 1e9, startUtc);
  for (const op of ops.slice(0, 2)) feed(op);
  assert.equal(doc.log["sim-EV2:e0"].tag, "SIMULATED"); assert.equal(doc.locks["equip:drill"].holder.crew, "ROVER-1");
  for (const op of ops.slice(2)) feed(op);
  assert.equal(doc.log["sim-EV2:e0"].status, "resolved"); assert.equal(doc.locks["equip:drill"], undefined);
  assert.equal(doc.env.override.label, "Storm subsiding");
});

test("actors move, never leave the grid, never jump, and loop or stop at the end", () => {
  let prev = null;
  for (let t = -100; t <= 20000; t += 50) {
    const ps = simPresence(scn, data, t);
    assert.equal(ps.length, 2);
    for (const p of ps) {
      assert.ok(Number.isInteger(p.cell) && p.cell >= 0 && p.cell < rows * cols, `${p.deviceId} cell at ${t}`);
      assert.equal(p.sim, true); assert.equal(p.online, true);
    }
    if (prev && t > 0) for (const [i, p] of ps.entries()) {
      const dr = Math.abs(((p.cell / cols) | 0) - ((prev[i].cell / cols) | 0)), dc = Math.abs((p.cell % cols) - (prev[i].cell % cols));
      assert.ok(Math.max(dr, dc) <= 8, `${p.deviceId} jumped at ${t}`);
    }
    prev = ps;
  }
  const [ev2a, rovA] = simPresence(scn, data, 0), [ev2b, rovB] = simPresence(scn, data, 1500);
  assert.notEqual(ev2a.cell, ev2b.cell); assert.notEqual(rovA.cell, rovB.cell);
  assert.equal(simPresence(scn, data, 1e7)[0].cell, data.traverse[700], "EV2 stops at the end of its traverse segment");
  assert.equal(simPresence(scn, data, -50)[0].cell, data.traverse[100], "before the start: at the start");
});

test("the fault lies on the default foot route (Three Forks -> Cheyava Falls), 40-60 % along it, and away from the habitat", () => {
  const layers = Object.fromEntries(Object.entries(grid.layers).map(([n, v]) => [n, Float32Array.from(v)]));
  const e = energyGrid(layers, cellM, cfg), pg = planningGrid(e, layers, { energy: 1, risk: 1, comms: 0.5, radiation: 0.5, science: 1 });
  const hab = grid.meta.sites.three_forks.cell, goal = grid.meta.sites.cheyava_falls.cell;
  const route = shortestPath(pg, rows, cols, hab[0] * cols + hab[1], goal[0] * cols + goal[1]);
  assert.ok(route.length > 100);
  const fault = simOps(scn, data, -1, 1e9, startUtc).find((o) => o.entry?.section === "fault").entry, at = route.indexOf(fault.cell);
  assert.ok(at >= 0, "fault cell is a route cell");
  assert.ok(at / route.length >= 0.4 && at / route.length <= 0.6, `position ${(at / route.length).toFixed(2)}`);
  for (const a of scn.assets) assert.ok(e[a.cell[0] * cols + a.cell[1]] !== Infinity, `${a.id} on walkable ground`);
});

test("the scenario starts at LTST 11:00 of sol 1210; the default clock is Live (real UTC)", () => {
  assert.ok(Math.abs(startUtc - solToUtc(1210, 11)) < 60000);
  const ck = initialDoc(5).clock;
  assert.equal(ck.mode, "live"); assert.equal(ck.anchorUtcMs, 5); assert.equal(ck.rate, 1);
});

test("simStepper fires only on a replay/scenario clock and never on a jump, a rewind or Live mode; no event re-fires after a rewind", () => {
  const rp = { mode: "replay", rate: 60 }, step = simStepper(-1), end = tOf(16);
  const fired = (span) => (span ? simOps(scn, data, span[0], span[1], startUtc).length : 0);
  let n = 0;
  for (let t = 0; t <= end; t += 5) n += fired(step(rp, t));
  assert.equal(n, scn.events.length);
  assert.equal(step(rp, 0), null, "rewind");
  for (let t = 0; t <= end; t += 5) n += fired(step(rp, t));
  assert.equal(n, scn.events.length, "after a rewind the events are not fired again");
  const s2 = simStepper(-1);
  assert.equal(s2({ mode: "live", rate: 1 }, 1e8), null, "Live mode");
  assert.equal(s2(rp, 0), null, "back from Live: the jump fires nothing");
  assert.notEqual(s2(rp, 5), null, "then normal ticks resume");
  assert.equal(simStepper(0)(rp, 5000), null, "a jump forward of 5000 s at x60 skips instead of firing everything");
  assert.notEqual(simStepper(0)({ mode: "scenario", rate: 3600 }, 3600), null, "x3600: one tick of 3600 s is normal");
});
