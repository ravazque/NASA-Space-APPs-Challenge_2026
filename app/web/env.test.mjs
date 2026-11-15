import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mars, solToUtc } from "./marsclock.js";
import { makeEnv, resolveEnv, density, uv, tauClim, hazardLevel, groundTempGrid, at, DEFAULTS } from "./env.js";

const read = (f) => JSON.parse(readFileSync(new URL(`./data/${f}`, import.meta.url), "utf8"));
const meda = read("env/meda_sols.json"), consts = read("env/env_constants.json");
const envData = makeEnv(meda, consts);
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);
const replay = (sol, ltst) => { const utc = solToUtc(sol, ltst); return resolveEnv(envData, mars(utc), { mode: "replay", replaySol: sol }, null, utc); };

test("env_constants.json and the built-in defaults agree (numbers do not drift)", () => {
  const num = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === "string" ? undefined : v)));
  for (const k of ["R_co2", "rad", "uv", "tau", "hazard", "wind_model", "climatology_window_ls"]) assert.deepEqual(num(consts[k]), num(DEFAULTS[k]), k);
});

test("data file: ~14 sols spread over Ls, wind sols 200 and 313, sane physical ranges, provenance", () => {
  assert.ok(meda.sols.length >= 12);
  assert.ok(meda.sols.some((s) => s.sol === 1210) && meda.sols.some((s) => s.wind_ms));
  const lss = meda.sols.map((s) => s.ls).sort((a, b) => a - b);
  for (let i = 1; i < lss.length; i++) assert.ok(lss[i] - lss[i - 1] < 50, "Ls gap");
  assert.ok(360 - lss.at(-1) + lss[0] < 50);
  for (const s of meda.sols) {
    assert.ok(s.src.der_ps.startsWith("https://atmos.nmsu.edu/"), `src ${s.sol}`);
    for (const [k, lo, hi] of [["p_pa", 400, 1100], ["t_air_c", -110, 30], ["t_ground_c", -130, 60]]) {
      const v = s[k].filter((x) => x != null);
      assert.ok(v.length >= 20 && v.every((x) => x > lo && x < hi), `${s.sol} ${k}`);
    }
  }
  assert.ok(JSON.stringify(meda).length < 80_000);
});

test("density(750 Pa, 230 K) = 0.017263", () => near(density(750, 230), 0.017263, 1e-5, "rho"));

test("UV falls with tau and is 0 at night", () => {
  assert.ok(uv(1.5, 30, 0.5) > uv(1.5, 30, 2));
  assert.ok(uv(1.5, 30, 0.5) > uv(1.5, 70, 0.5));
  assert.equal(uv(1.5, 90, 0.5), 0); assert.equal(uv(1.5, 120, 0.5), 0);
  assert.ok(uv(1.4, 20, 0.45) > uv(1.65, 20, 0.45));
});

test("tauClim peaks at Ls 250, is lowest around aphelion, wraps at 360", () => {
  let best = 0; for (let l = 0; l < 360; l++) if (tauClim(l) > tauClim(best)) best = l;
  assert.equal(best, 250);
  near(tauClim(250), 0.9, 1e-9, "peak"); assert.ok(tauClim(70) < 0.5);
  near(tauClim(0), tauClim(360), 1e-12, "wrap");
});

test("hazardLevel boundaries (ARIADNE thresholds, not NASA rules)", () => {
  assert.equal(hazardLevel({ tau: 0.99, dtau_h: 0.24, wind_ms: 11.9 }), 0);
  assert.equal(hazardLevel({ tau: 1.0, dtau_h: 0, wind_ms: 0 }), 1);
  assert.equal(hazardLevel({ tau: 0, dtau_h: 0.25, wind_ms: 0 }), 1);
  assert.equal(hazardLevel({ tau: 0, dtau_h: 0, wind_ms: 12 }), 1);
  assert.equal(hazardLevel({ tau: 2.0, dtau_h: 0, wind_ms: 0 }), 2);
  assert.equal(hazardLevel({ tau: 0, dtau_h: 0.5, wind_ms: 0 }), 2);
  assert.equal(hazardLevel({ tau: 0, dtau_h: 0, wind_ms: 18 }), 2);
  assert.equal(hazardLevel({ tau: 0.5, wind_ms: null }), 0);
});

test("replay sol 1210 at 13:00 equals the measured hourly value, tagged MEASURED", () => {
  const s = meda.sols.find((x) => x.sol === 1210), r = replay(1210, 13);
  near(r.values.t_air.v, s.t_air_c[13], 0.01, "t_air"); near(r.values.pressure.v, s.p_pa[13], 0.01, "p"); near(r.values.t_ground.v, s.t_ground_c[13], 0.01, "t_ground");
  for (const k of ["t_air", "pressure", "t_ground"]) assert.equal(r.values[k].tag, "MEASURED", k);
  assert.equal(r.values.density.tag, "DERIVED");
  near(r.values.density.v, r.values.pressure.v / (consts.R_co2 * (r.values.t_air.v + 273.15)), 1e-9, "rho");
  assert.equal(r.source.kind, "replay"); assert.equal(r.source.sol, 1210);
  const mid = replay(1210, 13.5).values.t_air.v;
  near(mid, (s.t_air_c[13] + s.t_air_c[14]) / 2, 0.05, "interp");
});

test("model values are never tagged MEASURED; no measured wind on sol 1210 -> MODEL; wind sol 200 -> MEASURED", () => {
  const r = replay(1210, 13);
  for (const k of ["tau", "uv", "rad", "wind"]) assert.notEqual(r.values[k].tag, "MEASURED", k);
  assert.equal(r.values.wind.tag, "MODEL"); assert.equal(r.values.wind_dir.v, null);
  const w = replay(200, 12);
  assert.equal(w.values.wind.tag, "MEASURED"); assert.ok(w.values.wind.v > 0 && w.values.wind.v < 40);
  assert.ok(w.values.wind_dir.v >= 0 && w.values.wind_dir.v < 360);
  for (const x of meda.sols) for (const v of [...(x.wind_ms ?? []), ...x.rh_pct]) assert.ok(v == null || (v >= 0 && v <= 100), `fill value leaked: sol ${x.sol} ${v}`);
});

test("live and scenario use climatology from the nearest season: MODEL with the sol in the note", () => {
  const utc = Date.UTC(2026, 10, 14, 12), m = mars(utc);
  for (const mode of ["live", "scenario"]) {
    const r = resolveEnv(envData, m, { mode }, null, utc);
    assert.equal(r.source.kind, "climatology");
    for (const k of ["t_air", "pressure", "t_ground", "density"]) assert.equal(r.values[k].tag, "MODEL", `${mode} ${k}`);
    assert.equal(r.values.t_air.note, "clock.note.climatology"); assert.ok(r.values.t_air.noteArgs.sol > 0);
    assert.ok(Math.abs(r.source.ls - m.ls) <= 16, "nearest by Ls");
  }
});

test("override: SIMULATED tau/wind, ramp interpolated by clock UTC, hazard level and tag", () => {
  const t0 = Date.UTC(2026, 0, 1), t1 = t0 + 2 * 3600e3, ov = { tau: [0.6, 3.0], wind_ms: [5, 20], wind_dir_deg: 270, t0Utc: t0, t1Utc: t1, cell: 99, radius_m: 800, label: "drill" };
  const at_ = (utc) => resolveEnv(envData, mars(utc), { mode: "scenario" }, ov, utc);
  const before = at_(t0 - 1000), mid = at_((t0 + t1) / 2), after = at_(t1 + 1000);
  assert.equal(before.values.tau.tag, "MODEL"); assert.equal(before.hazard.level, 0);
  assert.equal(mid.values.tau.tag, "SIMULATED"); near(mid.values.tau.v, 1.8, 1e-9, "tau mid"); near(mid.values.wind.v, 12.5, 1e-9, "wind mid");
  assert.equal(mid.values.wind_dir.v, 270); assert.equal(mid.hazard.tag, "SIMULATED"); assert.equal(mid.hazard.level, 2);
  assert.ok(mid.hazard.dtau_h > 1.1 && mid.hazard.dtau_h < 1.3 && mid.hazard.reasons.includes("rise"));
  assert.equal(mid.hazard.cell, 99); assert.equal(mid.hazard.radius_m, 800);
  near(after.values.tau.v, 3.0, 1e-9, "tau after"); assert.equal(after.hazard.dtau_h, 0); assert.equal(after.hazard.level, 2);
  assert.equal(after.values.uv.tag, "SIMULATED");
});

test("no false hazard anywhere in the measured seasons (all sols, every hour)", () => {
  for (const s of meda.sols) for (let h = 0; h < 24; h += 2) assert.equal(replay(s.sol, h).hazard.level, 0, `sol ${s.sol} ${h}h`);
});

test("variation compares with the other sols within 30 deg of Ls (DERIVED)", () => {
  const r = replay(1210, 12);
  assert.equal(r.values.t_air_var.tag, "DERIVED"); assert.ok(r.values.t_air_var.noteArgs.n >= 1);
  assert.ok(Math.abs(r.values.t_air_var.v) < 40);
});

test("interpolation skips nulls, wraps the day, and refuses wide gaps", () => {
  const s = Array(24).fill(null); s[0] = 10; s[2] = 20; s[22] = 0;
  near(at(s, 1), 15, 1e-9, "linear"); near(at(s, 23.5, 3), 7.5, 1e-9, "wrap 22..0");
  assert.equal(at(s, 12), null); assert.equal(at([null, null], 3), null); assert.equal(at(null, 3), null);
});

test("groundTempGrid: low inertia swings further from the mean, clamped to 0.5..2", () => {
  const g = groundTempGrid(Float32Array.from([100, 200, 400, 0]), 10, -50, 200);
  near(g[1], 10, 1e-4, "same inertia"); near(g[0], -50 + 60 * 2, 1e-4, "clamped x2"); near(g[2], -50 + 60 * 0.5, 1e-4, "x0.5"); near(g[3], 10, 1e-4, "no data");
});

test("a gap in a measured wind sol (sol 313, hour 18): model fallback tagged MODEL, never MEASURED with no value", () => {
  const v = replay(313, 18).values;
  assert.equal(v.wind.tag, "MODEL"); assert.equal(v.wind.note, "clock.note.windGap"); assert.equal(v.wind_dir.v, null);
  assert.equal(replay(313, 11).values.wind.tag, "MEASURED");
  assert.ok(replay(313, 10.6).values.wind_dir.v != null, "direction from the nearest hour with one");
});
