const NEIGHBOURS = [[-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
  [-1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [1, 1, Math.SQRT2]];

export function pandolfWatts(slopeDeg, terrainFactor, cfg) {
  const W = cfg.astronaut_mass_kg, L = cfg.load_kg, V = cfg.walk_speed_ms;
  const G = Math.max(0, Math.tan((slopeDeg * Math.PI) / 180) * 100);
  const m = 1.5 * W + 2.0 * (W + L) * (L / W) ** 2 + terrainFactor * (W + L) * (1.5 * V * V + 0.35 * V * G);
  return m * cfg.gravity_ratio;
}

export function energyGrid(layers, cellM, cfg) {
  const n = layers.slope_deg.length, out = new Float32Array(n);
  const { bedrock, loose_sand } = cfg.terrain_factor;
  for (let i = 0; i < n; i++) {
    const s = layers.slope_deg[i];
    if (s > cfg.max_slope_deg) { out[i] = Infinity; continue; }
    const eta = loose_sand + (bedrock - loose_sand) * layers.thermal_inertia[i];
    out[i] = pandolfWatts(s, eta, cfg) * (cellM / cfg.walk_speed_ms);
  }
  return out;
}

export function planningGrid(energy, layers, w) {
  const n = energy.length, out = new Float32Array(n);
  let maxE = 0;
  for (const e of energy) if (e !== Infinity && e > maxE) maxE = e;
  for (let i = 0; i < n; i++) {
    if (energy[i] === Infinity) { out[i] = Infinity; continue; }
    const c = w.energy * (energy[i] / maxE)
      + w.risk * (1 - layers.thermal_inertia[i])
      + w.comms * (1 - layers.viewshed[i])
      + w.radiation * layers.svf[i]
      - w.science * layers.science[i];
    out[i] = Math.max(0.01, c);
  }
  return out;
}

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

export function dijkstra(cost, rows, cols, start, goal = -1) {
  const n = rows * cols, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n), heap = new MinHeap(); dist[start] = 0; heap.push(0, start);
  while (heap.size) {
    const u = heap.pop(); if (done[u]) continue; done[u] = 1; if (u === goal) break;
    const r = (u / cols) | 0, c = u % cols, du = dist[u];
    for (const [dr, dc, len] of NEIGHBOURS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      const v = nr * cols + nc, alt = du + ((cost[u] + cost[v]) / 2) * len;
      if (alt < dist[v]) { dist[v] = alt; prev[v] = u; heap.push(alt, v); }
    }
  }
  return { dist, prev };
}

export function shortestPath(cost, rows, cols, start, goal) {
  const { prev, dist } = dijkstra(cost, rows, cols, start, goal);
  if (dist[goal] === Infinity) return [];
  const path = [];
  for (let i = goal; i !== -1; i = prev[i]) path.push(i);
  return path.reverse();
}

export function pathStats(path, energy, cols, cellM) {
  let lengthM = 0, energyJ = 0;
  for (let n = 1; n < path.length; n++) {
    const a = path[n - 1], b = path[n];
    const step = a % cols !== b % cols && ((a / cols) | 0) !== ((b / cols) | 0) ? Math.SQRT2 : 1;
    lengthM += step * cellM;
    energyJ += step * (energy[a] + energy[b]) / 2;
  }
  return { lengthM, energyJ };
}

export function walkbackMask(returnEnergy, remainingJ, margin) {
  const limit = remainingJ * (1 - margin), out = new Uint8Array(returnEnergy.length);
  for (let i = 0; i < out.length; i++) out[i] = returnEnergy[i] <= limit ? 1 : 0;
  return out;
}
