import assert from "node:assert/strict";
import { pandolfWatts, energyGrid, planningGrid, shortestPath, dijkstra, walkbackMask, pathStats, evaTimeline, stateAt, turnaround } from "./pathfind.js";

const cfg = { astronaut_mass_kg: 80, load_kg: 50, walk_speed_ms: 0.8, gravity_ratio: 0.38,
  max_slope_deg: 18, terrain_factor: { bedrock: 1.1, loose_sand: 2.1 } };

assert.ok(pandolfWatts(10, 1.1, cfg) > pandolfWatts(0, 1.1, cfg));
assert.ok(pandolfWatts(0, 2.1, cfg) > pandolfWatts(0, 1.1, cfg));
assert.ok(pandolfWatts(0, 1.1, cfg) < pandolfWatts(0, 1.1, { ...cfg, gravity_ratio: 1 }));

const e = energyGrid({ slope_deg: [0, 30], thermal_inertia: [1, 1] }, 10, cfg);
assert.equal(e[1], Infinity);

const R = 5, C = 5, cost = new Float32Array(R * C).fill(1);
for (let r = 0; r < 4; r++) cost[r * C + 2] = Infinity;
const path = shortestPath(cost, R, C, 0, 4);
assert.ok(path.includes(4 * C + 2), "path uses the gap");
assert.equal(path[0], 0); assert.equal(path.at(-1), 4);

const blocked = new Float32Array(R * C).fill(1);
for (let r = 0; r < R; r++) blocked[r * C + 2] = Infinity;
assert.deepEqual(shortestPath(blocked, R, C, 0, 4), []);

const { dist } = dijkstra(blocked, R, C, 0);
const mask = walkbackMask(dist, 100, 0.2);
assert.equal(mask[0], 1); assert.equal(mask[4], 0);

const st = pathStats([0, 1, 5], new Float32Array(9).fill(10), 3, 20);
assert.ok(Math.abs(st.lengthM - (20 + 20 * Math.SQRT2)) < 1e-9);
assert.ok(Math.abs(st.energyJ - (10 + 10 * Math.SQRT2)) < 1e-9);

assert.deepEqual(shortestPath(new Float32Array(9).fill(1), 3, 3, 0, 99), []);

const sq = new Float32Array(9).fill(1); sq[1] = Infinity; sq[3] = Infinity;
assert.equal(dijkstra(sq, 3, 3, 0).dist[4], Infinity);

assert.equal(pandolfWatts(0, 1.1, { ...cfg, gravity_ratio: 1 }).toFixed(2), "358.84");

const pl = planningGrid(new Float32Array([10, 20, Infinity, 10]),
  { thermal_inertia: [0.5, 0.5, 0.5, 0.5], svf: [1, 1, 1, 1], viewshed: [1, 1, 1, 1], science: [1, 1, 1, 1] },
  { energy: 1, risk: 1, comms: 1, radiation: 1, science: 5 });
assert.ok(pl[0] > 0 && pl[3] > 0 && pl[1] > pl[0] && pl[2] === Infinity);

assert.equal(walkbackMask([80], 100, 0.2)[0], 1);
assert.equal(walkbackMask([81], 100, 0.2)[0], 0);

{
  const c = { walk_speed_ms: 1, eva_energy_budget_j: 1000, eva_duration_h: 100 / 3600, return_margin: 0.2 };
  const route = [0, 1, 2, 3, 4], en = new Float32Array(5).fill(10), tl = evaTimeline(route, en, 5, 10, c);
  assert.equal(tl.tArr, 40); assert.equal(tl.eOut, 40); assert.equal(tl.rate, 10);
  assert.equal(stateAt(0, tl, route).cell, 0);
  assert.equal(stateAt(25, tl, route).cell, 2); assert.ok(Math.abs(stateAt(25, tl, route).spent - 25) < 1e-9);
  assert.equal(stateAt(40, tl, route).cell, 4); assert.equal(stateAt(90, tl, route).cell, 4);
  assert.ok(Math.abs(stateAt(40, tl, route).spent - 40) < 1e-9);
  assert.ok(Math.abs(stateAt(90, tl, route).spent - (40 + 50 * 10)) < 1e-9);
  let prev = -1; for (let s = 0; s <= 100; s += 5) { const sp = stateAt(s, tl, route).spent; assert.ok(sp >= prev); prev = sp; }
  const ta = turnaround(tl, 40, c);
  assert.ok(Math.abs(ta.siteS - 91) < 1e-9 && Math.abs(ta.turnS - 131) < 1e-9);
  assert.equal(walkbackMask([40], 1000 - stateAt(ta.turnS, tl, route).spent, 0.2)[0], 1);
  assert.equal(walkbackMask([40.5], 1000 - stateAt(ta.turnS, tl, route).spent, 0.2)[0], 0);
  assert.ok(turnaround(tl, 800, c).siteS < 0);
}

console.log("pathfind: all checks passed");
