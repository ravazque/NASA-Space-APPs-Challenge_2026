import test from "node:test";
import assert from "node:assert/strict";
import { register, DICT } from "./i18n.js";
import dict from "./i18n/layers.js";
import { readFileSync } from "node:fs";
import { CATALOGUE, CATS, BY, hillshade, rampRGBA, reliefRGBA, rangeOf, readout } from "./layers.js";
import { makeEnv, resolveEnv } from "./env.js";
import { mars, solToUtc } from "./marsclock.js";

register(dict);

test("catalogue: 6 categories in order, unique ids, valid kinds and tags", () => {
  assert.deepEqual(CATS, ["nav", "topo", "geo", "met", "atm", "rad"]);
  assert.equal(new Set(CATALOGUE.map((c) => c.id)).size, CATALOGUE.length);
  for (const c of CATALOGUE) {
    assert.ok(CATS.includes(c.cat), c.id); assert.ok(["raster", "vector", "readout"].includes(c.kind), c.id);
    assert.ok(/^(?:(?:MEASURED|DERIVED|MODEL|SIMULATED|REPORTED)|[ →+/])+$/.test(c.tag), `${c.id}: tag "${c.tag}"`);
    if (c.kind === "raster" && c.id !== "comms" && c.id !== "relief" && c.id !== "ground_temp" && c.id !== "roughness") assert.ok(c.grid, `${c.id} needs a grid key`);
  }
  for (const cat of CATS) assert.ok(CATALOGUE.some((c) => c.cat === cat), `${cat} has layers`);
});

test("every layer has an EN and ES name, caption and source; categories and profiles are translated", () => {
  const keys = [...CATALOGUE.flatMap((c) => ["name", "cap", "src"].map((k) => `layers.${k}.${c.id}`)), ...CATS.map((c) => `layers.cat.${c}`),
    ...["foot", "vehicle", "cargo"].flatMap((p) => [`layers.profile.${p}`, `layers.prof.${p}`, `layers.leg.forbid.${p}`]), ...["slope", "rough", "rocks", "buffer", "overlay"].map((r) => `layers.forbid.${r}`)];
  for (const l of ["en", "es"]) for (const k of keys) assert.ok(DICT[l][k]?.trim(), `${l}.${k}`);
});

test("proxy layers say they are proxies", () => {
  assert.match(DICT.en["layers.cap.rocks"], /Proxy.*1\.5 m/); assert.match(DICT.en["layers.cap.craters"], /Robbins/);
  assert.match(DICT.en["layers.cap.ambient_rad"], /Gale/); assert.match(DICT.en["layers.cap.minerals"], /maximum/);
});

test("map ids: layers module draws only its own ids", () => {
  for (const c of CATALOGUE) for (const m of c.map ?? []) assert.ok(/^(plan|layers|hub|log|clock):/.test(m), `${c.id}: ${m}`);
  assert.deepEqual(BY.passage.map, ["plan:forbid", "plan:forbid.edge"]);
});

test("hillshade: flat ground = sin(sun elevation); a slope facing the Sun is brighter than one facing away", () => {
  const n = 9, flat = new Float32Array(n * n);
  assert.ok(Math.abs(hillshade(flat, n, n, 20, 30, 180)[40] - 0.5) < 1e-6);
  const ramp = Float32Array.from({ length: n * n }, (_, i) => (i % n) * 5);
  const sunE = hillshade(ramp, n, n, 20, 30, 90)[40], sunW = hillshade(ramp, n, n, 20, 30, 270)[40];
  assert.ok(sunW > sunE, "east-rising slope faces west: lit from the west");
});

test("rampRGBA: five ink steps, NaN transparent, wash keeps the lowest step visible", () => {
  const out = rampRGBA(Float32Array.from([0, 5, 10, NaN]), 0, 10, [26, 26, 26], [242, 241, 236], 0.5), alpha = (i) => out[i * 4 + 3];
  assert.ok(Math.abs(alpha(0) - 127.5) <= 1, "lowest step = the wash alone");
  assert.ok(alpha(1) > alpha(0) && alpha(2) > alpha(1), "alpha grows with the value");
  assert.equal(alpha(3), 0);
  assert.deepEqual(rangeOf([3, NaN, 1, 2]), [1, 3]);
  const r = reliefRGBA(Float32Array.from([0.2, 0.5, 0.9]), 0.5, [26, 26, 26], [242, 241, 236]);
  assert.ok(r[3] > 0 && r[7] === 0 && r[11] > 0, "shadow and light show, flat terrain stays clear");
});

const hours = (f) => Array.from({ length: 24 }, (_, h) => f(h));
const sol = (n, ls, k) => ({ sol: n, ls, p_pa: hours((h) => 700 + k + h), t_air_c: hours((h) => -60 + h * 2 + k), t_ground_c: hours((h) => -80 + h * 3 + k), rh_pct: hours(() => 20 + k),
  wind_ms: hours((h) => 3 + (h % 5)), wind_dir_deg: hours((h) => 10 * h), src: { der_ps: "x", cal_ats: "x", cal_tirs: "x", der_rhs: "x", der_ws: "x" } });
const envData = makeEnv({ sols: [sol(200, 100, 0), sol(313, 120, 5)], credit: "" }, null);
const resolve = (utcMs, replaySol) => resolveEnv(envData, mars(utcMs), { mode: "replay", replaySol }, null, utcMs);

test("every readout row resolves to a value on real resolveEnv output; ground raster inputs exist", () => {
  const { values } = resolve(solToUtc(200, 13), 200);
  const rows = CATALOGUE.filter((c) => c.kind === "readout" || c.id === "ground_temp").filter((c) => !["protection", "dust_storm"].includes(c.id));
  assert.ok(rows.length >= 9);
  for (const c of rows) assert.notEqual(readout(c.id, values).txt, "—", `${c.id} stays at a dash`);
  assert.match(readout("variation", values).txt, /Pa .* °C/);
  assert.match(readout("wind", values).txt, /m\/s · \d+°/, "wind direction is shown");
  assert.ok(Number.isFinite(values.t_ground.tMean) && values.t_ground.tMin < values.t_ground.tMean && values.t_ground.tMax > values.t_ground.tMean);
});

test("map ids: every id the plan, log, hub and clock modules draw belongs to some catalogue row", () => {
  const listed = new Set(CATALOGUE.flatMap((c) => c.map ?? [])), always = new Set(["plan:sites", "plan:spe", "log:new"]);
  for (const f of ["map.js", "plan.js", "log.js", "clockui.js", "hubui.js"]) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    for (const [, id] of src.matchAll(/["'`]((?:plan|log|hub|clock):[A-Za-z0-9_.-]+)["'`]/g)) assert.ok(listed.has(id) || always.has(id), `${f} draws ${id}, no catalogue row shows or hides it`);
  }
});
