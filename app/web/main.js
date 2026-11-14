import { energyGrid, planningGrid, dijkstra, shortestPath, walkbackMask, pathStats } from "./pathfind.js";

const $ = (id) => document.getElementById(id);
const WEIGHTS = ["energy", "risk", "comms", "radiation", "science"];
const REFUGE_SVF_PERCENTILE = 0.05;

async function loadJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`${src}: no se pudo cargar`));
    img.src = src;
  });
}

const [grid, cfg, traverse, spe, bg] = await Promise.all([
  loadJson("data/jezero_cost_grid.json"),
  loadJson("data/mission_config.json"),
  loadJson("data/traverse_cells.json"),
  loadJson("data/donki_sep_2024-05.json").catch(() => []),
  loadImage("data/ctx_aoi.png").catch(() => null),
]).catch((err) => {
  document.body.textContent = `No se pudieron cargar los datos (${err.message}). Ejecuta pipeline/fetch_data.py y build_grid.py.`;
  throw err;
});

const { rows, cols, cell_m: cellM, source, sites } = grid.meta;
const layers = Object.fromEntries(Object.entries(grid.layers).map(([k, v]) => [k, Float32Array.from(v)]));
const idx = ([r, c]) => r * cols + c;
const habitat = idx(sites.three_forks.cell);
const energy = energyGrid(layers, cellM, cfg);
const returnEnergy = dijkstra(energy, rows, cols, habitat).dist;

const sortedSvf = Float32Array.from(layers.svf).sort();
const refugeSvf = sortedSvf[Math.floor(sortedSvf.length * REFUGE_SVF_PERCENTILE)];

const state = { goal: idx(sites.cheyava_falls.cell), route: [], spe: null };

const canvas = $("map");
canvas.width = bg ? bg.width : cols * 4;
canvas.height = bg ? bg.height : rows * 4;
const ctx = canvas.getContext("2d");
const sx = canvas.width / cols, sy = canvas.height / rows;
const layerCanvas = new OffscreenCanvas(cols, rows);
const lctx = layerCanvas.getContext("2d");
$("source").textContent = `· ${source}`;

const weights = () => Object.fromEntries(WEIGHTS.map((w) => [w, Number($(`w-${w}`).value)]));
const walkMinutes = (meters) => meters / cfg.walk_speed_ms / 60;

function validation() {
  const ok = traverse.filter((rc) => energy[idx(rc)] !== Infinity).length;
  return traverse.length ? (100 * ok) / traverse.length : NaN;
}

function recomputeRoute() {
  const t0 = performance.now();
  state.route = shortestPath(planningGrid(energy, layers, weights()), rows, cols, habitat, state.goal);
  $("r-ms").textContent = `${(performance.now() - t0).toFixed(0)} ms`;
  const { lengthM, energyJ } = pathStats(state.route, energy, cols, cellM);
  $("r-dist").textContent = state.route.length
    ? `${(lengthM / 1000).toFixed(2)} km · ${walkMinutes(lengthM).toFixed(0)} min`
    : "sin ruta";
  $("r-energy").textContent = `${(energyJ / 1e6).toFixed(2)} MJ`;
}

function astronautCell() {
  if (!state.route.length) return habitat;
  const f = $("elapsed").value / 100;
  return state.route[Math.min(state.route.length - 1, Math.floor(f * state.route.length))];
}

function simulateSpe() {
  const from = astronautCell();
  const { dist, prev } = dijkstra(energy, rows, cols, from);
  let best = habitat, bestD = dist[habitat];
  for (let i = 0; i < dist.length; i++) if (layers.svf[i] <= refugeSvf && dist[i] < bestD) { best = i; bestD = dist[i]; }
  const path = [];
  for (let i = best; i !== -1; i = prev[i]) path.push(i);
  state.spe = { path: path.reverse(), refuge: best };
  const ev = spe.find((e) => e.instruments?.some((i) => i.displayName.includes(">100 MeV"))) ?? spe[0];
  $("spe-info").textContent = `${ev ? `Evento SEP real (DONKI) ${ev.sepID}. ` : ""}Refugio ${best === habitat ? "(hábitat)" : `SVF ${layers.svf[best].toFixed(2)}`} a ${walkMinutes(pathStats(path, energy, cols, cellM).lengthM).toFixed(0)} min.`;
  draw();
}

function cellCenter(i) {
  return [((i % cols) + 0.5) * sx, (Math.floor(i / cols) + 0.5) * sy];
}

function strokePath(cells, color, width, dash = []) {
  if (cells.length < 2) return;
  ctx.beginPath(); ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.lineWidth = width;
  cells.forEach((i, n) => (n ? ctx.lineTo(...cellCenter(i)) : ctx.moveTo(...cellCenter(i))));
  ctx.stroke(); ctx.setLineDash([]);
}

function marker(i, color, label) {
  const [x, y] = cellCenter(i);
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 6, 0, 2 * Math.PI); ctx.fill();
  ctx.font = "12px system-ui"; ctx.fillStyle = "#fff"; ctx.fillText(label, x + 9, y + 4);
}

function draw() {
  const key = $("layer").value;
  const layer = layers[key];
  let min = Infinity, max = -Infinity;
  for (const v of layer) { if (v < min) min = v; if (v > max) max = v; }
  const remaining = cfg.eva_energy_budget_j * (1 - $("elapsed").value / 100);
  const mask = walkbackMask(returnEnergy, remaining, cfg.return_margin);
  const img = lctx.createImageData(cols, rows);
  const show = key !== "none";
  for (let i = 0; i < layer.length; i++) {
    const g = (layer[i] - min) / (max - min || 1);
    const p = i * 4;
    img.data[p] = 34; img.data[p + 1] = 211; img.data[p + 2] = 238; img.data[p + 3] = show ? 20 + 180 * g : 0;
    if (!mask[i]) { img.data[p] = img.data[p + 1] = img.data[p + 2] = 0; img.data[p + 3] = 170; }
    if (energy[i] === Infinity) { img.data[p] = 255; img.data[p + 1] = 0; img.data[p + 2] = 0; img.data[p + 3] = 200; }
  }
  lctx.putImageData(img, 0, 0);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (bg) ctx.drawImage(bg, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(layerCanvas, 0, 0, canvas.width, canvas.height);
  if ($("show-traverse").checked) strokePath(traverse.map(idx), "rgba(255,255,255,.7)", 1.5, [4, 3]);
  strokePath(state.route, "#ff7a3d", 3);
  if (state.spe) strokePath(state.spe.path, "#facc15", 3, [6, 4]);
  marker(habitat, "#4ade80", "Three Forks · hábitat");
  marker(state.goal, "#ff7a3d", state.goal === idx(sites.cheyava_falls.cell) ? "Cheyava Falls" : "destino");
  if (Number($("elapsed").value) > 0) marker(astronautCell(), "#60a5fa", "EVA");

  $("elapsed-out").textContent = `${$("elapsed").value}%`;
  $("r-reserve").textContent = mask[state.goal] ? "OK" : "FUERA";
  $("r-reserve").dataset.state = mask[state.goal] ? "ok" : "bad";
}

canvas.addEventListener("click", (e) => {
  const rect = canvas.getBoundingClientRect();
  const c = Math.floor(((e.clientX - rect.left) / rect.width) * cols);
  const r = Math.floor(((e.clientY - rect.top) / rect.height) * rows);
  state.goal = r * cols + c; state.spe = null;
  recomputeRoute(); draw();
});
for (const w of WEIGHTS) $(`w-${w}`).addEventListener("input", () => { recomputeRoute(); draw(); });
for (const id of ["layer", "show-traverse"]) $(id).addEventListener("change", draw);
$("elapsed").addEventListener("input", () => { state.spe = null; draw(); });
$("spe").addEventListener("click", simulateSpe);

for (const btn of document.querySelectorAll("nav button")) {
  btn.addEventListener("click", () => {
    document.body.className = `mode-${btn.dataset.mode}`;
    for (const b of document.querySelectorAll("nav button")) b.setAttribute("aria-pressed", b === btn);
  });
}

$("r-valid").textContent = `${validation().toFixed(1)} %`;
recomputeRoute();
draw();
