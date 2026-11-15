export const DEFAULTS = {
  R_co2: 188.9,
  rad: {
    gcr_uGy_day: 210,
    sd: 40,
    site: "Gale crater (Curiosity RAD), not Jezero",
    src: "Hassler et al. 2014, doi:10.1126/science.1244797",
  },
  uv: { S_uv_1AU_Wm2: 110 },
  tau: { aphelion: 0.45, peak: 0.9, peak_ls: 250, width_ls: 45 },
  hazard: {
    caution: { tau: 1.0, dtau_h: 0.25, wind_ms: 12 },
    danger: { tau: 2.0, dtau_h: 0.5, wind_ms: 18 },
  },
  wind_model: { base_ms: 3, amp_ms: 4 },
  climatology_window_ls: 30,
};
let constants = DEFAULTS;
const MARS_HOUR_S = 88775.244 / 24;

function mod(a, n) {
  return ((a % n) + n) % n;
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function lsDistance(a, b) {
  const diff = mod(a - b, 360);
  return diff > 180 ? 360 - diff : diff;
}

async function fetchJson(file) {
  const res = await fetch(file);
  if (!res.ok) throw new Error(`${file}: ${res.status}`);
  return res.json();
}

export async function loadEnv() {
  const [meda, consts] = await Promise.all([
    fetchJson("data/env/meda_sols.json"),
    fetchJson("data/env/env_constants.json").catch(() => null),
  ]);
  return makeEnv(meda, consts);
}

export function makeEnv(meda, consts) {
  if (consts) constants = { ...DEFAULTS, ...consts };
  const sols = [...meda.sols].sort((a, b) => a.ls - b.ls);
  const bySol = new Map(sols.map((s) => [s.sol, s]));
  return { sols, bySol, consts: constants, credit: meda.credit };
}

export const density = (p, T) => p / (constants.R_co2 * T);

export function tauClim(ls) {
  const { aphelion, peak, peak_ls, width_ls } = constants.tau;
  return aphelion + (peak - aphelion) * Math.exp(-((lsDistance(ls, peak_ls) / width_ls) ** 2));
}

export function uv(rAU, szaDeg, tau) {
  const mu = Math.cos(szaDeg * Math.PI / 180);
  if (szaDeg >= 90 || mu <= 0) return 0;
  return constants.uv.S_uv_1AU_Wm2 / (rAU * rAU) * mu * Math.exp(-tau / mu);
}

export function hazardLevel({ tau = 0, dtau_h = 0, wind_ms = 0 }) {
  const { danger, caution } = constants.hazard;
  const exceeds = (limit) => (
    (tau ?? 0) >= limit.tau
    || (dtau_h ?? 0) >= limit.dtau_h
    || (wind_ms ?? 0) >= limit.wind_ms
  );
  if (exceeds(danger)) return 2;
  if (exceeds(caution)) return 1;
  return 0;
}

export function groundTempGrid(tiSi, tRoverC, tMeanC, tiRover) {
  const out = new Float32Array(tiSi.length);
  for (let i = 0; i < tiSi.length; i++) {
    const ti = tiSi[i];
    const factor = ti > 0 ? clamp(tiRover / ti, 0.5, 2) : 1;
    out[i] = tMeanC + (tRoverC - tMeanC) * factor;
  }
  return out;
}

export function at(series, ltst, maxGap = 3) {
  if (!series) return null;
  const hour = Math.floor(mod(ltst, 24));
  const fraction = mod(ltst, 24) - hour;
  if (series[hour] != null && fraction === 0) return series[hour];

  let before = null;
  let after = null;
  let distBefore = 0;
  let distAfter = 0;
  for (let k = 0; k < 24 && before == null; k++) {
    const value = series[(hour - k + 24) % 24];
    if (value != null) {
      before = value;
      distBefore = k + fraction;
    }
  }
  for (let k = 1; k <= 24 && after == null; k++) {
    const value = series[(hour + k) % 24];
    if (value != null) {
      after = value;
      distAfter = k - fraction;
    }
  }
  if (before == null || after == null) return null;
  if (distBefore > maxGap || distAfter > maxGap) return null;
  return before + (after - before) * distBefore / (distBefore + distAfter);
}

function mean(xs) {
  return xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : null;
}

function presentValues(series) {
  return (series ?? []).filter((x) => x != null);
}

function reading(value, unit, tag, src, note, noteArgs) {
  return { v: value, unit, tag, src, note, noteArgs };
}

function nearestSol(sols, ls) {
  return sols.reduce(
    (best, sol) => (lsDistance(sol.ls, ls) < lsDistance(best.ls, ls) ? sol : best),
    sols[0],
  );
}

function hazardReasons(tau, dtau_h, windMs) {
  const caution = constants.hazard.caution;
  const reasons = [];
  if (tau >= caution.tau) reasons.push("tau");
  if (dtau_h >= caution.dtau_h) reasons.push("rise");
  if (windMs >= caution.wind_ms) reasons.push("wind");
  return reasons;
}

export function resolveEnv(envData, marsTime, clock, override, utcMs) {
  const sols = envData.sols;
  const replay = clock?.mode === "replay" ? envData.bySol.get(clock.replaySol) : null;
  const near = replay ?? nearestSol(sols, marsTime.ls);
  const isMeasured = !!replay;
  const kind = isMeasured ? "replay" : "climatology";
  const climatologyNote = isMeasured ? undefined : "clock.note.climatology";
  const solArgs = { sol: near.sol, ls: Math.round(near.ls) };

  const measured = (series, unit, srcKey) => reading(
    at(near[series], marsTime.ltst),
    unit,
    isMeasured ? "MEASURED" : "MODEL",
    near.src?.[srcKey],
    climatologyNote,
    solArgs,
  );

  const p = measured("p_pa", "Pa", "der_ps");
  const tAir = measured("t_air_c", "°C", "cal_ats");
  const tGround = measured("t_ground_c", "°C", "cal_tirs");
  const rh = measured("rh_pct", "%", "der_rhs");
  tGround.tMean = mean(presentValues(near.t_ground_c));
  tGround.tMin = Math.min(...presentValues(near.t_ground_c));
  tGround.tMax = Math.max(...presentValues(near.t_ground_c));

  const active = override && utcMs >= override.t0Utc ? override : null;
  const spanMs = active ? Math.max(1, active.t1Utc - active.t0Utc) : 1;
  const progress = active ? clamp((utcMs - active.t0Utc) / spanMs, 0, 1) : 0;
  const lerp = (range) => (range ? range[0] + (range[1] - range[0]) * progress : null);
  const simulated = (value, unit) => (
    reading(value, unit, "SIMULATED", null, "clock.note.sim", { label: active.label ?? "" })
  );

  const windModelCfg = constants.wind_model;
  const hasWindSeries = isMeasured && near.wind_ms && presentValues(near.wind_ms).length >= 4;
  const modelWindMs = windModelCfg.base_ms
    + windModelCfg.amp_ms * Math.max(0, Math.sin(Math.PI * (marsTime.ltst - 9) / 8));
  const measuredWind = hasWindSeries ? at(near.wind_ms, marsTime.ltst) : null;
  const modelWind = () => reading(
    modelWindMs,
    "m/s",
    "MODEL",
    "data/env/env_constants.json (wind_model)",
    hasWindSeries ? "clock.note.windGap" : "clock.note.windModel",
    { sol: near.sol },
  );
  let wind = measuredWind != null
    ? reading(measuredWind, "m/s", "MEASURED", near.src?.der_ws)
    : modelWind();

  const hourNow = Math.round(marsTime.ltst);
  const nearbyDirection = [0, -1, 1, -2, 2]
    .map((offset) => near.wind_dir_deg?.[mod(hourNow + offset, 24)])
    .find((x) => x != null) ?? null;
  let windDir = measuredWind != null
    ? reading(nearbyDirection, "°", "MEASURED", near.src?.der_ws)
    : reading(null, "°", "MODEL", null, "clock.note.windNoDir");

  let tau = reading(
    tauClim(marsTime.ls),
    "",
    "MODEL",
    "data/env/env_constants.json (tau)",
    "clock.note.tau",
  );
  let dtauPerHour = 0;
  if (active && active.tau) {
    tau = simulated(lerp(active.tau), "");
    if (progress > 0 && progress < 1) {
      const durationMarsHours = spanMs / 1000 / MARS_HOUR_S;
      dtauPerHour = (active.tau[1] - active.tau[0]) / durationMarsHours;
    }
  }
  if (active && active.wind_ms) {
    wind = simulated(lerp(active.wind_ms), "m/s");
    if (active.wind_dir_deg != null) windDir = simulated(active.wind_dir_deg, "°");
  }

  const tempK = tAir.v == null ? null : tAir.v + 273.15;
  const rho = reading(
    p.v != null && tempK ? density(p.v, tempK) : null,
    "kg/m³",
    isMeasured ? "DERIVED" : "MODEL",
    "ρ = p / (R·T), R = " + constants.R_co2 + " J/(kg·constants)",
    "clock.note.density",
  );
  const sza = 90 - marsTime.sunEl;
  const uvReading = reading(
    uv(marsTime.rAU, sza, tau.v),
    "W/m²",
    tau.tag === "SIMULATED" ? "SIMULATED" : "MODEL",
    "data/env/env_constants.json (uv)",
    "clock.note.uv",
  );
  const rad = reading(
    constants.rad.gcr_uGy_day,
    "µGy/day",
    "MODEL",
    constants.rad.src,
    "clock.note.rad",
    { gcr: constants.rad.gcr_uGy_day, sd: constants.rad.sd },
  );

  const others = sols.filter(
    (sol) => sol !== near && lsDistance(sol.ls, near.ls) <= constants.climatology_window_ls,
  );
  const variation = (key, current) => {
    const otherValues = others
      .map((sol) => at(sol[key], marsTime.ltst))
      .filter((x) => x != null);
    const ref = mean(otherValues);
    return reading(
      current.v != null && ref != null ? current.v - ref : null,
      current.unit,
      "DERIVED",
      null,
      "clock.note.variation",
      { n: others.length },
    );
  };

  const values = {
    pressure: p,
    t_air: tAir,
    t_ground: tGround,
    rh,
    wind,
    wind_dir: windDir,
    density: rho,
    tau,
    uv: uvReading,
    rad,
    pressure_var: variation("p_pa", p),
    t_air_var: variation("t_air_c", tAir),
  };

  const windMs = wind.v;
  const isSimulated = tau.tag === "SIMULATED" || wind.tag === "SIMULATED";
  const hazard = {
    level: hazardLevel({ tau: tau.v, dtau_h: dtauPerHour, wind_ms: windMs }),
    tau: tau.v,
    dtau_h: dtauPerHour,
    wind_ms: windMs,
    reasons: hazardReasons(tau.v, dtauPerHour, windMs),
    cell: active?.cell ?? null,
    radius_m: active?.radius_m ?? null,
    label: active?.label ?? null,
    tag: isSimulated ? "SIMULATED" : "MODEL",
  };
  return { values, hazard, source: { sol: near.sol, ls: near.ls, kind } };
}
