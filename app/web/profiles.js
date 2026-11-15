import { energyGrid } from "./pathfind.js";

export const HARD_SLOPE_DEG = 15;
export const ROUGH_VEHICLE_M = 0.30;

export const PROFILES = {
  foot: { id: "foot", speed_ms: null, maxSlope: null, roughMax: null, rocksBlock: false, buffer: 0 },
  vehicle: { id: "vehicle", speed_ms: 2.0, maxSlope: 15, roughMax: ROUGH_VEHICLE_M, rocksBlock: true, buffer: 0 },
  cargo: { id: "cargo", speed_ms: 1.0, maxSlope: 10, roughMax: "p75", rocksBlock: true, buffer: 1 },
};

export function prepareExtra(json) {
  const rough = Float32Array.from(json.layers.rough_m), rocks = new Uint8Array(rough.length), r = json.layers.rocks;
  for (let k = 0; k < r.length; k += 2) rocks.fill(1, r[k], r[k] + r[k + 1]);
  const s = Float32Array.from(rough).sort(), pct = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { meta: json.meta, rough_m: rough, rocks, craters: json.craters, rough_p: { 50: pct(0.5), 75: pct(0.75), 90: pct(0.9) } };
}

export function limits(profile, extra, cfg) {
  const p = PROFILES[profile] ?? PROFILES.foot;
  return {
    slope: Math.min(p.maxSlope ?? Infinity, cfg.max_slope_deg),
    rough: p.roughMax == null ? null : p.roughMax === "p75" ? Math.min(extra?.rough_p?.[75] ?? ROUGH_VEHICLE_M, ROUGH_VEHICLE_M) : p.roughMax,
    rocksBlock: p.rocksBlock, buffer: p.buffer,
  };
}

function dilate(mask, rows, cols, r) {
  let cur = mask;
  for (let k = 0; k < r; k++) {
    const out = Uint8Array.from(cur);
    for (let i = 0; i < cur.length; i++) {
      if (!cur[i]) continue;
      const y = (i / cols) | 0, x = i % cols;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < rows && xx >= 0 && xx < cols) out[yy * cols + xx] = 1;
      }
    }
    cur = out;
  }
  return cur;
}

export function passMask(profile, layers, extra, cfg) {
  const p = PROFILES[profile] ?? PROFILES.foot, s = layers.slope_deg, n = s.length, lim = limits(profile, extra, cfg), out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = s[i] <= lim.slope && !(lim.rough != null && extra && extra.rough_m[i] > lim.rough) && !(p.rocksBlock && extra && extra.rocks[i]) ? 1 : 0;
  }
  if (!p.buffer || !extra) return out;
  const { cols } = extra.meta, bad = passMask("vehicle", layers, extra, cfg).map((v) => 1 - v), near = dilate(bad, n / cols, cols, p.buffer);
  for (let i = 0; i < n; i++) if (near[i]) out[i] = 0;
  return out;
}

export function routeEnergy(profile, layers, extra, cellM, cfg) {
  if (profile === "foot" || !PROFILES[profile]) return energyGrid(layers, cellM, cfg);
  const pass = passMask(profile, layers, extra, cfg), rate = cfg.eva_energy_budget_j / (cfg.eva_duration_h * 3600), J = (rate * cellM) / PROFILES[profile].speed_ms;
  return Float32Array.from(pass, (v) => (v ? J : Infinity));
}

export function planPenalty(profile, layers, extra) {
  const k = { vehicle: (s) => 1 + (s / 15) ** 2, cargo: (s) => 1 + 2 * (s / 10) ** 2 }[profile];
  return k ? Float32Array.from(layers.slope_deg, k) : null;
}

export function hardMask(layers, extra, cfg) {
  const s = layers.slope_deg, out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s[i] <= cfg.max_slope_deg && (s[i] > HARD_SLOPE_DEG || (extra && extra.rough_m[i] > extra.rough_p[90])) ? 1 : 0;
  return out;
}

export const share = (mask) => { let n = 0; for (const v of mask) n += v; return (100 * n) / mask.length; };

export function blockReason(profile, i, layers, extra, cfg) {
  const lm = limits(profile, extra, cfg);
  if (layers.slope_deg[i] > lm.slope) return "slope";
  if (extra && lm.rough != null && extra.rough_m[i] > lm.rough) return "rough";
  if (extra && lm.rocksBlock && extra.rocks[i]) return "rocks";
  return passMask(profile, layers, extra, cfg)[i] ? null : "buffer";
}
