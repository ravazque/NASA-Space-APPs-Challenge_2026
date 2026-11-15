export const DEFAULTS = {
  R_co2: 188.9,
  rad: { gcr_uGy_day: 210, sd: 40, site: "Gale crater (Curiosity RAD), not Jezero", src: "Hassler et al. 2014, doi:10.1126/science.1244797" },
  uv: { S_uv_1AU_Wm2: 110 },
  tau: { aphelion: 0.45, peak: 0.9, peak_ls: 250, width_ls: 45 },
  hazard: { caution: { tau: 1.0, dtau_h: 0.25, wind_ms: 12 }, danger: { tau: 2.0, dtau_h: 0.5, wind_ms: 18 } },
  wind_model: { base_ms: 3, amp_ms: 4 },
  climatology_window_ls: 30,
};
let K = DEFAULTS;
const MARS_HOUR_S = 88775.244 / 24;
const mod = (a, n) => ((a % n) + n) % n;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const dLs = (a, b) => { const d = mod(a - b, 360); return d > 180 ? 360 - d : d; };

export async function loadEnv() {
  const get = async (f) => { const r = await fetch(f); if (!r.ok) throw new Error(`${f}: ${r.status}`); return r.json(); };
  const [meda, consts] = await Promise.all([get("data/env/meda_sols.json"), get("data/env/env_constants.json").catch(() => null)]);
  return makeEnv(meda, consts);
}
export function makeEnv(meda, consts) {
  if (consts) K = { ...DEFAULTS, ...consts };
  const sols = [...meda.sols].sort((a, b) => a.ls - b.ls);
  return { sols, bySol: new Map(sols.map((s) => [s.sol, s])), consts: K, credit: meda.credit };
}

export const density = (p, T) => p / (K.R_co2 * T);
export const tauClim = (ls) => K.tau.aphelion + (K.tau.peak - K.tau.aphelion) * Math.exp(-((dLs(ls, K.tau.peak_ls) / K.tau.width_ls) ** 2));
export function uv(rAU, szaDeg, tau) {
  const mu = Math.cos(szaDeg * Math.PI / 180);
  return szaDeg >= 90 || mu <= 0 ? 0 : K.uv.S_uv_1AU_Wm2 / (rAU * rAU) * mu * Math.exp(-tau / mu);
}
export function hazardLevel({ tau = 0, dtau_h = 0, wind_ms = 0 }) {
  const { danger: d, caution: c } = K.hazard, hit = (lim) => (tau ?? 0) >= lim.tau || (dtau_h ?? 0) >= lim.dtau_h || (wind_ms ?? 0) >= lim.wind_ms;
  return hit(d) ? 2 : hit(c) ? 1 : 0;
}
export function groundTempGrid(tiSi, tRoverC, tMeanC, tiRover) {
  const out = new Float32Array(tiSi.length);
  for (let i = 0; i < tiSi.length; i++) {
    const ti = tiSi[i], f = ti > 0 ? clamp(tiRover / ti, 0.5, 2) : 1;
    out[i] = tMeanC + (tRoverC - tMeanC) * f;
  }
  return out;
}

export function at(series, ltst, maxGap = 3) {
  if (!series) return null;
  const h0 = Math.floor(mod(ltst, 24)), f = mod(ltst, 24) - h0;
  if (series[h0] != null && f === 0) return series[h0];
  let a = null, b = null, da = 0, db = 0;
  for (let k = 0; k < 24 && a == null; k++) if (series[(h0 - k + 24) % 24] != null) { a = series[(h0 - k + 24) % 24]; da = k + f; }
  for (let k = 1; k <= 24 && b == null; k++) if (series[(h0 + k) % 24] != null) { b = series[(h0 + k) % 24]; db = k - f; }
  if (a == null || b == null || da > maxGap || db > maxGap) return null;
  return a + (b - a) * da / (da + db);
}
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const nz = (s) => (s ?? []).filter((x) => x != null);

export function resolveEnv(envData, m, clock, override, utcMs) {
  const sols = envData.sols, replay = clock?.mode === "replay" ? envData.bySol.get(clock.replaySol) : null;
  const near = replay ?? sols.reduce((b, s) => (dLs(s.ls, m.ls) < dLs(b.ls, m.ls) ? s : b), sols[0]);
  const meas = !!replay, kind = meas ? "replay" : "climatology";
  const climNote = meas ? undefined : "clock.note.climatology", args = { sol: near.sol, ls: Math.round(near.ls) };
  const v = (val, unit, tag, src, note, noteArgs) => ({ v: val, unit, tag, src, note, noteArgs });
  const measured = (series, unit, srcKey) => v(at(near[series], m.ltst), unit, meas ? "MEASURED" : "MODEL", near.src?.[srcKey], climNote, args);

  const p = measured("p_pa", "Pa", "der_ps"), tAir = measured("t_air_c", "°C", "cal_ats"), tGround = measured("t_ground_c", "°C", "cal_tirs"), rh = measured("rh_pct", "%", "der_rhs");
  tGround.tMean = mean(nz(near.t_ground_c)); tGround.tMin = Math.min(...nz(near.t_ground_c)); tGround.tMax = Math.max(...nz(near.t_ground_c));

  const ov = override && utcMs >= override.t0Utc ? override : null, fo = ov ? clamp((utcMs - ov.t0Utc) / Math.max(1, ov.t1Utc - ov.t0Utc), 0, 1) : 0;
  const lerp = (r) => (r ? r[0] + (r[1] - r[0]) * fo : null);
  const wm = K.wind_model, hasWind = meas && near.wind_ms && nz(near.wind_ms).length >= 4;
  const windModel = wm.base_ms + wm.amp_ms * Math.max(0, Math.sin(Math.PI * (m.ltst - 9) / 8));
  const wMeas = hasWind ? at(near.wind_ms, m.ltst) : null;
  const modelWind = () => v(windModel, "m/s", "MODEL", "data/env/env_constants.json (wind_model)", hasWind ? "clock.note.windGap" : "clock.note.windModel", { sol: near.sol });
  let wind = wMeas != null ? v(wMeas, "m/s", "MEASURED", near.src?.der_ws) : modelWind();
  const h0 = Math.round(m.ltst), dirH = [0, -1, 1, -2, 2].map((d) => near.wind_dir_deg?.[mod(h0 + d, 24)]).find((x) => x != null) ?? null;
  let windDir = wMeas != null ? v(dirH, "°", "MEASURED", near.src?.der_ws) : v(null, "°", "MODEL", null, "clock.note.windNoDir");

  let tau = v(tauClim(m.ls), "", "MODEL", "data/env/env_constants.json (tau)", "clock.note.tau");
  let dtau_h = 0;
  if (ov && ov.tau) {
    tau = v(lerp(ov.tau), "", "SIMULATED", null, "clock.note.sim", { label: ov.label ?? "" });
    if (fo > 0 && fo < 1) dtau_h = (ov.tau[1] - ov.tau[0]) / (Math.max(1, ov.t1Utc - ov.t0Utc) / 1000 / MARS_HOUR_S);
  }
  if (ov && ov.wind_ms) {
    wind = v(lerp(ov.wind_ms), "m/s", "SIMULATED", null, "clock.note.sim", { label: ov.label ?? "" });
    if (ov.wind_dir_deg != null) windDir = v(ov.wind_dir_deg, "°", "SIMULATED", null, "clock.note.sim", { label: ov.label ?? "" });
  }

  const Tk = tAir.v == null ? null : tAir.v + 273.15;
  const rho = v(p.v != null && Tk ? density(p.v, Tk) : null, "kg/m³", meas ? "DERIVED" : "MODEL", "ρ = p / (R·T), R = " + K.R_co2 + " J/(kg·K)", "clock.note.density");
  const sza = 90 - m.sunEl;
  const uvv = v(uv(m.rAU, sza, tau.v), "W/m²", tau.tag === "SIMULATED" ? "SIMULATED" : "MODEL", "data/env/env_constants.json (uv)", "clock.note.uv");
  const rad = v(K.rad.gcr_uGy_day, "µGy/day", "MODEL", K.rad.src, "clock.note.rad", { gcr: K.rad.gcr_uGy_day, sd: K.rad.sd });

  const others = sols.filter((s) => s !== near && dLs(s.ls, near.ls) <= K.climatology_window_ls);
  const variation = (key, cur) => {
    const ref = mean(others.map((s) => at(s[key], m.ltst)).filter((x) => x != null));
    return v(cur.v != null && ref != null ? cur.v - ref : null, cur.unit, "DERIVED", null, "clock.note.variation", { n: others.length });
  };
  const values = { pressure: p, t_air: tAir, t_ground: tGround, rh, wind, wind_dir: windDir, density: rho, tau, uv: uvv, rad,
    pressure_var: variation("p_pa", p), t_air_var: variation("t_air_c", tAir) };

  const wms = wind.v, level = hazardLevel({ tau: tau.v, dtau_h, wind_ms: wms }), c = K.hazard.caution;
  const reasons = [];
  if (tau.v >= c.tau) reasons.push("tau");
  if (dtau_h >= c.dtau_h) reasons.push("rise");
  if (wms >= c.wind_ms) reasons.push("wind");
  const hazard = { level, tau: tau.v, dtau_h, wind_ms: wms, reasons, cell: ov?.cell ?? null, radius_m: ov?.radius_m ?? null, label: ov?.label ?? null,
    tag: tau.tag === "SIMULATED" || wind.tag === "SIMULATED" ? "SIMULATED" : "MODEL" };
  return { values, hazard, source: { sol: near.sol, ls: near.ls, kind } };
}
