import { energyGrid } from "./pathfind.js";

export const HARD_SLOPE_DEG = 15;
export const ROUGH_VEHICLE_M = 0.30;

export const PROFILES = {
  foot: {
    id: "foot", speed_ms: null, maxSlope: null, roughMax: null, rocksBlock: false, buffer: 0,
  },
  vehicle: {
    id: "vehicle", speed_ms: 2.0, maxSlope: 15, roughMax: ROUGH_VEHICLE_M,
    rocksBlock: true, buffer: 0,
  },
  cargo: {
    id: "cargo", speed_ms: 1.0, maxSlope: 10, roughMax: "p75", rocksBlock: true, buffer: 1,
  },
};

export function prepareExtra(json) {
  const rough = Float32Array.from(json.layers.rough_m);
  const rocks = new Uint8Array(rough.length);
  const rockRuns = json.layers.rocks;
  for (let k = 0; k < rockRuns.length; k += 2) {
    const start = rockRuns[k];
    const length = rockRuns[k + 1];
    rocks.fill(1, start, start + length);
  }

  const sorted = Float32Array.from(rough).sort();
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

  return {
    meta: json.meta,
    rough_m: rough,
    rocks,
    craters: json.craters,
    rough_p: { 50: percentile(0.5), 75: percentile(0.75), 90: percentile(0.9) },
  };
}

function roughLimit(profile, extra) {
  if (profile.roughMax == null) return null;
  if (profile.roughMax === "p75") {
    return Math.min(extra?.rough_p?.[75] ?? ROUGH_VEHICLE_M, ROUGH_VEHICLE_M);
  }
  return profile.roughMax;
}

export function limits(profileId, extra, cfg) {
  const profile = PROFILES[profileId] ?? PROFILES.foot;
  return {
    slope: Math.min(profile.maxSlope ?? Infinity, cfg.max_slope_deg),
    rough: roughLimit(profile, extra),
    rocksBlock: profile.rocksBlock,
    buffer: profile.buffer,
  };
}

function dilate(mask, rows, cols, radius) {
  let current = mask;
  for (let step = 0; step < radius; step++) {
    const grown = Uint8Array.from(current);
    for (let i = 0; i < current.length; i++) {
      if (!current[i]) continue;
      const y = (i / cols) | 0;
      const x = i % cols;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny >= 0 && ny < rows && nx >= 0 && nx < cols) grown[ny * cols + nx] = 1;
        }
      }
    }
    current = grown;
  }
  return current;
}

export function passMask(profileId, layers, extra, cfg) {
  const profile = PROFILES[profileId] ?? PROFILES.foot;
  const slope = layers.slope_deg;
  const count = slope.length;
  const limit = limits(profileId, extra, cfg);
  const out = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const withinSlope = slope[i] <= limit.slope;
    const tooRough = limit.rough != null && extra && extra.rough_m[i] > limit.rough;
    const blockedByRock = profile.rocksBlock && extra && extra.rocks[i];
    out[i] = withinSlope && !tooRough && !blockedByRock ? 1 : 0;
  }
  if (!profile.buffer || !extra) return out;

  const { cols } = extra.meta;
  const vehiclePass = passMask("vehicle", layers, extra, cfg);
  const blocked = vehiclePass.map((v) => 1 - v);
  const near = dilate(blocked, count / cols, cols, profile.buffer);
  for (let i = 0; i < count; i++) {
    if (near[i]) out[i] = 0;
  }
  return out;
}

export function routeEnergy(profileId, layers, extra, cellM, cfg) {
  if (profileId === "foot" || !PROFILES[profileId]) return energyGrid(layers, cellM, cfg);

  const pass = passMask(profileId, layers, extra, cfg);
  const watts = cfg.eva_energy_budget_j / (cfg.eva_duration_h * 3600);
  const joulesPerCell = (watts * cellM) / PROFILES[profileId].speed_ms;
  return Float32Array.from(pass, (v) => (v ? joulesPerCell : Infinity));
}

const SLOPE_PENALTY = {
  vehicle: (slope) => 1 + (slope / 15) ** 2,
  cargo: (slope) => 1 + 2 * (slope / 10) ** 2,
};

export function planPenalty(profileId, layers, extra) {
  const penalty = SLOPE_PENALTY[profileId];
  return penalty ? Float32Array.from(layers.slope_deg, penalty) : null;
}

export function hardMask(layers, extra, cfg) {
  const slope = layers.slope_deg;
  const out = new Uint8Array(slope.length);
  for (let i = 0; i < slope.length; i++) {
    const passable = slope[i] <= cfg.max_slope_deg;
    const steep = slope[i] > HARD_SLOPE_DEG;
    const rough = extra && extra.rough_m[i] > extra.rough_p[90];
    out[i] = passable && (steep || rough) ? 1 : 0;
  }
  return out;
}

export function share(mask) {
  let count = 0;
  for (const v of mask) count += v;
  return (100 * count) / mask.length;
}

export function blockReason(profileId, i, layers, extra, cfg) {
  const limit = limits(profileId, extra, cfg);
  if (layers.slope_deg[i] > limit.slope) return "slope";
  if (extra && limit.rough != null && extra.rough_m[i] > limit.rough) return "rough";
  if (extra && limit.rocksBlock && extra.rocks[i]) return "rocks";
  return passMask(profileId, layers, extra, cfg)[i] ? null : "buffer";
}
