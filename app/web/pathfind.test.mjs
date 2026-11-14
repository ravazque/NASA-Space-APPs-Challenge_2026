import assert from "node:assert/strict";
import { pandolfWatts, energyGrid, shortestPath, dijkstra, walkbackMask, pathStats } from "./pathfind.js";

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

console.log("pathfind: all checks passed");
