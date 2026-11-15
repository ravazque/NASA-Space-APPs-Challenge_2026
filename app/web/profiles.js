import { energyGrid } from "./pathfind.js";

export const PROFILES = {
  foot: { id: "foot", speed_ms: null },
  vehicle: { id: "vehicle", speed_ms: 2.0 },
  cargo: { id: "cargo", speed_ms: 1.0 },
};

export function passMask(profile, layers, extra, cfg) {
  const s = layers.slope_deg, out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s[i] <= cfg.max_slope_deg ? 1 : 0;
  return out;
}

export const routeEnergy = (profile, layers, extra, cellM, cfg) => energyGrid(layers, cellM, cfg);

export const planPenalty = (profile, layers, extra) => null;
