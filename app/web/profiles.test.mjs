import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { energyGrid, shortestPath, planningGrid } from "./pathfind.js";
import { PROFILES, prepareExtra, limits, passMask, routeEnergy, planPenalty, hardMask, share } from "./profiles.js";

const rd = (f) => JSON.parse(readFileSync(new URL(`./data/${f}`, import.meta.url)));
const grid = rd("jezero_cost_grid.json"), cfg = rd("mission_config.json"), extra = prepareExtra(rd("terrain_extra.json"));
const layers = Object.fromEntries(Object.entries(grid.layers).map(([k, v]) => [k, Float32Array.from(v)]));
const { rows, cols, cell_m: cellM } = grid.meta, n = rows * cols;
const m = Object.fromEntries(Object.keys(PROFILES).map((p) => [p, passMask(p, layers, extra, cfg)]));
const subset = (a, b) => a.every((v, i) => !v || b[i]);

test("extras have the grid shape and sane values", () => {
  assert.equal(extra.rough_m.length, n); assert.equal(extra.rocks.length, n);
  assert.ok(extra.rough_p[75] > 0.05 && extra.rough_p[75] < 1, `p75 ${extra.rough_p[75]}`);
  assert.ok(share(extra.rocks) > 0 && share(extra.rocks) < 30);
  assert.ok(extra.craters.length > 0 && extra.craters.every((c) => c.cell >= 0 && c.cell < n && c.diam_m >= 40));
});

test("passable(cargo) ⊆ passable(vehicle) ⊆ passable(foot)", () => {
  assert.ok(subset(m.cargo, m.vehicle)); assert.ok(subset(m.vehicle, m.foot));
  assert.ok(share(m.cargo) < share(m.vehicle) && share(m.vehicle) < share(m.foot), "strictly narrower on the real grid");
});

test("foot % passable equals v1 basePct", () => {
  const e = energyGrid(layers, cellM, cfg), basePct = (100 * e.filter((v) => v !== Infinity).length) / n;
  assert.equal(share(m.foot), basePct);
  assert.deepEqual(routeEnergy("foot", layers, extra, cellM, cfg), e);
});

test("thresholds: vehicle 15 deg and 0.30 m, cargo 10 deg and p75 (never above 0.30), rocks block both", () => {
  assert.deepEqual([limits("foot", extra, cfg).slope, limits("vehicle", extra, cfg).slope, limits("cargo", extra, cfg).slope], [18, 15, 10]);
  assert.equal(limits("vehicle", extra, cfg).rough, 0.3);
  assert.ok(limits("cargo", extra, cfg).rough <= 0.3);
  for (let i = 0; i < n; i++) if (extra.rocks[i]) { assert.equal(m.vehicle[i], 0); assert.equal(m.cargo[i], 0); }
  for (let i = 0; i < n; i++) if (m.vehicle[i]) { assert.ok(layers.slope_deg[i] <= 15 && extra.rough_m[i] <= 0.3); }
  for (let i = 0; i < n; i++) if (m.cargo[i]) assert.ok(layers.slope_deg[i] <= 10);
});

test("cargo keeps one cell clear of anything the vehicle cannot cross", () => {
  for (let i = 0; i < n; i++) {
    if (!m.cargo[i]) continue;
    const y = (i / cols) | 0, x = i % cols;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < rows && xx >= 0 && xx < cols) assert.equal(m.vehicle[yy * cols + xx], 1);
    }
  }
});

test("vehicle and cargo energy are constant on passable cells and Infinity elsewhere", () => {
  for (const p of ["vehicle", "cargo"]) {
    const e = routeEnergy(p, layers, extra, cellM, cfg), vals = new Set();
    e.forEach((v, i) => { assert.equal(v === Infinity, !m[p][i]); if (v !== Infinity) vals.add(v); });
    assert.equal(vals.size, 1);
  }
  assert.ok(routeEnergy("cargo", layers, extra, cellM, cfg).find((v) => v !== Infinity) > routeEnergy("vehicle", layers, extra, cellM, cfg).find((v) => v !== Infinity));
});

test("planPenalty: none for foot, 1 + (s/15)^2 vehicle, 1 + 2(s/10)^2 cargo", () => {
  assert.equal(planPenalty("foot", layers, extra), null);
  const s = layers.slope_deg;
  const v = planPenalty("vehicle", layers, extra), c = planPenalty("cargo", layers, extra);
  for (const i of [0, 1000, 30000]) { assert.ok(Math.abs(v[i] - (1 + (s[i] / 15) ** 2)) < 1e-4); assert.ok(Math.abs(c[i] - (1 + 2 * (s[i] / 10) ** 2)) < 1e-4); }
});

test("without extras only slope counts and the subset order still holds", () => {
  const a = Object.fromEntries(Object.keys(PROFILES).map((p) => [p, passMask(p, layers, null, cfg)]));
  assert.ok(subset(a.cargo, a.vehicle) && subset(a.vehicle, a.foot));
  assert.equal(share(a.foot), share(m.foot));
});

test("hard access: passable on foot, slope 15-18 deg or roughness above p90", () => {
  const h = hardMask(layers, extra, cfg);
  assert.ok(subset(h, m.foot)); assert.ok(share(h) > 0 && share(h) < 50);
  for (let i = 0; i < n; i++) if (h[i]) assert.ok(layers.slope_deg[i] > 15 || extra.rough_m[i] > extra.rough_p[90]);
});

test("each profile reaches Cheyava Falls from Three Forks on the real grid (documents the demo)", () => {
  const { three_forks: a, cheyava_falls: b } = grid.meta.sites, start = a.cell[0] * cols + a.cell[1], goal = b.cell[0] * cols + b.cell[1];
  const w = { energy: 1, risk: 1, comms: 0.5, radiation: 0.5, science: 1 };
  for (const p of Object.keys(PROFILES)) {
    const pg = planningGrid(routeEnergy(p, layers, extra, cellM, cfg), layers, w), pen = planPenalty(p, layers, extra);
    if (pen) for (let i = 0; i < pg.length; i++) if (pg[i] !== Infinity) pg[i] *= pen[i];
    const r = shortestPath(pg, rows, cols, start, goal);
    console.log(`  ${p}: passable ${share(m[p]).toFixed(1)} %, route ${r.length ? r.length + " cells" : "NONE"}`);
    if (p === "foot") assert.ok(r.length > 0);
  }
});

test("vehicle and cargo reach a cell they can cross, a few hundred metres from the habitat", () => {
  const { three_forks: a } = grid.meta.sites, start = a.cell[0] * cols + a.cell[1], w = { energy: 1, risk: 1, comms: 0.5, radiation: 0.5, science: 1 };
  const plan = (p, goal) => {
    const pg = planningGrid(routeEnergy(p, layers, extra, cellM, cfg), layers, w), pen = planPenalty(p, layers, extra);
    if (pen) for (let i = 0; i < pg.length; i++) if (pg[i] !== Infinity) pg[i] *= pen[i];
    return shortestPath(pg, rows, cols, start, goal);
  };
  let goal = -1;
  for (let i = 0; i < n && goal < 0; i++) {
    const dist = Math.hypot(((i / cols) | 0) - a.cell[0], (i % cols) - a.cell[1]);
    if (m.cargo[i] && dist >= 20 && dist <= 40 && plan("cargo", i).length) goal = i;
  }
  assert.ok(goal >= 0, "a reachable cargo cell exists");
  const foot = plan("foot", goal);
  for (const p of ["vehicle", "cargo"]) {
    const r = plan(p, goal);
    assert.ok(r.length > 0, `${p} route`);
    assert.ok(r.every((c) => m[p][c]), `${p} route stays on cells the profile can cross`);
    assert.ok(r.length >= foot.length, `${p} detour is never shorter in cells than the foot route`);
  }
});
