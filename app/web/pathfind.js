const NEIGHBOURS = [
  [-1, 0, 1],
  [1, 0, 1],
  [0, -1, 1],
  [0, 1, 1],
  [-1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [1, 1, Math.SQRT2],
];

export const PLAN_BASE = 0.25;

export function pandolfWatts(slopeDeg, terrainFactor, cfg) {
  const mass = cfg.astronaut_mass_kg;
  const load = cfg.load_kg;
  const speed = cfg.walk_speed_ms;
  const gradePct = Math.max(0, Math.tan((slopeDeg * Math.PI) / 180) * 100);
  const metabolic = 1.5 * mass
    + 2.0 * (mass + load) * (load / mass) ** 2
    + terrainFactor * (mass + load) * (1.5 * speed * speed + 0.35 * speed * gradePct);
  return metabolic * cfg.gravity_ratio;
}

export function energyGrid(layers, cellM, cfg) {
  const count = layers.slope_deg.length;
  const out = new Float32Array(count);
  const { bedrock, loose_sand } = cfg.terrain_factor;
  for (let i = 0; i < count; i++) {
    const slope = layers.slope_deg[i];
    if (slope > cfg.max_slope_deg) {
      out[i] = Infinity;
      continue;
    }
    const terrainFactor = loose_sand + (bedrock - loose_sand) * layers.thermal_inertia[i];
    out[i] = pandolfWatts(slope, terrainFactor, cfg) * (cellM / cfg.walk_speed_ms);
  }
  return out;
}

function minMaxOfPassable(values, energy) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < energy.length; i++) {
    if (energy[i] === Infinity) continue;
    min = Math.min(min, values[i]);
    max = Math.max(max, values[i]);
  }
  return { min, max };
}

function normalize(value, min, max) {
  return (value - min) / (max - min || 1);
}

export function planningGrid(energy, layers, weights) {
  const count = energy.length;
  const out = new Float32Array(count);
  const inertia = layers.thermal_inertia;
  const svf = layers.svf;
  const energyRange = minMaxOfPassable(energy, energy);
  const inertiaRange = minMaxOfPassable(inertia, energy);
  const svfRange = minMaxOfPassable(svf, energy);

  for (let i = 0; i < count; i++) {
    if (energy[i] === Infinity) {
      out[i] = Infinity;
      continue;
    }
    out[i] = PLAN_BASE
      + weights.energy * normalize(energy[i], energyRange.min, energyRange.max)
      + weights.risk * (1 - normalize(inertia[i], inertiaRange.min, inertiaRange.max))
      + weights.comms * (1 - layers.viewshed[i])
      + weights.radiation * normalize(svf[i], svfRange.min, svfRange.max)
      + weights.science * (1 - layers.science[i]);
  }
  return out;
}

class MinHeap {
  constructor() {
    this.keys = [];
    this.values = [];
  }

  get size() {
    return this.keys.length;
  }

  push(key, value) {
    const { keys, values } = this;
    let i = keys.length;
    keys.push(key);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }

  pop() {
    const { keys, values } = this;
    const top = values[0];
    const lastKey = keys.pop();
    const lastValue = values.pop();
    const size = keys.length;
    if (size > 0) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= size) break;
        if (child + 1 < size && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= lastKey) break;
        keys[i] = keys[child];
        values[i] = values[child];
        i = child;
      }
      keys[i] = lastKey;
      values[i] = lastValue;
    }
    return top;
  }
}

export function dijkstra(cost, rows, cols, start, goal = -1) {
  const count = rows * cols;
  const dist = new Float64Array(count).fill(Infinity);
  const prev = new Int32Array(count).fill(-1);
  const done = new Uint8Array(count);
  const heap = new MinHeap();
  dist[start] = 0;
  heap.push(0, start);

  while (heap.size) {
    const cell = heap.pop();
    if (done[cell]) continue;
    done[cell] = 1;
    if (cell === goal) break;

    const r = (cell / cols) | 0;
    const c = cell % cols;
    for (const [dr, dc, stepLength] of NEIGHBOURS) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      const isDiagonal = dr !== 0 && dc !== 0;
      if (isDiagonal && (cost[r * cols + nc] === Infinity || cost[nr * cols + c] === Infinity)) {
        continue;
      }
      const next = nr * cols + nc;
      const alt = dist[cell] + ((cost[cell] + cost[next]) / 2) * stepLength;
      if (alt < dist[next]) {
        dist[next] = alt;
        prev[next] = cell;
        heap.push(alt, next);
      }
    }
  }
  return { dist, prev };
}

export function shortestPath(cost, rows, cols, start, goal) {
  const { prev, dist } = dijkstra(cost, rows, cols, start, goal);
  if (!(dist[goal] < Infinity)) return [];
  const path = [];
  for (let cell = goal; cell !== -1; cell = prev[cell]) {
    path.push(cell);
  }
  return path.reverse();
}

export function pathStats(path, energy, cols, cellM) {
  let lengthM = 0;
  let energyJ = 0;
  for (let i = 1; i < path.length; i++) {
    const from = path[i - 1];
    const to = path[i];
    const changesColumn = from % cols !== to % cols;
    const changesRow = ((from / cols) | 0) !== ((to / cols) | 0);
    const step = changesColumn && changesRow ? Math.SQRT2 : 1;
    lengthM += step * cellM;
    energyJ += step * (energy[from] + energy[to]) / 2;
  }
  return { lengthM, energyJ };
}

export function walkbackMask(returnEnergy, remainingJ, margin) {
  const limit = remainingJ * (1 - margin);
  const out = new Uint8Array(returnEnergy.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = returnEnergy[i] <= limit ? 1 : 0;
  }
  return out;
}

export function evaTimeline(route, energy, cols, cellM, cfg) {
  const cumM = [0];
  const cumJ = [0];
  for (let i = 1; i < route.length; i++) {
    const step = pathStats([route[i - 1], route[i]], energy, cols, cellM);
    cumM.push(cumM[i - 1] + step.lengthM);
    cumJ.push(cumJ[i - 1] + step.energyJ);
  }
  const lengthM = cumM.at(-1) ?? 0;
  const v = cfg.walk_speed_ms;
  return {
    cumM,
    cumJ,
    lengthM,
    v,
    tArr: lengthM / v,
    eOut: cumJ.at(-1) ?? 0,
    rate: cfg.eva_energy_budget_j / (cfg.eva_duration_h * 3600),
  };
}

export function stateAt(t, timeline, route, habitat = -1) {
  if (!route.length) return { cell: habitat, spent: timeline.rate * t };

  const distance = t >= timeline.tArr ? timeline.lengthM : timeline.v * t;
  let i = 0;
  while (i < route.length - 1 && timeline.cumM[i + 1] <= distance) i++;

  const hasNext = i < route.length - 1;
  const segment = hasNext
    ? (distance - timeline.cumM[i]) / (timeline.cumM[i + 1] - timeline.cumM[i])
    : 0;
  const nextJ = timeline.cumJ[i + 1] ?? timeline.cumJ[i];
  const walkJ = timeline.cumJ[i] + segment * (nextJ - timeline.cumJ[i]);
  const idleS = Math.max(0, t - timeline.tArr);
  return { cell: route[i], spent: walkJ + idleS * timeline.rate };
}

export function turnaround(timeline, returnJ, cfg) {
  const spareJ = (cfg.eva_energy_budget_j - timeline.eOut) - returnJ / (1 - cfg.return_margin);
  const siteS = spareJ / timeline.rate;
  return { siteS, turnS: timeline.tArr + siteS };
}
