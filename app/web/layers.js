import { state, set, on, emit } from "./store.js";
import { t, num, pick, shown } from "./i18n.js";
import { $, h, esc, tag, ico } from "./ui.js";
import { PROFILES, prepareExtra, limits, passMask, hardMask, share } from "./profiles.js";
import { stateAt } from "./pathfind.js";
import { groundTempGrid } from "./env.js";

export const CATS = ["nav", "topo", "geo", "met", "atm", "rad"];

export const CATALOGUE = [
  { id: "route", cat: "nav", kind: "vector", tag: "DERIVED", file: "pathfind.js", unit: "m",
    legend: "route", map: ["plan:route"], on: true, fixed: true },
  { id: "envelope", cat: "nav", kind: "vector", tag: "DERIVED", file: "mission_config.json",
    unit: "", legend: "envelope", map: ["plan:envelope", "plan:outside"], on: true },
  { id: "return_points", cat: "nav", kind: "vector", tag: "DERIVED", file: "jezero_cost_grid.json",
    unit: "", legend: "refuge", map: ["layers:return", "layers:return-zone"], on: true },
  { id: "passage", cat: "nav", kind: "vector", tag: "DERIVED", file: "profiles.js", unit: "",
    legend: "passage", map: ["plan:forbid", "plan:forbid.edge"], on: true, profiles: true },
  { id: "hard", cat: "nav", kind: "vector", tag: "DERIVED", file: "terrain_extra.json", unit: "",
    legend: "hard", map: ["layers:hard"] },
  { id: "obstacles", cat: "nav", kind: "vector", tag: "DERIVED + REPORTED",
    file: "terrain_extra.json", unit: "", legend: "obst", map: ["layers:obstacles"], on: true },
  { id: "crew", cat: "nav", kind: "vector", tag: "REPORTED / SIMULATED", file: "LAN hub", unit: "",
    legend: "crew", map: ["hub:crew"], on: true },
  { id: "assets", cat: "nav", kind: "vector", tag: "REPORTED / SIMULATED", file: "LAN hub",
    unit: "", legend: "base", map: ["hub:assets"], on: true },
  { id: "log", cat: "nav", kind: "vector", tag: "REPORTED", file: "LAN hub", unit: "",
    legend: "note", map: ["log:entries", "log:deviations"], on: true },
  { id: "locks", cat: "nav", kind: "vector", tag: "REPORTED", file: "LAN hub", unit: "",
    legend: "lock",
    map: ["log:locks", "log:locks-hatch", "log:locks-own", "log:routes", "log:lockplates"],
    on: true },
  { id: "comms", cat: "nav", kind: "raster", tag: "DERIVED", file: "jezero_cost_grid.json",
    unit: "", legend: "ramp3" },
  { id: "traverse", cat: "nav", kind: "vector", tag: "MEASURED", file: "traverse_cells.json",
    unit: "", legend: "trav", map: ["layers:traverse"], on: true },

  { id: "elevation", cat: "topo", kind: "raster", tag: "MEASURED + DERIVED",
    file: "jezero_cost_grid.json", unit: "m", legend: "ramp", grid: "elevation_m", dp: 0 },
  { id: "slope", cat: "topo", kind: "raster", tag: "DERIVED", file: "jezero_cost_grid.json",
    unit: "°", legend: "ramp", grid: "slope_deg", dp: 1 },
  { id: "relief", cat: "topo", kind: "raster", tag: "DERIVED", file: "jezero_cost_grid.json",
    unit: "", legend: "relief" },
  { id: "roughness", cat: "topo", kind: "raster", tag: "DERIVED", file: "terrain_extra.json",
    unit: "m", legend: "ramp", dp: 2 },
  { id: "craters", cat: "topo", kind: "vector", tag: "DERIVED", file: "terrain_extra.json",
    unit: "m", legend: "crater", map: ["layers:craters"] },
  { id: "rocks", cat: "topo", kind: "vector", tag: "DERIVED", file: "terrain_extra.json", unit: "",
    legend: "dots", map: ["layers:rocks"] },
  { id: "confidence", cat: "topo", kind: "raster", tag: "DERIVED", file: "jezero_cost_grid.json",
    unit: "", legend: "ramp", grid: "confidence", dp: 2 },

  { id: "geo", cat: "geo", kind: "vector", tag: "DERIVED", file: "geounits.json", unit: "",
    legend: "geo", map: ["layers:geo"] },
  { id: "minerals", cat: "geo", kind: "raster", tag: "DERIVED", file: "jezero_cost_grid.json",
    unit: "", legend: "ramp", grid: "science", dp: 2 },
  { id: "ti", cat: "geo", kind: "raster", tag: "DERIVED", file: "jezero_cost_grid.json",
    unit: "SI", legend: "ramp", grid: "thermal_inertia_si", dp: 0 },
  { id: "science", cat: "geo", kind: "vector", tag: "MEASURED + REPORTED", file: "science.json",
    unit: "", legend: "site", map: ["layers:science"], on: true },

  { id: "air_temp", cat: "met", kind: "readout", tag: "MEASURED / MODEL",
    file: "env/meda_sols.json", unit: "°C", dp: 0 },
  { id: "ground_temp", cat: "met", kind: "raster", tag: "MEASURED / MODEL",
    file: "env/meda_sols.json", unit: "°C", legend: "ramp", dp: 0, readout: true },
  { id: "wind", cat: "met", kind: "readout", tag: "MEASURED / MODEL", file: "env/meda_sols.json",
    unit: "m/s", legend: "wind", dp: 1, map: ["clock:wind"], on: true },
  { id: "humidity", cat: "met", kind: "readout", tag: "MEASURED / MODEL",
    file: "env/meda_sols.json", unit: "% RH", dp: 0 },
  { id: "dust_storm", cat: "met", kind: "vector", tag: "MODEL + SIMULATED", file: "env.js",
    unit: "", legend: "storm", map: ["clock:storm"], on: true, readout: true },

  { id: "pressure", cat: "atm", kind: "readout", tag: "MEASURED / MODEL",
    file: "env/meda_sols.json", unit: "Pa", dp: 0 },
  { id: "density", cat: "atm", kind: "readout", tag: "DERIVED", file: "env.js", unit: "kg/m³",
    dp: 4 },
  { id: "dust_tau", cat: "atm", kind: "readout", tag: "MODEL / SIMULATED", file: "env.js",
    unit: "τ", dp: 2 },
  { id: "variation", cat: "atm", kind: "readout", tag: "DERIVED", file: "env/meda_sols.json",
    unit: "Δ Pa · Δ °C", dp: 1 },

  { id: "uv", cat: "rad", kind: "readout", tag: "MODEL", file: "env.js", unit: "W/m²", dp: 1 },
  { id: "ambient_rad", cat: "rad", kind: "readout", tag: "MODEL", file: "env/env_constants.json",
    unit: "µGy/day", dp: 0 },
  { id: "sky", cat: "rad", kind: "raster", tag: "DERIVED", file: "jezero_cost_grid.json", unit: "",
    legend: "ramp", grid: "svf", dp: 2 },
  { id: "protection", cat: "rad", kind: "readout", tag: "MODEL", file: "jezero_cost_grid.json",
    unit: "µGy", dp: 0 },
];

export const BY = Object.fromEntries(CATALOGUE.map((item) => [item.id, item]));

const DEFAULT_ALPHAS = [0, 36, 72, 107, 143].map((a) => a / 255);
const RAMP_ALPHAS = [0, 0.14, 0.28, 0.42, 0.56];
const REDRAW_INTERVAL_MS = 500;
const STORAGE_KEY = "ariadne.layers";

const rad = (deg) => (deg * Math.PI) / 180;

export function hillshade(z, rows, cols, cellM, elDeg, azDeg, zFactor = 3) {
  const out = new Float32Array(z.length);
  const el = rad(elDeg);
  const az = rad(azDeg);
  const light = [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const colPrev = Math.max(0, c - 1);
      const colNext = Math.min(cols - 1, c + 1);
      const rowPrev = Math.max(0, r - 1);
      const rowNext = Math.min(rows - 1, r + 1);
      const dx = (zFactor * (z[r * cols + colNext] - z[r * cols + colPrev]))
        / ((colNext - colPrev) * cellM);
      const dn = (zFactor * (z[rowPrev * cols + c] - z[rowNext * cols + c]))
        / ((rowNext - rowPrev) * cellM);
      const shade = (-dx * light[0] - dn * light[1] + light[2]) / Math.hypot(dx, dn, 1);
      out[r * cols + c] = Math.max(0, shade);
    }
  }
  return out;
}

export function rangeOf(values) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

export function rampRGBA(values, lo, hi, ink, ground, wash, alphas = DEFAULT_ALPHAS) {
  const swatchColors = alphas.map((alpha) => {
    const total = alpha + wash * (1 - alpha);
    const color = ink.map((k, j) => (k * alpha + ground[j] * wash * (1 - alpha)) / total);
    return [...color, total * 255];
  });
  const out = new Uint8ClampedArray(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const step = Math.floor((swatchColors.length * (v - lo)) / (hi - lo || 1));
    out.set(swatchColors[Math.min(swatchColors.length - 1, Math.max(0, step))], i * 4);
  }
  return out;
}

export function reliefRGBA(shade, flat, ink, ground) {
  const out = new Uint8ClampedArray(shade.length * 4);
  for (let i = 0; i < shade.length; i++) {
    const diff = shade[i] - flat;
    const pixel = diff < 0
      ? [...ink, Math.min(0.75, -diff * 2) * 255]
      : [...ground, Math.min(0.6, diff * 1.5) * 255];
    out.set(pixel, i * 4);
  }
  return out;
}

let data;
let map;
let cfg;
let extra = null;
let themeCache = null;
let lastDraw = { raster: null, sun: "", groundTemp: null, groundSol: null, t: 0 };
let passPct = {};
let zoneForbid = null;
let turnPlan = null;
let redrawTimer = null;
let svfMean = null;
let groundTempMemo = { key: "", grid: null };
let groundRangePin = { sol: null, lo: 0, hi: 0 };

const openCategories = new Set(["nav"]);
const openInfo = new Set();
const rasterCache = new Map();
const itemsByMapId = {};

function themeColors() {
  if (themeCache) return themeCache;
  const css = getComputedStyle(document.documentElement);
  const rgb = (name) => {
    const hex = css.getPropertyValue(name).trim();
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  };
  const wash = css.getPropertyValue("--wash-layer").match(/[\d.]+/g)?.[3] ?? 0.5;
  themeCache = { ink: rgb("--ink"), ground: rgb("--ground"), wash: parseFloat(wash) };
  return themeCache;
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {}
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

const ENV_KEY = {
  air_temp: "t_air",
  ground_temp: "t_ground",
  humidity: "rh",
  dust_tau: "tau",
  ambient_rad: "rad",
};

function envValue(id) {
  return state.env?.values?.[ENV_KEY[id] ?? id];
}

function formatValue(value, dp) {
  const digits = dp ?? 1;
  if (typeof value === "number") return num(value, digits);
  if (typeof value === "object" && value) {
    return Object.values(value)
      .filter((x) => typeof x === "number")
      .map((x) => num(x, digits))
      .join(" · ");
  }
  return "—";
}

const nameOf = (id) => t(`layers.name.${id}`);

function tagsHtml(text) {
  return esc(text).replace(/[A-Z]{5,}/g, (word) => tag(word) || word);
}

function profileLimits(profile) {
  const profileLimit = limits(profile, extra, cfg);
  return {
    slope: num(profileLimit.slope, 0),
    rough: profileLimit.rough == null ? "" : num(profileLimit.rough, 2),
    max: num(profileLimit.slope, 0),
  };
}

const svg = (body, cls = "lg") => (
  `<svg class="${cls}" viewBox="0 0 24 12" aria-hidden="true">${body}</svg>`
);

function swatches(alphas) {
  const cells = alphas.map((a) => `<i style="--a:${a}"></i>`).join("");
  return `<span class="sws">${cells}</span>`;
}

const HATCH_PATHS = "M-2 12L10 0M5 12L17 0M12 12L24 0M19 12L31 0";
const START_GLYPH = svg(
  '<rect x="8" y="2" width="8" height="8" style="fill:var(--ink);stroke:var(--ground)" '
  + 'stroke-width="1"/>',
);

const GLYPH = {
  route: svg(
    '<path d="M0 6H24" style="stroke:var(--ground)" stroke-width="7"/>'
    + '<path d="M0 6H24" style="stroke:var(--blue)" stroke-width="4"/>',
  ),
  envelope: svg(
    '<path d="M0 6H24" style="stroke:var(--ground)" stroke-width="5.5"/>'
    + '<path d="M0 6H24" style="stroke:var(--green)" stroke-width="2.5"/>',
  ),
  refuge: '<svg class="lg sign" viewBox="0 0 48 48" aria-hidden="true">'
    + '<use href="#s-refuge"/></svg>',
  forbid: svg(
    '<rect width="24" height="12" style="fill:var(--ground);fill-opacity:.4"/>'
    + `<path d="${HATCH_PATHS}" style="stroke:var(--red)" stroke-width="2"/>`
    + '<rect x=".5" y=".5" width="23" height="11" fill="none" style="stroke:var(--red)"/>',
  ),
  passage: svg(
    `<path d="${HATCH_PATHS}" style="stroke:var(--ink)" stroke-width="1"/>`
    + '<rect x=".5" y=".5" width="23" height="11" fill="none" style="stroke:var(--ink)" '
    + 'stroke-dasharray="4 2"/>',
  ),
  hard: svg(
    '<path d="M-2 12L10 0M8 12L20 0M18 12L30 0" style="stroke:var(--ink)" stroke-width="1"/>',
  ),
  dots: svg(
    '<circle cx="4" cy="3" r="1.3" style="fill:var(--ink)"/>'
    + '<circle cx="12" cy="8" r="1.3" style="fill:var(--ink)"/>'
    + '<circle cx="20" cy="3" r="1.3" style="fill:var(--ink)"/>',
  ),
  obst: svg(
    '<rect x="1" y="1" width="22" height="10" style="fill:none;stroke:var(--ink)" '
    + 'stroke-width="1.25"/>',
  ),
  crew: svg(
    '<circle cx="12" cy="6" r="3.5" style="fill:var(--surface);stroke:var(--ink)" '
    + 'stroke-width="2"/>',
  ),
  base: START_GLYPH,
  note: svg(
    '<path d="M7 1.5H17V10.5H7Z" style="fill:var(--surface);stroke:var(--ink)" '
    + 'stroke-width="1.5"/>'
    + '<path d="M9 5H15M9 7.5H13" style="stroke:var(--ink)" stroke-width="1"/>',
  ),
  lock: svg(
    '<rect x="1" y="1" width="22" height="10" style="fill:none;stroke:var(--red)" '
    + 'stroke-width="2"/>',
  ),
  trav: svg(
    '<path d="M0 6H24" style="stroke:var(--ground)" stroke-width="3.5"/>'
    + '<path d="M0 6H24" style="stroke:var(--ink)" stroke-width="1.5" stroke-dasharray="5 4"/>',
  ),
  crater: svg(
    '<circle cx="12" cy="6" r="5" style="fill:none;stroke:var(--ink)" stroke-width="1.5" '
    + 'stroke-dasharray="3 2"/>',
  ),
  site: svg(
    '<path d="M12 1L17 6L12 11L7 6Z" style="fill:var(--ink);stroke:var(--ground)" '
    + 'stroke-width="1"/>',
  ),
  storm: svg(
    '<path d="M12 1L19 11H5Z" style="fill:var(--yellow);stroke:var(--ink)" '
    + 'stroke-width="1.5" stroke-linejoin="round"/>',
  ),
  wind: svg(
    '<path d="M2 6H19" style="stroke:var(--ink)" stroke-width="2"/>'
    + '<path d="M16 2.5L22 6L16 9.5Z" style="fill:var(--ink)"/>',
  ),
  geo: svg(
    `<path d="${HATCH_PATHS}" style="stroke:var(--ink)" stroke-width="1"/>`
    + '<circle cx="19" cy="8" r="1.2" style="fill:var(--ink)"/>',
  ),
  ramp: swatches(RAMP_ALPHAS),
  ramp3: swatches([0, 0.18, 0.5]),
  relief: swatches([0.55, 0.3, 0, 0.0]),
};

const LEGEND_GLYPH = {
  outside: svg('<rect width="24" height="12" style="fill:var(--ground);fill-opacity:.62"/>'),
  dest: svg(
    '<circle cx="12" cy="6" r="5" style="fill:var(--blue);stroke:var(--ground)" '
    + 'stroke-width="1"/>'
    + '<circle cx="12" cy="6" r="1.5" style="fill:var(--surface)"/>',
  ),
  spe: svg(
    '<path d="M0 6H24" style="stroke:var(--ink)" stroke-width="6"/>'
    + '<path d="M0 6H24" style="stroke:var(--yellow)" stroke-width="4" stroke-dasharray="8 6"/>',
  ),
};

function gridOf(id) {
  const item = BY[id];
  if (item.grid) return data.layers[item.grid];
  if (id === "roughness") return extra?.rough_m ?? null;
  return null;
}

function commsRGBA({ ink, ground, wash }) {
  if (rasterCache.has("comms")) return rasterCache.get("comms");
  const direct = data.layers.viewshed;
  const relay = data.layers.viewshed_relay;
  const alphas = [0, 46, 128].map((a) => a / 255);
  const coverage = Float32Array.from(direct, (v, i) => {
    if (v > 0.5) return 0;
    return relay?.[i] > 0.5 ? 1 : 2;
  });
  const rgba = rampRGBA(coverage, 0, 3, ink, ground, wash, alphas);
  rasterCache.set("comms", rgba);
  return rgba;
}

function reliefLayerRGBA({ ink, ground }) {
  const clock = state.clock ?? {};
  const haveSun = Number.isFinite(clock.sunEl);
  const el = haveSun ? clock.sunEl : 45;
  const az = haveSun ? clock.sunAz : 180;
  if (el <= 0) {
    const night = new Uint8ClampedArray(data.rows * data.cols * 4);
    for (let i = 0; i < night.length; i += 4) night.set([...ink, 0.35 * 255], i);
    return night;
  }
  const shade = hillshade(data.layers.elevation_m, data.rows, data.cols, data.cellM, el, az);
  return reliefRGBA(shade, Math.sin(rad(el)), ink, ground);
}

function rasterRGBA(id) {
  const colors = themeColors();
  const { ink, ground, wash } = colors;
  if (id === "comms") return commsRGBA(colors);
  if (id === "relief") return reliefLayerRGBA(colors);
  if (id === "ground_temp") {
    const grid = groundTemp();
    return grid ? rampRGBA(grid, ...groundRange(grid), ink, ground, wash) : null;
  }
  if (rasterCache.has(id)) return rasterCache.get(id);
  const grid = gridOf(id);
  if (!grid) return null;
  const rgba = rampRGBA(grid, ...rangeOf(grid), ink, ground, wash);
  rasterCache.set(id, rgba);
  return rgba;
}

function computeGroundTemp(tRover, tMean) {
  const ti = data.layers.thermal_inertia_si;
  return groundTempGrid(ti, tRover, tMean, ti[data.cheyava]);
}

function groundTemp() {
  const v = envValue("ground_temp");
  if (!v || !Number.isFinite(v.v) || !Number.isFinite(v.tMean)) return null;
  const key = `${v.v}|${v.tMean}`;
  if (groundTempMemo.key !== key) {
    try {
      groundTempMemo = { key, grid: computeGroundTemp(v.v, v.tMean) };
    } catch {
      return null;
    }
  }
  return groundTempMemo.grid;
}

function groundRange(grid) {
  const sol = state.env?.source?.sol;
  const v = envValue("ground_temp");
  if (groundRangePin.sol !== sol) {
    const dayMin = Number.isFinite(v?.tMin) ? rangeOf(computeGroundTemp(v.tMin, v.tMean))[0] : NaN;
    const dayMax = Number.isFinite(v?.tMax) ? rangeOf(computeGroundTemp(v.tMax, v.tMean))[1] : NaN;
    groundRangePin = { sol, lo: dayMin, hi: dayMax };
  }
  const [lo, hi] = rangeOf(grid);
  return [
    Number.isFinite(groundRangePin.lo) ? Math.min(groundRangePin.lo, lo) : lo,
    Number.isFinite(groundRangePin.hi) ? Math.max(groundRangePin.hi, hi) : hi,
  ];
}

function sunKey() {
  const clock = state.clock ?? {};
  return `${Math.round((clock.sunEl ?? 99) / 0.5)}|${Math.round((clock.sunAz ?? 0) / 0.5)}`;
}

function drawRaster() {
  const id = state.ui.raster;
  const item = BY[id];
  const rgba = item?.kind === "raster" ? rasterRGBA(id) : null;
  map?.raster("layers:raster", rgba, { opacity: 1 });
  lastDraw = {
    raster: id,
    sun: sunKey(),
    groundTemp: envValue("ground_temp")?.v ?? null,
    groundSol: state.env?.source?.sol,
    t: performance.now(),
  };
}

function isRasterStale() {
  const id = state.ui.raster;
  if (id === "relief") return sunKey() !== lastDraw.sun;
  if (id !== "ground_temp") return false;
  const v = envValue("ground_temp");
  if (!v || !Number.isFinite(v.v)) return false;
  return lastDraw.groundTemp == null
    || lastDraw.groundSol !== state.env?.source?.sol
    || Math.abs(v.v - lastDraw.groundTemp) >= 0.5;
}

function refreshRaster() {
  if (!isRasterStale()) return;
  const wait = lastDraw.t + REDRAW_INTERVAL_MS - performance.now();
  if (wait > 0) {
    redrawTimer ??= setTimeout(() => {
      redrawTimer = null;
      refreshRaster();
    }, wait);
    return;
  }
  drawRaster();
  rasterLegend();
}

function craterMarker(crater) {
  const isLarge = crater.diam_m >= 100;
  return {
    cell: crater.cell,
    kind: "crater",
    radius_m: crater.diam_m / 2,
    label: isLarge ? `Ø ${num(crater.diam_m, 0)} m` : undefined,
    optional: true,
    sub: isLarge ? t("layers.depth", { m: num(crater.depth_m, 1) }) : undefined,
  };
}

function buildVectors() {
  if (!map) return;
  if (extra) {
    map.pattern("layers:hard", hardMask(data.layers, extra, cfg), { kind: "hatch-ink" });
    map.pattern("layers:rocks", extra.rocks, { kind: "dots-ink" });
    map.outline("layers:obstacles", extra.rocks, { token: "--ink", width: 1, halo: false });
    map.markers("layers:craters", extra.craters.map(craterMarker));
  }
  drawReturnZone();
  if (data.traverse?.length > 1) {
    map.lines("layers:traverse", [data.traverse], {
      token: "--ink",
      width: 1.5,
      halo: true,
      dash: [4, 4],
      opacity: 0.6,
      cap: "butt",
    });
  }
  buildGeo();
  buildMarkers();
}

function shieldedMask() {
  const sorted = Float32Array.from(data.layers.svf).sort();
  const threshold = sorted[Math.floor(sorted.length * 0.05)];
  return Uint8Array.from(data.layers.svf, (v) => (v <= threshold ? 1 : 0));
}

function drawReturnZone() {
  zoneForbid = state.plan?.forbid ?? null;
  map.outline("layers:return-zone", shieldedMask(), {
    token: "--green",
    width: 1.25,
    halo: false,
    skip: zoneForbid,
  });
}

function drawTurn() {
  if (!map) return;
  const plan = turnPlan;
  const hasTurn = plan?.route?.length > 1 && plan.tl && plan.turn;
  if (!hasTurn) {
    map.markers("layers:return", null);
    return;
  }
  const cell = plan.turn.siteS >= 0
    ? plan.route[plan.route.length - 1]
    : stateAt(plan.turn.turnS, plan.tl, plan.route, plan.habitat).cell;
  const minutes = Math.max(0, Math.floor(plan.turn.turnS / 60));
  const clockText = `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
  map.markers("layers:return", [{
    cell,
    kind: "site",
    label: t("layers.return.turn"),
    sub: `T+${clockText}`,
    optional: true,
    dy: 30,
  }]);
}

function buildMarkers() {
  if (!map) return;
  drawTurn();
  const coreName = (data.science?.destination?.name ?? "").split(" / ")[1]?.trim();
  map.markers("layers:science", [
    { cell: data.cheyava, kind: "site", label: coreName ?? "Sapphire Canyon",
      optional: true, dy: -30 },
    { cell: data.habitat, kind: "site", label: t("layers.science.depot"),
      optional: true, dy: 30 },
  ]);
  if (data.geoInfo?.length) {
    map.markers("layers:geo", data.geoInfo.map((unit) => ({
      cell: unit.cell,
      kind: "note",
      label: unit.symbol,
      sub: pick(unit, "name"),
      optional: true,
    })));
  }
}

const GEO_PATTERNS = {
  Aeb: { dots: [4, 0.9] },
  NHjf2: { lines: [5, "h"] },
  Njf: { lines: [7, "\\"] },
  Nue: { lines: [7, "v"] },
  cr: { lines: [8, "x"] },
  Nnp1: { dots: [9, 1.4] },
};

function buildGeo() {
  const geoUnits = data.layers.geo_unit;
  if (!geoUnits || !data.geoInfo.length) return;
  const mapIds = [];
  for (const unit of data.geoInfo) {
    const mask = new Uint8Array(geoUnits.length);
    for (let i = 0; i < geoUnits.length; i++) {
      if (geoUnits[i] === unit.id) mask[i] = 1;
    }
    const id = `layers:geo-${unit.symbol}`;
    mapIds.push(id);
    map.outline(id, mask, { token: "--ink", width: 1.25, halo: false });
    const pattern = GEO_PATTERNS[unit.symbol];
    if (pattern) {
      map.pattern(`${id}-p`, mask, { kind: { ...pattern, a: 0.55 } });
      mapIds.push(`${id}-p`);
    }
  }
  BY.geo.map = ["layers:geo", ...mapIds];
  indexMap();
}

function indexMap() {
  for (const key of Object.keys(itemsByMapId)) delete itemsByMapId[key];
  for (const item of CATALOGUE) {
    for (const mapId of item.map ?? []) {
      (itemsByMapId[mapId] ??= []).push(item);
    }
  }
}

function applyVisibility() {
  const show = state.ui.show;
  for (const [mapId, items] of Object.entries(itemsByMapId)) {
    map?.show(mapId, items.some((item) => item.fixed || show[item.id]));
  }
}

function passPctText(profile) {
  if (passPct[profile] == null) return "";
  return t("layers.pass", { pct: num(passPct[profile], 0) });
}

function profileControl() {
  const box = h("div", "pseg");
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", t("layers.profile.legend"));
  for (const profile of Object.keys(PROFILES)) {
    const button = h(
      "button",
      "",
      `<span>${esc(t(`layers.profile.${profile}`))}</span>`
        + `<small data-pct="${profile}">${passPctText(profile)}</small>`,
    );
    button.type = "button";
    button.dataset.profile = profile;
    button.setAttribute("aria-pressed", String(state.ui.profile === profile));
    button.addEventListener("click", () => set("ui", { profile }));
    box.append(button);
  }
  return box;
}

function unitSuffix(unit) {
  if (!unit) return "";
  return unit === "°" ? unit : ` ${unit}`;
}

function reliefLegendText() {
  const clock = state.clock ?? {};
  if (!Number.isFinite(clock.sunEl)) return t("layers.relief.noclock");
  if (clock.sunEl <= 0) return t("layers.relief.night");
  return t("layers.relief.sun", { el: num(clock.sunEl, 0), az: num(clock.sunAz, 0) });
}

function rasterLegend() {
  const id = state.ui.raster;
  const item = BY[id];
  const box = $("layer-legend");
  box.replaceChildren();
  if (!item || item.kind !== "raster") return;

  const addPart = (html, cls = "grp") => box.append(h("span", cls, html));
  addPart(`<b>${esc(nameOf(id))}</b> ${tagsHtml(item.tag)}`);

  if (id === "comms") {
    const relay = data.meta.relay;
    addPart(`${swatches([0])} ${esc(t("comms.direct"))}`);
    if (relay) addPart(`${swatches([0.18])} ${esc(t("comms.relay"))}`);
    addPart(`${swatches([0.5])} ${esc(t("comms.none"))}`);
    if (relay) {
      const coverage = {
        before: num(relay.coverage_before_pct, 0),
        after: num(relay.coverage_after_pct, 0),
      };
      addPart(esc(t("comms.coverage", coverage)), "");
    }
    return;
  }

  if (id === "relief") {
    addPart(esc(reliefLegendText()), "");
    return;
  }

  const isGroundTemp = id === "ground_temp";
  const grid = isGroundTemp ? groundTemp() : gridOf(id);
  if (!grid) {
    addPart(esc(t(isGroundTemp ? "layers.ground.wait" : "layers.rough.wait")), "note");
    return;
  }
  const [lo, hi] = isGroundTemp ? groundRange(grid) : rangeOf(grid);
  const unit = esc(unitSuffix(item.unit));
  addPart(
    `${esc(t("layer.less"))} ${num(lo, item.dp)} ${swatches(RAMP_ALPHAS)} `
      + `${num(hi, item.dp)}${unit} ${esc(t("layer.more"))}`,
  );
  if (id === "sky") addPart(esc(t("layer.svf_note")), "");
}

function legendItem(glyph, text, only, hidden) {
  const onlyAttr = only ? ` data-only="${only}"` : "";
  const hiddenAttr = hidden ? " hidden" : "";
  return `<li${onlyAttr}${hiddenAttr}>${glyph}<span>${esc(text)}</span></li>`;
}

function safetyLegend() {
  const profile = state.ui.profile;
  const list = $("safety-legend");
  const speHidden = list.querySelector("[data-only=spe]")?.hidden ?? true;
  const refugeHidden = list.querySelector("[data-only=refuge]")?.hidden ?? true;
  list.innerHTML = [
    legendItem(GLYPH.route, t("legend.route")),
    legendItem(GLYPH.forbid, t(`layers.leg.forbid.${profile}`, profileLimits(profile))),
    legendItem(GLYPH.envelope, t("legend.envelope")),
    legendItem(LEGEND_GLYPH.outside, t("legend.outside")),
    legendItem(START_GLYPH, t("legend.start")),
    legendItem(LEGEND_GLYPH.dest, t("legend.dest")),
    legendItem(GLYPH.crew, t("legend.eva")),
    legendItem(GLYPH.trav, t("legend.traverse"), "traverse", !state.ui.show.traverse),
    legendItem(LEGEND_GLYPH.spe, t("legend.spe"), "spe", speHidden),
    legendItem(GLYPH.refuge, t("legend.refuge"), "refuge", refugeHidden),
  ].join("");
}

function buildStrip() {
  const strip = $("legend-strip");
  strip.replaceChildren();

  const openButton = h("button", "lbtn");
  openButton.type = "button";
  openButton.id = "layers-open";
  openButton.setAttribute("aria-controls", "layers-drawer");
  openButton.addEventListener("click", () => set("ui", { drawer: !state.ui.drawer }));

  const legend = h("div", "layer-legend");
  legend.id = "layer-legend";
  legend.setAttribute("aria-live", "polite");

  const profileStrip = h("div", "prof");
  profileStrip.id = "profile-strip";

  const top = h("div", "strip-a");
  top.append(openButton, profileStrip, legend);

  const safety = h("ul", "legend");
  safety.id = "safety-legend";
  safety.innerHTML = `<li data-only="spe" hidden></li><li data-only="refuge" hidden></li>`;
  strip.append(top, safety);
}

function renderStrip() {
  const openButton = $("layers-open");
  openButton.innerHTML = `<span>${esc(t("layers.open"))}</span>`;
  openButton.setAttribute("aria-expanded", String(!!state.ui.drawer));
  $("profile-strip").replaceChildren(profileControl());
  $("safety-legend").setAttribute("aria-label", t("legend.title"));
  safetyLegend();
  rasterLegend();
}

function captionHtml(item) {
  let html = `<p>${esc(t(`layers.cap.${item.id}`))}</p>`
    + `<p class="lmeta"><b>${esc(t("layers.source"))}:</b> ${esc(t(`layers.src.${item.id}`))}</p>`;
  const isStorm = item.id === "dust_storm";
  if (item.unit || isStorm) {
    const unit = isStorm ? t("layers.hazard.level") : item.unit;
    html += `<p class="lmeta"><b>${esc(t("layers.unit"))}:</b> ${esc(unit)}</p>`;
  }
  if (item.profiles) {
    for (const profile of Object.keys(PROFILES)) {
      html += `<p class="lmeta">${esc(t(`layers.prof.${profile}`, profileLimits(profile)))}</p>`;
    }
    if (!extra) html += `<p class="lmeta">${esc(t("layers.noextra"))}</p>`;
  }
  return html;
}

function selectorLabel(item, glyphHtml, nameHtml) {
  const isRaster = item.kind === "raster";
  const type = isRaster ? "radio" : "checkbox";
  const name = isRaster ? "layers-raster" : item.id;
  const label = h(
    "label",
    "lsel",
    `<input type="${type}" name="${name}" id="lyr-${item.id}"> ${glyphHtml}`
      + `<span class="lname">${nameHtml}</span>`,
  );
  const input = label.querySelector("input");

  if (item.fixed) {
    input.disabled = true;
    input.checked = true;
    label.title = t("layers.always");
  }
  if (isRaster) {
    input.checked = state.ui.raster === item.id;
    input.addEventListener("click", () => {
      const wasSelected = state.ui.raster === item.id;
      set("ui", { raster: wasSelected ? "none" : item.id });
    });
  } else if (!item.fixed) {
    input.addEventListener("change", () => {
      set("ui", { show: { ...state.ui.show, [item.id]: input.checked } });
    });
  }
  return label;
}

function row(item) {
  const isRaster = item.kind === "raster";
  const isVector = item.kind === "vector" || (item.kind === "readout" && item.map);
  const li = h("li", `lrow k-${item.kind}`);
  li.dataset.id = item.id;

  const nameHtml = esc(nameOf(item.id));
  const glyphHtml = item.legend && GLYPH[item.legend]
    ? `<span class="lsw">${GLYPH[item.legend]}</span>`
    : "";

  const head = h("div", "lhead");
  if (isRaster || isVector) {
    head.append(selectorLabel(item, glyphHtml, nameHtml));
  } else {
    head.append(h("span", "lsel static", `${glyphHtml}<span class="lname">${nameHtml}</span>`));
  }
  head.append(h("span", "ltags", tagsHtml(item.tag)));

  const caption = h("div", "lcap");
  caption.id = `cap-${item.id}`;
  caption.hidden = !openInfo.has(item.id);
  caption.innerHTML = captionHtml(item);

  const infoButton = h("button", "linfo", ico("g-info"));
  infoButton.type = "button";
  infoButton.setAttribute("aria-label", t("layers.info", { name: nameOf(item.id) }));
  infoButton.setAttribute("aria-controls", `cap-${item.id}`);
  infoButton.setAttribute("aria-expanded", String(openInfo.has(item.id)));
  infoButton.addEventListener("click", () => {
    if (openInfo.has(item.id)) openInfo.delete(item.id);
    else openInfo.add(item.id);
    infoButton.setAttribute("aria-expanded", String(openInfo.has(item.id)));
    caption.hidden = !openInfo.has(item.id);
  });
  head.append(infoButton);
  li.append(head);

  if (item.readout || item.kind === "readout") {
    const valueButton = h("button", "lval");
    valueButton.type = "button";
    valueButton.dataset.val = item.id;
    valueButton.title = t("layers.openenv");
    valueButton.addEventListener("click", () => {
      set("ui", { tab: "env" });
      if (matchMedia("(max-width: 899px)").matches) set("ui", { drawer: false });
    });
    li.append(valueButton);
  }
  li.append(caption);
  return li;
}

function buildDrawer() {
  const drawer = $("layers-drawer");
  const scrollTop = drawer.scrollTop;
  drawer.replaceChildren();

  const head = h("div", "dhead", `<h2 id="layers-t" tabindex="-1">${esc(t("layers.title"))}</h2>`);
  const clearButton = h("button", "text-btn", esc(t("layers.clear")));
  clearButton.type = "button";
  clearButton.id = "layers-clear";
  clearButton.addEventListener("click", () => set("ui", { raster: "none" }));
  const closeButton = h("button", "lclose", "×");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", t("layers.close"));
  closeButton.addEventListener("click", () => set("ui", { drawer: false }));
  head.append(clearButton, closeButton);

  drawer.setAttribute("aria-labelledby", "layers-t");
  drawer.setAttribute("role", "region");
  drawer.append(head);

  for (const cat of CATS) {
    const details = h("details", "lcat");
    const summary = h("summary", "", esc(t(`layers.cat.${cat}`)));
    details.dataset.cat = cat;
    details.open = openCategories.has(cat);
    details.addEventListener("toggle", () => {
      if (details.open) openCategories.add(cat);
      else openCategories.delete(cat);
    });
    const list = h("ul", "llist");
    for (const item of CATALOGUE.filter((x) => x.cat === cat)) list.append(row(item));
    details.append(summary, list);
    drawer.append(details);
  }
  syncControls();
  renderValues();
  drawer.scrollTop = scrollTop;
}

function syncControls() {
  const ui = state.ui;
  $("layers-drawer").hidden = !ui.drawer;
  $("layers-open")?.setAttribute("aria-expanded", String(!!ui.drawer));
  for (const item of CATALOGUE) {
    const input = $(`lyr-${item.id}`);
    if (!input) continue;
    if (item.fixed) input.checked = true;
    else if (item.kind === "raster") input.checked = ui.raster === item.id;
    else input.checked = !!ui.show[item.id];
  }
  const clearButton = $("layers-clear");
  if (clearButton) clearButton.hidden = ui.raster === "none";
  for (const button of document.querySelectorAll("[data-profile]")) {
    button.setAttribute("aria-pressed", String(button.dataset.profile === ui.profile));
  }
  for (const el of document.querySelectorAll("[data-pct]")) {
    el.textContent = passPctText(el.dataset.pct);
  }
}

function evaDose() {
  const ambient = envValue("ambient_rad")?.v;
  const route = state.plan?.route;
  if (!Number.isFinite(ambient) || !route?.length) return null;
  const svf = data.layers.svf;
  svfMean ??= svf.reduce((a, b) => a + b, 0) / svf.length;
  const onRoute = route.reduce((sum, cell) => sum + svf[cell], 0) / route.length;
  return { uGy: (ambient / 24) * cfg.eva_duration_h * (onRoute / svfMean), tag: "MODEL" };
}

const signed = (x, dp) => (x > 0 ? "+" : "") + num(x, dp);
const hasValue = (entry) => Number.isFinite(entry?.v);

export function readout(id, values) {
  const item = BY[id];
  if (id === "variation") {
    const pressure = values?.pressure_var;
    const airTemp = values?.t_air_var;
    if (!hasValue(pressure) && !hasValue(airTemp)) return { e: pressure ?? airTemp, txt: "—" };
    const pressureText = hasValue(pressure) ? `${signed(pressure.v, 0)} Pa` : "—";
    const airTempText = hasValue(airTemp) ? `${signed(airTemp.v, 1)} °C` : "—";
    return { e: pressure ?? airTemp, txt: `${pressureText} · ${airTempText}` };
  }

  const e = values?.[ENV_KEY[id] ?? id];
  if (!Number.isFinite(e?.v)) return { e, txt: "—" };
  let txt = `${formatValue(e.v, item.dp)} ${e.unit ?? item.unit}`.trim();
  const windDir = id === "wind" ? values.wind_dir?.v : null;
  if (Number.isFinite(windDir)) txt += ` · ${num(windDir, 0)}°`;
  return { e, txt };
}

function protectionReadout() {
  const dose = evaDose();
  if (!dose) return { e: dose, txt: "—" };
  const spe = state.plan?.spe;
  let txt = `${num(dose.uGy, 0)} µGy`;
  if (spe && spe.kind !== "home") {
    txt += ` · ${t("layers.protect.shelter", { min: num(spe.min, 0) })}`;
  }
  return { e: { tag: dose.tag }, txt };
}

function stormReadout() {
  const level = state.env?.hazard?.level;
  const txt = Number.isFinite(level) ? `${level} · ${t(`layers.hazard.${level}`)}` : "—";
  return { e: undefined, txt };
}

function readoutTitle(entry) {
  const base = t("layers.openenv");
  if (!entry?.note) return base;
  const args = entry.noteArgs?.label
    ? { ...entry.noteArgs, label: shown(entry.noteArgs.label) }
    : entry.noteArgs ?? {};
  return `${base} · ${t(entry.note, args)}`;
}

function renderValues() {
  for (const button of document.querySelectorAll("[data-val]")) {
    const id = button.dataset.val;
    let result;
    if (id === "protection") result = protectionReadout();
    else if (id === "dust_storm") result = stormReadout();
    else result = readout(id, state.env?.values);
    const { e, txt } = result;

    const html = `<span class="num">${esc(txt)}</span>${e?.tag ? tag(e.tag) : ""}`;
    const title = readoutTitle(e);
    if (button._h !== html) {
      button._h = html;
      button.innerHTML = html;
    }
    if (button.title !== title) button.title = title;
  }
}

function computePassPct() {
  passPct = {};
  for (const profile of Object.keys(PROFILES)) {
    passPct[profile] = share(passMask(profile, data.layers, extra, cfg));
  }
}

async function loadTerrainExtra(ctx) {
  try {
    const res = await fetch("data/terrain_extra.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const loaded = prepareExtra(await res.json());
    const cellCount = data.rows * data.cols;
    const { rows, cols } = loaded.meta;
    if (rows * cols !== cellCount || loaded.rough_m.length !== cellCount) {
      throw new Error(
        `grid mismatch: ${rows}x${cols} vs ${data.rows}x${data.cols}; rebuild with make data`,
      );
    }
    extra = ctx.extra = loaded;
    emit("extra");
  } catch (e) {
    console.error("ARIADNE terrain_extra:", e);
  }
}

function initialUiState() {
  const saved = loadSettings();
  const show = {};
  for (const item of CATALOGUE) {
    if (item.kind !== "raster") show[item.id] = saved.show?.[item.id] ?? !!item.on;
  }
  const raster = BY[saved.raster]?.kind === "raster" ? saved.raster : "none";
  return {
    raster,
    show: { ...state.ui.show, ...show },
    drawer: false,
    profile: state.ui.profile ?? "foot",
  };
}

export async function init(ctx) {
  data = ctx.data;
  map = ctx.map;
  cfg = data.cfg;

  await loadTerrainExtra(ctx);
  computePassPct();
  indexMap();
  set("ui", initialUiState());
  turnPlan = state.plan ?? null;

  buildStrip();
  renderStrip();
  buildDrawer();
  buildVectors();
  applyVisibility();
  drawRaster();

  let seen = {
    raster: state.ui.raster,
    show: state.ui.show,
    drawer: state.ui.drawer,
    profile: state.ui.profile,
  };
  on("ui", (ui) => {
    if (ui.raster !== seen.raster) {
      drawRaster();
      rasterLegend();
    }
    if (ui.show !== seen.show) {
      applyVisibility();
      safetyLegend();
    }
    if (ui.profile !== seen.profile) safetyLegend();
    if (ui.drawer !== seen.drawer && ui.drawer) $("layers-t")?.focus();
    if (ui.raster !== seen.raster || ui.show !== seen.show) {
      saveSettings({ raster: ui.raster, show: ui.show });
    }
    seen = { raster: ui.raster, show: ui.show, drawer: ui.drawer, profile: ui.profile };
    syncControls();
  });

  on("env", () => {
    renderValues();
    refreshRaster();
  });
  on("clock", () => {
    renderValues();
    refreshRaster();
  });
  on("lang", () => {
    renderStrip();
    buildDrawer();
    buildMarkers();
  });

  let lastRoute = null;
  let lastSpe = null;
  on("plan", (plan) => {
    if (plan.forbid !== zoneForbid && map) drawReturnZone();
    if (plan.route !== lastRoute || plan.spe !== lastSpe) {
      lastRoute = plan.route;
      lastSpe = plan.spe;
      renderValues();
    }
    if (plan.turn !== turnPlan?.turn || plan.route !== turnPlan?.route) {
      turnPlan = plan;
      drawTurn();
    }
  });

  $("layers-drawer").addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      set("ui", { drawer: false });
      $("layers-open")?.focus();
    }
  });
}
