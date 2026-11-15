import { state, set, on, emit } from "./store.js";
import { t, num, pick, shown } from "./i18n.js";
import { $, h, esc, tag } from "./ui.js";
import { PROFILES, prepareExtra, limits, passMask, hardMask, share } from "./profiles.js";
import { stateAt } from "./pathfind.js";
import { groundTempGrid } from "./env.js";

export const CATS = ["nav", "topo", "geo", "met", "atm", "rad"];

export const CATALOGUE = [
  { id: "route", cat: "nav", kind: "vector", tag: "DERIVED", file: "pathfind.js", unit: "m", legend: "route", map: ["plan:route"], on: true, fixed: true },
  { id: "envelope", cat: "nav", kind: "vector", tag: "DERIVED", file: "mission_config.json", unit: "", legend: "envelope", map: ["plan:envelope", "plan:outside"], on: true },
  { id: "return_points", cat: "nav", kind: "vector", tag: "DERIVED", file: "jezero_cost_grid.json", unit: "", legend: "refuge", map: ["layers:return", "layers:return-zone"], on: true },
  { id: "passage", cat: "nav", kind: "vector", tag: "DERIVED", file: "profiles.js", unit: "", legend: "forbid", map: ["plan:forbid", "plan:forbid.edge"], on: true, profiles: true },
  { id: "hard", cat: "nav", kind: "vector", tag: "DERIVED", file: "terrain_extra.json", unit: "", legend: "hard", map: ["layers:hard"] },
  { id: "obstacles", cat: "nav", kind: "vector", tag: "DERIVED + REPORTED", file: "terrain_extra.json", unit: "", legend: "obst", map: ["layers:obstacles"], on: true },
  { id: "crew", cat: "nav", kind: "vector", tag: "REPORTED / SIMULATED", file: "LAN hub", unit: "", legend: "crew", map: ["hub:crew"], on: true },
  { id: "assets", cat: "nav", kind: "vector", tag: "REPORTED / SIMULATED", file: "LAN hub", unit: "", legend: "base", map: ["hub:assets"], on: true },
  { id: "log", cat: "nav", kind: "vector", tag: "REPORTED", file: "LAN hub", unit: "", legend: "note", map: ["log:entries", "log:deviations"], on: true },
  { id: "locks", cat: "nav", kind: "vector", tag: "REPORTED", file: "LAN hub", unit: "", legend: "lock", map: ["log:locks", "log:locks-hatch", "log:locks-own", "log:routes", "log:lockplates"], on: true },
  { id: "comms", cat: "nav", kind: "raster", tag: "DERIVED", file: "jezero_cost_grid.json", unit: "", legend: "ramp3" },
  { id: "traverse", cat: "nav", kind: "vector", tag: "MEASURED", file: "traverse_cells.json", unit: "", legend: "trav", map: ["layers:traverse"], on: true },

  { id: "elevation", cat: "topo", kind: "raster", tag: "MEASURED → DERIVED", file: "jezero_cost_grid.json", unit: "m", legend: "ramp", grid: "elevation_m", dp: 0 },
  { id: "slope", cat: "topo", kind: "raster", tag: "DERIVED", file: "jezero_cost_grid.json", unit: "°", legend: "ramp", grid: "slope_deg", dp: 1 },
  { id: "relief", cat: "topo", kind: "raster", tag: "DERIVED", file: "jezero_cost_grid.json", unit: "", legend: "relief" },
  { id: "roughness", cat: "topo", kind: "raster", tag: "DERIVED", file: "terrain_extra.json", unit: "m", legend: "ramp", dp: 2 },
  { id: "craters", cat: "topo", kind: "vector", tag: "DERIVED", file: "terrain_extra.json", unit: "m", legend: "crater", map: ["layers:craters"] },
  { id: "rocks", cat: "topo", kind: "vector", tag: "DERIVED", file: "terrain_extra.json", unit: "", legend: "dots", map: ["layers:rocks"] },
  { id: "confidence", cat: "topo", kind: "raster", tag: "DERIVED", file: "jezero_cost_grid.json", unit: "", legend: "ramp", grid: "confidence", dp: 2 },

  { id: "geo", cat: "geo", kind: "vector", tag: "DERIVED", file: "geounits.json", unit: "", legend: "geo", map: ["layers:geo"] },
  { id: "minerals", cat: "geo", kind: "raster", tag: "DERIVED", file: "jezero_cost_grid.json", unit: "", legend: "ramp", grid: "science", dp: 2 },
  { id: "ti", cat: "geo", kind: "raster", tag: "DERIVED", file: "jezero_cost_grid.json", unit: "SI", legend: "ramp", grid: "thermal_inertia_si", dp: 0 },
  { id: "science", cat: "geo", kind: "vector", tag: "MEASURED + REPORTED", file: "science.json", unit: "", legend: "site", map: ["layers:science"], on: true },

  { id: "air_temp", cat: "met", kind: "readout", tag: "MEASURED / MODEL", file: "env/meda_sols.json", unit: "°C", dp: 0 },
  { id: "ground_temp", cat: "met", kind: "raster", tag: "MEASURED / MODEL", file: "env/meda_sols.json", unit: "°C", legend: "ramp", dp: 0, readout: true },
  { id: "wind", cat: "met", kind: "readout", tag: "MEASURED / MODEL", file: "env/meda_sols.json", unit: "m/s", legend: "wind", dp: 1, map: ["clock:wind"], on: true },
  { id: "humidity", cat: "met", kind: "readout", tag: "MEASURED / MODEL", file: "env/meda_sols.json", unit: "% RH", dp: 0 },
  { id: "dust_storm", cat: "met", kind: "vector", tag: "MODEL + SIMULATED", file: "env.js", unit: "", legend: "storm", map: ["clock:storm"], on: true, readout: true },

  { id: "pressure", cat: "atm", kind: "readout", tag: "MEASURED / MODEL", file: "env/meda_sols.json", unit: "Pa", dp: 0 },
  { id: "density", cat: "atm", kind: "readout", tag: "DERIVED", file: "env.js", unit: "kg/m³", dp: 4 },
  { id: "dust_tau", cat: "atm", kind: "readout", tag: "MODEL / SIMULATED", file: "env.js", unit: "τ", dp: 2 },
  { id: "variation", cat: "atm", kind: "readout", tag: "DERIVED", file: "env/meda_sols.json", unit: "Δ Pa · Δ °C", dp: 1 },

  { id: "uv", cat: "rad", kind: "readout", tag: "MODEL", file: "env.js", unit: "W/m²", dp: 1 },
  { id: "ambient_rad", cat: "rad", kind: "readout", tag: "MODEL", file: "env/env_constants.json", unit: "µGy/day", dp: 0 },
  { id: "sky", cat: "rad", kind: "raster", tag: "DERIVED", file: "jezero_cost_grid.json", unit: "", legend: "ramp", grid: "svf", dp: 2 },
  { id: "protection", cat: "rad", kind: "readout", tag: "MODEL", file: "jezero_cost_grid.json", unit: "µGy", dp: 0 },
];
export const BY = Object.fromEntries(CATALOGUE.map((c) => [c.id, c]));

const A5 = [0, 36, 72, 107, 143];
const rad = (d) => (d * Math.PI) / 180;

export function hillshade(z, rows, cols, cellM, elDeg, azDeg, zf = 3) {
  const out = new Float32Array(z.length), el = rad(elDeg), az = rad(azDeg);
  const L = [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c, c0 = Math.max(0, c - 1), c1 = Math.min(cols - 1, c + 1), r0 = Math.max(0, r - 1), r1 = Math.min(rows - 1, r + 1);
    const dx = (zf * (z[r * cols + c1] - z[r * cols + c0])) / ((c1 - c0) * cellM), dn = (zf * (z[r0 * cols + c] - z[r1 * cols + c])) / ((r1 - r0) * cellM);
    out[i] = Math.max(0, (-dx * L[0] - dn * L[1] + L[2]) / Math.hypot(dx, dn, 1));
  }
  return out;
}

export function rangeOf(a) {
  let lo = Infinity, hi = -Infinity;
  for (const v of a) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}

export function rampRGBA(values, lo, hi, ink, ground, wash, alphas = A5.map((a) => a / 255)) {
  const px = alphas.map((al) => { const A = al + wash * (1 - al); return [...ink.map((k, j) => (k * al + ground[j] * wash * (1 - al)) / A), A * 255]; });
  const out = new Uint8ClampedArray(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    out.set(px[Math.min(px.length - 1, Math.max(0, Math.floor((px.length * (v - lo)) / (hi - lo || 1))))], i * 4);
  }
  return out;
}

export function reliefRGBA(shade, flat, ink, ground) {
  const out = new Uint8ClampedArray(shade.length * 4);
  for (let i = 0; i < shade.length; i++) {
    const d = shade[i] - flat;
    out.set(d < 0 ? [...ink, Math.min(0.75, -d * 2) * 255] : [...ground, Math.min(0.6, d * 1.5) * 255], i * 4);
  }
  return out;
}

let ctx, d, map, extra = null, cfg;
let tokens = null, last = { raster: null, sun: "", gT: null, gSol: null, t: 0 }, passPct = {}, geoIds = [], hardM = null;
const open = new Set(["nav"]);
const infoOpen = new Set();
const cache = new Map();
const BY_MAP = {};

const tok = () => (tokens ??= (() => {
  const css = getComputedStyle(document.documentElement), hex = (n) => { const v = css.getPropertyValue(n).trim(); return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)); };
  return { ink: hex("--ink"), ground: hex("--ground"), wash: parseFloat(css.getPropertyValue("--wash-layer").match(/[\d.]+/g)?.[3] ?? 0.5) };
})());
const KEY = "ariadne.layers";
const store = (o) => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch {} };
const restore = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } };

const ENV_KEY = { air_temp: "t_air", ground_temp: "t_ground", humidity: "rh", dust_tau: "tau", ambient_rad: "rad" };
const val = (id) => state.env?.values?.[ENV_KEY[id] ?? id];
const fmt = (v, dp) => (typeof v === "number" ? num(v, dp ?? 1) : typeof v === "object" && v ? Object.values(v).filter((x) => typeof x === "number").map((x) => num(x, dp ?? 1)).join(" · ") : "—");
const nameOf = (id) => t(`layers.name.${id}`);
const tagsHtml = (s) => esc(s).replace(/[A-Z]{5,}/g, (m) => tag(m) || m);
const lim = (p) => { const l = limits(p, extra, cfg); return { slope: num(l.slope, 0), rough: l.rough == null ? "" : num(l.rough, 2), max: num(l.slope, 0) }; };

const svg = (body, cls = "lg") => `<svg class="${cls}" viewBox="0 0 24 12" aria-hidden="true">${body}</svg>`;
const sws = (alphas) => `<span class="sws">${alphas.map((a) => `<i style="--a:${a}"></i>`).join("")}</span>`;
const GLYPH = {
  route: svg('<path d="M0 6H24" style="stroke:var(--ground)" stroke-width="7"/><path d="M0 6H24" style="stroke:var(--blue)" stroke-width="4"/>'),
  envelope: svg('<path d="M0 6H24" style="stroke:var(--ground)" stroke-width="5.5"/><path d="M0 6H24" style="stroke:var(--green)" stroke-width="2.5"/>'),
  refuge: `<svg class="lg sign" viewBox="0 0 48 48" aria-hidden="true"><use href="#s-refuge"/></svg>`,
  forbid: svg('<rect width="24" height="12" style="fill:var(--ground);fill-opacity:.4"/><path d="M-2 12L10 0M5 12L17 0M12 12L24 0M19 12L31 0" style="stroke:var(--red)" stroke-width="2"/><rect x=".5" y=".5" width="23" height="11" fill="none" style="stroke:var(--red)"/>'),
  hard: svg('<path d="M-2 12L10 0M8 12L20 0M18 12L30 0" style="stroke:var(--ink)" stroke-width="1"/>'),
  dots: svg('<circle cx="4" cy="3" r="1.3" style="fill:var(--ink)"/><circle cx="12" cy="8" r="1.3" style="fill:var(--ink)"/><circle cx="20" cy="3" r="1.3" style="fill:var(--ink)"/>'),
  obst: svg('<rect x="1" y="1" width="22" height="10" style="fill:none;stroke:var(--ink)" stroke-width="1.25"/>'),
  crew: svg('<circle cx="12" cy="6" r="3.5" style="fill:var(--surface);stroke:var(--ink)" stroke-width="2"/>'),
  base: svg('<rect x="8" y="2" width="8" height="8" style="fill:var(--ink);stroke:var(--ground)" stroke-width="1"/>'),
  note: svg('<path d="M7 1.5H17V10.5H7Z" style="fill:var(--surface);stroke:var(--ink)" stroke-width="1.5"/><path d="M9 5H15M9 7.5H13" style="stroke:var(--ink)" stroke-width="1"/>'),
  lock: svg('<rect x="1" y="1" width="22" height="10" style="fill:none;stroke:var(--red)" stroke-width="2"/>'),
  trav: svg('<path d="M0 6H24" style="stroke:var(--ground)" stroke-width="3.5"/><path d="M0 6H24" style="stroke:var(--ink)" stroke-width="1.5" stroke-dasharray="5 4"/>'),
  crater: svg('<circle cx="12" cy="6" r="5" style="fill:none;stroke:var(--ink)" stroke-width="1.5" stroke-dasharray="3 2"/>'),
  site: svg('<path d="M12 1L17 6L12 11L7 6Z" style="fill:var(--ink);stroke:var(--ground)" stroke-width="1"/>'),
  storm: svg('<path d="M12 1L19 11H5Z" style="fill:var(--yellow);stroke:var(--ink)" stroke-width="1.5" stroke-linejoin="round"/>'),
  wind: svg('<path d="M2 6H19" style="stroke:var(--ink)" stroke-width="2"/><path d="M16 2.5L22 6L16 9.5Z" style="fill:var(--ink)"/>'),
  geo: svg('<path d="M-2 12L10 0M5 12L17 0M12 12L24 0M19 12L31 0" style="stroke:var(--ink)" stroke-width="1"/><circle cx="19" cy="8" r="1.2" style="fill:var(--ink)"/>'),
  ramp: sws([0, 0.14, 0.28, 0.42, 0.56]),
  ramp3: sws([0, 0.18, 0.5]),
  relief: sws([0.55, 0.3, 0, 0.0]),
};

function gridOf(id) {
  const it = BY[id];
  if (it.grid) return d.layers[it.grid];
  if (id === "roughness") return extra?.rough_m ?? null;
  return null;
}
function rasterRGBA(id) {
  const { ink, ground, wash } = tok();
  if (id === "comms") {
    if (cache.has(id)) return cache.get(id);
    const V = d.layers.viewshed, R = d.layers.viewshed_relay, steps = [0, 46, 128].map((a) => a / 255);
    const out = rampRGBA(Float32Array.from(V, (v, i) => (v > 0.5 ? 0 : R?.[i] > 0.5 ? 1 : 2)), 0, 3, ink, ground, wash, steps);
    cache.set(id, out); return out;
  }
  if (id === "relief") {
    const ck = state.clock ?? {}, haveSun = Number.isFinite(ck.sunEl);
    const el = haveSun ? ck.sunEl : 45, az = haveSun ? ck.sunAz : 180;
    if (el <= 0) { const o = new Uint8ClampedArray(d.rows * d.cols * 4); for (let i = 0; i < o.length; i += 4) o.set([...ink, 0.35 * 255], i); return o; }
    return reliefRGBA(hillshade(d.layers.elevation_m, d.rows, d.cols, d.cellM, el, az), Math.sin(rad(el)), ink, ground);
  }
  if (id === "ground_temp") {
    const g = groundTemp();
    return g ? rampRGBA(g, ...groundRange(g), ink, ground, wash) : null;
  }
  if (cache.has(id)) return cache.get(id);
  const g = gridOf(id);
  if (!g) return null;
  const rgba = rampRGBA(g, ...rangeOf(g), ink, ground, wash);
  cache.set(id, rgba); return rgba;
}
const gtGrid = (T, mean) => groundTempGrid(d.layers.thermal_inertia_si, T, mean, d.layers.thermal_inertia_si[d.cheyava]);
let gtMemo = { key: "", g: null }, gtPin = { sol: null, lo: 0, hi: 0 };
function groundTemp() {
  const v = val("ground_temp");
  if (!v || !Number.isFinite(v.v) || !Number.isFinite(v.tMean)) return null;
  const key = `${v.v}|${v.tMean}`;
  if (gtMemo.key !== key) try { gtMemo = { key, g: gtGrid(v.v, v.tMean) }; } catch { return null; }
  return gtMemo.g;
}
function groundRange(g) {
  const sol = state.env?.source?.sol, v = val("ground_temp");
  if (gtPin.sol !== sol) {
    const lo = Number.isFinite(v?.tMin) ? rangeOf(gtGrid(v.tMin, v.tMean))[0] : NaN, hi = Number.isFinite(v?.tMax) ? rangeOf(gtGrid(v.tMax, v.tMean))[1] : NaN;
    gtPin = { sol, lo, hi };
  }
  const r = rangeOf(g);
  return [Number.isFinite(gtPin.lo) ? Math.min(gtPin.lo, r[0]) : r[0], Number.isFinite(gtPin.hi) ? Math.max(gtPin.hi, r[1]) : r[1]];
}

function drawRaster() {
  const id = state.ui.raster, it = BY[id];
  const rgba = it?.kind === "raster" ? rasterRGBA(id) : null;
  map?.raster("layers:raster", rgba, { opacity: 1 });
  last = { raster: id, sun: sunKey(), gT: val("ground_temp")?.v ?? null, gSol: state.env?.source?.sol, t: performance.now() };
}
const sunKey = () => { const c = state.clock ?? {}; return `${Math.round((c.sunEl ?? 99) / 0.5)}|${Math.round((c.sunAz ?? 0) / 0.5)}`; };
let rTimer = null;
function refreshRaster() {
  const id = state.ui.raster, v = val("ground_temp");
  const dirty = id === "relief" ? sunKey() !== last.sun
    : id === "ground_temp" ? !!v && Number.isFinite(v.v) && (last.gT == null || last.gSol !== state.env?.source?.sol || Math.abs(v.v - last.gT) >= 0.5) : false;
  if (!dirty) return;
  const wait = last.t + 500 - performance.now();
  if (wait > 0) { rTimer ??= setTimeout(() => { rTimer = null; refreshRaster(); }, wait); return; }
  drawRaster(); rasterLegend();
}

const mask = (cells) => { const m = new Uint8Array(d.rows * d.cols); for (const c of cells) m[c] = 1; return m; };
function buildVectors() {
  if (!map) return;
  if (extra) {
    hardM = hardMask(d.layers, extra, cfg);
    map.pattern("layers:hard", hardM, { kind: "hatch-ink" });
    map.pattern("layers:rocks", extra.rocks, { kind: "dots-ink" });
    map.outline("layers:obstacles", extra.rocks, { token: "--ink", width: 1, halo: false });
    map.markers("layers:craters", extra.craters.map((c) => ({ cell: c.cell, kind: "crater", radius_m: c.diam_m / 2, label: c.diam_m >= 100 ? `Ø ${num(c.diam_m, 0)} m` : undefined, optional: true, sub: c.diam_m >= 100 ? `↓ ${num(c.depth_m, 1)} m` : undefined })));
  }
  map.outline("layers:return-zone", shieldedMask(), { token: "--green", width: 1.25, halo: false });
  if (d.traverse?.length > 1) map.lines("layers:traverse", [d.traverse], { token: "--ink", width: 1.5, halo: true, dash: [4, 4], opacity: 0.6, cap: "butt" });
  buildGeo();
  buildMarkers();
}
function shieldedMask() {
  const sv = Float32Array.from(d.layers.svf).sort(), lim = sv[Math.floor(sv.length * 0.05)];
  return Uint8Array.from(d.layers.svf, (v) => (v <= lim ? 1 : 0));
}
let turnPl = null;
function drawTurn() {
  if (!map) return;
  const pl = turnPl, ok = pl?.route?.length > 1 && pl.tl && pl.turn;
  if (!ok) return map.markers("layers:return", null);
  const cell = pl.turn.siteS >= 0 ? pl.route[pl.route.length - 1] : stateAt(pl.turn.turnS, pl.tl, pl.route, pl.habitat).cell, m = Math.max(0, Math.floor(pl.turn.turnS / 60));
  map.markers("layers:return", [{ cell, kind: "site", label: t("layers.return.turn"), sub: `T+${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`, optional: true, dy: 30 }]);
}
function buildMarkers() {
  if (!map) return;
  drawTurn();
  const core = (d.science?.destination?.name ?? "").split(" / ")[1]?.trim() ?? "Sapphire Canyon";
  map.markers("layers:science", [{ cell: d.cheyava, kind: "site", label: core, optional: true, dy: -30 }, { cell: d.habitat, kind: "site", label: t("layers.science.depot"), optional: true, dy: 30 }]);
  if (d.geoInfo?.length) map.markers("layers:geo", d.geoInfo.map((u) => ({ cell: u.cell, kind: "note", label: u.symbol, sub: pick(u, "name"), optional: true })));
}
const GEO_PAT = { Aeb: { dots: [4, 0.9] }, NHjf2: { lines: [5, "h"] }, Njf: { lines: [7, "\\"] }, Nue: { lines: [7, "v"] }, cr: { lines: [8, "x"] }, Nnp1: { dots: [9, 1.4] } };
function buildGeo() {
  const g = d.layers.geo_unit;
  if (!g || !d.geoInfo.length) return;
  geoIds = [];
  for (const u of d.geoInfo) {
    const m = new Uint8Array(g.length); for (let i = 0; i < g.length; i++) if (g[i] === u.id) m[i] = 1;
    const id = `layers:geo-${u.symbol}`; geoIds.push(id);
    map.outline(id, m, { token: "--ink", width: 1.25, halo: false });
    if (GEO_PAT[u.symbol]) map.pattern(`${id}-p`, m, { kind: { ...GEO_PAT[u.symbol], a: 0.55 } }), geoIds.push(`${id}-p`);
  }
  BY.geo.map = ["layers:geo", ...geoIds];
  indexMap();
}
function indexMap() { for (const k of Object.keys(BY_MAP)) delete BY_MAP[k]; for (const it of CATALOGUE) for (const m of it.map ?? []) (BY_MAP[m] ??= []).push(it); }
function applyVisibility() {
  const show = state.ui.show;
  for (const [mid, items] of Object.entries(BY_MAP)) map?.show(mid, items.some((it) => it.fixed || show[it.id]));
}

function profileControl() {
  const box = h("div", "pseg"); box.setAttribute("role", "group"); box.setAttribute("aria-label", t("layers.profile.legend"));
  for (const p of Object.keys(PROFILES)) {
    const b = h("button", "", `<span>${esc(t(`layers.profile.${p}`))}</span><small data-pct="${p}">${passPctText(p)}</small>`);
    b.type = "button"; b.dataset.profile = p; b.setAttribute("aria-pressed", String(state.ui.profile === p));
    b.addEventListener("click", () => set("ui", { profile: p }));
    box.append(b);
  }
  return box;
}
const passPctText = (p) => (passPct[p] == null ? "" : t("layers.pass", { pct: num(passPct[p], 0) }));

function rasterLegend() {
  const id = state.ui.raster, it = BY[id], box = $("layer-legend");
  box.replaceChildren();
  if (!it || it.kind !== "raster") return;
  const part = (html, cls = "grp") => box.append(h("span", cls, html));
  part(`<b>${esc(nameOf(id))}</b> ${tagsHtml(it.tag)}`);
  if (id === "comms") {
    const r = d.meta.relay;
    part(`${sws([0])} ${esc(t("comms.direct"))}`);
    if (r) part(`${sws([0.18])} ${esc(t("comms.relay"))}`);
    part(`${sws([0.5])} ${esc(t("comms.none"))}`);
    if (r) part(esc(t("comms.coverage", { before: num(r.coverage_before_pct, 0), after: num(r.coverage_after_pct, 0) })), "");
  } else if (id === "relief") {
    const c = state.clock ?? {};
    part(esc(!Number.isFinite(c.sunEl) ? t("layers.relief.noclock") : c.sunEl <= 0 ? t("layers.relief.night") : t("layers.relief.sun", { el: num(c.sunEl, 0), az: num(c.sunAz, 0) })), "");
  } else {
    const g = id === "ground_temp" ? groundTemp() : gridOf(id);
    if (!g) return part(esc(t(id === "ground_temp" ? "layers.ground.wait" : "layers.rough.wait")), "note");
    const [lo, hi] = id === "ground_temp" ? groundRange(g) : rangeOf(g), u = it.unit ? (it.unit === "°" ? it.unit : ` ${it.unit}`) : "";
    part(`${esc(t("layer.less"))} ${num(lo, it.dp)} ${sws([0, 0.14, 0.28, 0.42, 0.56])} ${num(hi, it.dp)}${esc(u)} ${esc(t("layer.more"))}`);
    if (id === "sky") part(esc(t("layer.svf_note")), "");
  }
}

function safetyLegend() {
  const p = state.ui.profile, l = lim(p), ul = $("safety-legend"), keepSpe = ul.querySelector("[data-only=spe]")?.hidden ?? true, keepRef = ul.querySelector("[data-only=refuge]")?.hidden ?? true;
  const li = (g, text, only, hidden) => `<li${only ? ` data-only="${only}"` : ""}${hidden ? " hidden" : ""}>${g}<span>${esc(text)}</span></li>`;
  ul.innerHTML = li(GLYPH.route, t("legend.route")) + li(GLYPH.forbid, t(`layers.leg.forbid.${p}`, l)) + li(GLYPH.envelope, t("legend.envelope"))
    + li(svg('<rect width="24" height="12" style="fill:var(--ground);fill-opacity:.62"/>'), t("legend.outside"))
    + li(svg('<rect x="8" y="2" width="8" height="8" style="fill:var(--ink);stroke:var(--ground)" stroke-width="1"/>'), t("legend.start"))
    + li(svg('<circle cx="12" cy="6" r="5" style="fill:var(--blue);stroke:var(--ground)" stroke-width="1"/><circle cx="12" cy="6" r="1.5" style="fill:var(--surface)"/>'), t("legend.dest"))
    + li(GLYPH.crew, t("legend.eva"))
    + li(GLYPH.trav, t("legend.traverse"), "traverse", !state.ui.show.traverse)
    + li(svg('<path d="M0 6H24" style="stroke:var(--ink)" stroke-width="6"/><path d="M0 6H24" style="stroke:var(--yellow)" stroke-width="4" stroke-dasharray="8 6"/>'), t("legend.spe"), "spe", keepSpe)
    + li(GLYPH.refuge, t("legend.refuge"), "refuge", keepRef);
}

function buildStrip() {
  const strip = $("legend-strip");
  strip.replaceChildren();
  const a = h("div", "strip-a"), btn = h("button", "lbtn");
  btn.type = "button"; btn.id = "layers-open"; btn.setAttribute("aria-controls", "layers-drawer");
  btn.addEventListener("click", () => set("ui", { drawer: !state.ui.drawer }));
  const lg = h("div", "layer-legend"); lg.id = "layer-legend"; lg.setAttribute("aria-live", "polite");
  const prof = h("div", "prof"); prof.id = "profile-strip";
  a.append(btn, prof, lg);
  const ul = h("ul", "legend"); ul.id = "safety-legend";
  ul.innerHTML = `<li data-only="spe" hidden></li><li data-only="refuge" hidden></li>`;
  strip.append(a, ul);
}
function renderStrip() {
  const btn = $("layers-open");
  btn.innerHTML = `<span>${esc(t("layers.open"))}</span>`; btn.setAttribute("aria-expanded", String(!!state.ui.drawer));
  $("profile-strip").replaceChildren(profileControl());
  $("safety-legend").setAttribute("aria-label", t("legend.title"));
  safetyLegend(); rasterLegend();
}

function row(it) {
  const li = h("li", `lrow k-${it.kind}`), isRaster = it.kind === "raster", isVec = it.kind === "vector" || (it.kind === "readout" && it.map);
  li.dataset.id = it.id;
  const nm = esc(nameOf(it.id)), g = it.legend && GLYPH[it.legend] ? `<span class="lsw">${GLYPH[it.legend]}</span>` : "";
  const head = h("div", "lhead");
  if (isRaster || isVec) {
    const lab = h("label", "lsel", `<input type="${isRaster ? "radio" : "checkbox"}" name="${isRaster ? "layers-raster" : it.id}" id="lyr-${it.id}"> ${g}<span class="lname">${nm}</span>`);
    const inp = lab.querySelector("input");
    if (it.fixed) { inp.disabled = true; inp.checked = true; lab.title = t("layers.always"); }
    if (isRaster) {
      inp.checked = state.ui.raster === it.id;
      inp.addEventListener("click", () => { const was = state.ui.raster === it.id; set("ui", { raster: was ? "none" : it.id }); });
    } else if (!it.fixed) inp.addEventListener("change", () => set("ui", { show: { ...state.ui.show, [it.id]: inp.checked } }));
    else inp.checked = true;
    head.append(lab);
  } else head.append(h("span", "lsel static", `${g}<span class="lname">${nm}</span>`));
  head.append(h("span", "ltags", tagsHtml(it.tag)));
  const info = h("button", "linfo", "ⓘ");
  info.type = "button"; info.setAttribute("aria-label", t("layers.info", { name: nameOf(it.id) })); info.setAttribute("aria-controls", `cap-${it.id}`);
  info.setAttribute("aria-expanded", String(infoOpen.has(it.id)));
  info.addEventListener("click", () => { infoOpen.has(it.id) ? infoOpen.delete(it.id) : infoOpen.add(it.id); info.setAttribute("aria-expanded", String(infoOpen.has(it.id))); cap.hidden = !infoOpen.has(it.id); });
  head.append(info);
  li.append(head);
  if (it.readout || it.kind === "readout") {
    const v = h("button", "lval"); v.type = "button"; v.dataset.val = it.id; v.title = t("layers.openenv");
    v.addEventListener("click", () => { set("ui", { tab: "env" }); if (matchMedia("(max-width: 899px)").matches) set("ui", { drawer: false }); });
    li.append(v);
  }
  if (it.profiles) { const pc = h("div", "prof in-drawer"); pc.append(profileControl()); li.append(pc); }
  const cap = h("div", "lcap");
  cap.id = `cap-${it.id}`; cap.hidden = !infoOpen.has(it.id);
  cap.innerHTML = `<p>${esc(t(`layers.cap.${it.id}`))}</p><p class="lmeta"><b>${esc(t("layers.source"))}:</b> ${esc(t(`layers.src.${it.id}`))}</p>`
    + (it.unit || it.id === "dust_storm" ? `<p class="lmeta"><b>${esc(t("layers.unit"))}:</b> ${esc(it.id === "dust_storm" ? t("layers.hazard.level") : it.unit)}</p>` : "")
    + (it.profiles ? Object.keys(PROFILES).map((p) => `<p class="lmeta">${esc(t(`layers.prof.${p}`, lim(p)))}</p>`).join("") + (extra ? "" : `<p class="lmeta">${esc(t("layers.noextra"))}</p>`) : "");
  li.append(cap);
  return li;
}

function buildDrawer() {
  const dr = $("layers-drawer"), top = dr.scrollTop;
  dr.replaceChildren();
  const head = h("div", "dhead", `<h2 id="layers-t" tabindex="-1">${esc(t("layers.title"))}</h2>`);
  const clear = h("button", "text-btn", esc(t("layers.clear"))); clear.type = "button"; clear.id = "layers-clear"; clear.addEventListener("click", () => set("ui", { raster: "none" }));
  const close = h("button", "lclose", "×"); close.type = "button"; close.setAttribute("aria-label", t("layers.close")); close.addEventListener("click", () => set("ui", { drawer: false }));
  head.append(clear, close);
  dr.setAttribute("aria-labelledby", "layers-t"); dr.setAttribute("role", "region");
  dr.append(head);
  for (const c of CATS) {
    const det = h("details", "lcat"), sum = h("summary", "", esc(t(`layers.cat.${c}`)));
    det.dataset.cat = c; det.open = open.has(c);
    det.addEventListener("toggle", () => (det.open ? open.add(c) : open.delete(c)));
    const ul = h("ul", "llist");
    for (const it of CATALOGUE.filter((x) => x.cat === c)) ul.append(row(it));
    det.append(sum, ul); dr.append(det);
  }
  syncControls(); renderValues();
  dr.scrollTop = top;
}
function syncControls() {
  const ui = state.ui;
  $("layers-drawer").hidden = !ui.drawer;
  $("layers-open")?.setAttribute("aria-expanded", String(!!ui.drawer));
  for (const it of CATALOGUE) {
    const inp = $(`lyr-${it.id}`);
    if (!inp) continue;
    inp.checked = it.fixed ? true : it.kind === "raster" ? ui.raster === it.id : !!ui.show[it.id];
  }
  const cl = $("layers-clear"); if (cl) cl.hidden = ui.raster === "none";
  for (const b of document.querySelectorAll("[data-profile]")) b.setAttribute("aria-pressed", String(b.dataset.profile === ui.profile));
  for (const el of document.querySelectorAll("[data-pct]")) el.textContent = passPctText(el.dataset.pct);
}

let svfMean = null;
function evaDose() {
  const rad = val("ambient_rad")?.v, route = state.plan?.route;
  if (!Number.isFinite(rad) || !route?.length) return null;
  const svf = d.layers.svf;
  svfMean ??= svf.reduce((a, b) => a + b, 0) / svf.length;
  const onRoute = route.reduce((a, c) => a + svf[c], 0) / route.length;
  return { uGy: (rad / 24) * cfg.eva_duration_h * (onRoute / svfMean), tag: "MODEL" };
}
export function readout(id, vs) {
  const it = BY[id];
  if (id === "variation") {
    const p = vs?.pressure_var, a = vs?.t_air_var, sg = (x, dp) => (x > 0 ? "+" : "") + num(x, dp), ok = (x) => Number.isFinite(x?.v);
    return { e: p ?? a, txt: ok(p) || ok(a) ? `${ok(p) ? `${sg(p.v, 0)} Pa` : "—"} · ${ok(a) ? `${sg(a.v, 1)} °C` : "—"}` : "—" };
  }
  const e = vs?.[ENV_KEY[id] ?? id];
  if (!Number.isFinite(e?.v)) return { e, txt: "—" };
  let txt = `${fmt(e.v, it.dp)} ${e.unit ?? it.unit}`.trim();
  const dir = id === "wind" ? vs.wind_dir?.v : null;
  if (Number.isFinite(dir)) txt += ` · ${num(dir, 0)}°`;
  return { e, txt };
}
function renderValues() {
  for (const b of document.querySelectorAll("[data-val]")) {
    const id = b.dataset.val;
    let e, txt = "";
    if (id === "protection") {
      const q = evaDose(), sp = state.plan?.spe;
      e = q && { tag: q.tag }; txt = q ? `${num(q.uGy, 0)} µGy${sp && sp.kind !== "home" ? ` · ${t("layers.protect.shelter", { min: num(sp.min, 0) })}` : ""}` : "—";
    } else if (id === "dust_storm") { const lv = state.env?.hazard?.level; txt = Number.isFinite(lv) ? `${lv} · ${t(`layers.hazard.${lv}`)}` : "—"; }
    else ({ e, txt } = readout(id, state.env?.values));
    const html = `<span class="num">${esc(txt)}</span>${e?.tag ? tag(e.tag) : ""}`, title = e?.note ? `${t("layers.openenv")} · ${t(e.note, e.noteArgs?.label ? { ...e.noteArgs, label: shown(e.noteArgs.label) } : e.noteArgs ?? {})}` : t("layers.openenv");
    if (b._h !== html) b.innerHTML = b._h = html;
    if (b.title !== title) b.title = title;
  }
}

function computePassPct() {
  passPct = {};
  for (const p of Object.keys(PROFILES)) passPct[p] = share(passMask(p, d.layers, extra, cfg));
}

export async function init(c) {
  ctx = c; d = c.data; map = c.map; cfg = d.cfg;
  try {
    const res = await fetch("data/terrain_extra.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ex = prepareExtra(await res.json()), n = d.rows * d.cols;
    if (ex.meta.rows * ex.meta.cols !== n || ex.rough_m.length !== n) throw new Error(`grid mismatch: ${ex.meta.rows}x${ex.meta.cols} vs ${d.rows}x${d.cols}; rebuild with make data`);
    extra = ctx.extra = ex;
    emit("extra");
  } catch (e) { console.error("ARIADNE terrain_extra:", e); }
  computePassPct();
  indexMap();
  const saved = restore(), show = {};
  for (const it of CATALOGUE) if (it.kind !== "raster") show[it.id] = saved.show?.[it.id] ?? !!it.on;
  const raster = BY[saved.raster]?.kind === "raster" ? saved.raster : "none";
  set("ui", { raster, show: { ...state.ui.show, ...show }, drawer: false, profile: state.ui.profile ?? "foot" });
  turnPl = state.plan ?? null;
  buildStrip(); renderStrip(); buildDrawer(); buildVectors(); applyVisibility(); drawRaster();

  let seen = { raster: state.ui.raster, show: state.ui.show, drawer: state.ui.drawer, profile: state.ui.profile };
  on("ui", (ui) => {
    if (ui.raster !== seen.raster) { drawRaster(); rasterLegend(); }
    if (ui.show !== seen.show) { applyVisibility(); safetyLegend(); }
    if (ui.profile !== seen.profile) safetyLegend();
    if (ui.drawer !== seen.drawer && ui.drawer) $("layers-t")?.focus();
    if (ui.raster !== seen.raster || ui.show !== seen.show) store({ raster: ui.raster, show: ui.show });
    seen = { raster: ui.raster, show: ui.show, drawer: ui.drawer, profile: ui.profile };
    syncControls();
  });
  on("env", () => { renderValues(); refreshRaster(); });
  on("clock", () => { renderValues(); refreshRaster(); });
  on("lang", () => { renderStrip(); buildDrawer(); buildMarkers(); });
  let route0 = null, spe0 = null;
  on("plan", (pl) => { if (pl.route !== route0 || pl.spe !== spe0) { route0 = pl.route; spe0 = pl.spe; renderValues(); }
    if (pl.turn !== turnPl?.turn || pl.route !== turnPl?.route) { turnPl = pl; drawTurn(); } });
  $("layers-drawer").addEventListener("keydown", (e) => { if (e.key === "Escape") { set("ui", { drawer: false }); $("layers-open")?.focus(); } });
}
