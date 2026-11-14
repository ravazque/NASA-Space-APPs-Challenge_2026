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
  $("status").textContent = `No se pudieron cargar los datos (${err.message}). Ver README.`;
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

const css = getComputedStyle(document.documentElement);
const tok = (n) => css.getPropertyValue(n).trim();
const rgb = (n) => { const h = tok(n).slice(1); return [0, 2, 4].map((o) => parseInt(h.slice(o, o + 2), 16)); };
const LAYER_RGB = rgb("--layer"), DANGER_RGB = rgb("--danger");
const fmt = (n, d = 1) => n.toLocaleString("es", { minimumFractionDigits: d, maximumFractionDigits: d });

const state = { goal: idx(sites.cheyava_falls.cell), route: [], spe: null, safe: "ok" };

const canvas = $("map");
canvas.width = bg ? bg.width : cols * 4;
canvas.height = bg ? bg.height : rows * 4;
const ctx = canvas.getContext("2d");
const sx = canvas.width / cols, sy = canvas.height / rows;
const layerCanvas = new OffscreenCanvas(cols, rows);
const lctx = layerCanvas.getContext("2d");
$("source").textContent = source;

const weights = () => Object.fromEntries(WEIGHTS.map((w) => [w, Number($(`w-${w}`).value)]));
const walkMinutes = (meters) => meters / cfg.walk_speed_ms / 60;

function validation() {
  const ok = traverse.filter((rc) => energy[idx(rc)] !== Infinity).length;
  return traverse.length ? (100 * ok) / traverse.length : NaN;
}

const clearSpe = () => { state.spe = null; $("spe-info").textContent = ""; };

function recomputeRoute() {
  clearSpe();
  const t0 = performance.now();
  state.route = shortestPath(planningGrid(energy, layers, weights()), rows, cols, habitat, state.goal);
  $("r-ms").textContent = `${fmt(performance.now() - t0, 0)} ms`;
  const { lengthM, energyJ } = pathStats(state.route, energy, cols, cellM);
  const forbidden = energy[state.goal] === Infinity;
  $("r-dist").textContent = state.route.length
    ? `${fmt(lengthM / 1000, 2)}\u00a0km · ${fmt(walkMinutes(lengthM), 0)}\u00a0min`
    : forbidden ? "Sin ruta · pendiente > 18°" : "Sin ruta · inalcanzable";
  $("r-energy").textContent = state.route.length
    ? `${fmt((100 * energyJ) / cfg.eva_energy_budget_j, 0)}\u00a0% batería · ${fmt(energyJ / 1e6, 2)}\u00a0MJ`
    : "—";
  state.safe = !state.route.length ? (forbidden ? "forbidden" : "unreachable")
    : (cfg.eva_energy_budget_j - energyJ) * (1 - cfg.return_margin) >= returnEnergy[state.goal] ? "ok" : "no";
}

function setGoal(i) { state.goal = i; recomputeRoute(); draw(); }

function astronautIdx() {
  const f = $("elapsed").value / 100;
  return Math.min(state.route.length - 1, Math.floor(f * state.route.length));
}
const astronautCell = () => (state.route.length ? state.route[astronautIdx()] : habitat);

function simulateSpe() {
  const from = astronautCell();
  const { dist, prev } = dijkstra(energy, rows, cols, from);
  let best = habitat, bestD = dist[habitat];
  for (let i = 0; i < dist.length; i++) if (layers.svf[i] <= refugeSvf && dist[i] < bestD) { best = i; bestD = dist[i]; }
  const path = [];
  for (let i = best; i !== -1; i = prev[i]) path.push(i);
  state.spe = { path: path.reverse(), refuge: best };
  const ev = spe.find((e) => e.instruments?.some((i) => i.displayName.includes(">100 MeV"))) ?? spe[0];
  const date = ev ? new Date(ev.eventTime).toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" }) : "";
  const sky = `cubre ${Math.round((1 - layers.svf[best]) * 100)} % del cielo`;
  const min = fmt(walkMinutes(pathStats(path, energy, cols, cellM).lengthM), 0);
  const msg = from === habitat ? "Estás en el hábitat: ya a cubierto. Avanza la EVA para simular la alerta en ruta."
    : best === from ? `Ya estás en el abrigo más cercano (${sky}).`
    : `Refugio: ${best === habitat ? "hábitat" : `abrigo topográfico (${sky}, relativo)`} a ${min} min.`;
  $("spe-info").textContent = `${ev ? `Alerta solar simulada · evento SEP real (NASA DONKI, ${date}, medido cerca de la Tierra). ` : ""}${msg}`;
  draw();
}

function cellCenter(i) {
  return [((i % cols) + 0.5) * sx, (Math.floor(i / cols) + 0.5) * sy];
}

function strokePath(cells, color, width, dash, k) {
  if (cells.length < 2) return;
  const trace = (c, w, d) => {
    ctx.beginPath(); ctx.setLineDash(d.map((x) => x * k)); ctx.strokeStyle = c; ctx.lineWidth = w * k;
    cells.forEach((i, n) => (n ? ctx.lineTo(...cellCenter(i)) : ctx.moveTo(...cellCenter(i))));
    ctx.stroke(); ctx.setLineDash([]);
  };
  if (width >= 3) trace(tok("--halo"), width + 2, []);
  trace(color, width, dash);
}

function marker(i, color, label, k) {
  const [x, y] = cellCenter(i);
  ctx.beginPath(); ctx.arc(x, y, 6 * k, 0, 2 * Math.PI);
  ctx.fillStyle = color; ctx.fill();
  ctx.lineWidth = 2 * k; ctx.strokeStyle = tok("--halo"); ctx.stroke();
  ctx.font = `600 ${Math.round(parseFloat(tok("--fs-canvas")) * k)}px system-ui`; const flip = x + 9 * k + ctx.measureText(label).width > canvas.width - 4 * k;
  const lx = flip ? x - 9 * k : x + 9 * k; ctx.textAlign = flip ? "right" : "left";
  ctx.lineWidth = 3 * k; ctx.lineJoin = "round"; ctx.strokeStyle = tok("--halo"); ctx.strokeText(label, lx, y + 4 * k);
  ctx.fillStyle = tok("--text"); ctx.fillText(label, lx, y + 4 * k);
}

function draw() {
  const w = canvas.clientWidth, k = w ? Math.max(1, canvas.width / w) : 1;
  const key = $("layer").value;
  const layer = layers[key] ?? layers.slope_deg;
  let min = Infinity, max = -Infinity;
  for (const v of layer) { if (v < min) min = v; if (v > max) max = v; }
  const walkedJ = state.route.length ? pathStats(state.route.slice(0, astronautIdx() + 1), energy, cols, cellM).energyJ : 0;
  const remainingJ = cfg.eva_energy_budget_j - walkedJ;
  const mask = walkbackMask(returnEnergy, remainingJ, cfg.return_margin);
  const limitJ = remainingJ * (1 - cfg.return_margin) || 1;
  const img = lctx.createImageData(cols, rows);
  const show = key !== "none";
  for (let i = 0; i < layer.length; i++) {
    const g = (layer[i] - min) / (max - min || 1);
    const p = i * 4;
    img.data.set(LAYER_RGB, p); img.data[p + 3] = show ? 20 + 180 * g : 0;
    const soft = Math.max(0, returnEnergy[i] / limitJ - 0.5) * 2;
    if (!mask[i] || soft > 0) { img.data[p] = img.data[p + 1] = img.data[p + 2] = 0; img.data[p + 3] = mask[i] ? 110 * soft : 170; }
    if (energy[i] === Infinity) { img.data.set(DANGER_RGB, p); img.data[p + 3] = 200; }
  }
  lctx.putImageData(img, 0, 0);
  $("layer-scale").textContent = show ? `${fmt(min, 1)}–${fmt(max, 1)} ${$("layer").selectedOptions[0].dataset.unit}`.trim() : "";

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (bg) ctx.drawImage(bg, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(layerCanvas, 0, 0, canvas.width, canvas.height);
  if ($("show-traverse").checked) strokePath(traverse.map(idx), tok("--traverse"), 1.5, [4, 3], k);
  strokePath(state.route, tok("--accent"), 3, [], k);
  if (state.spe) {
    strokePath(state.spe.path, tok("--warn"), 3, [6, 4], k);
    if (state.spe.refuge !== habitat) marker(state.spe.refuge, tok("--warn"), "Refugio", k);
  }
  marker(habitat, tok("--safe"), "Three Forks · hábitat", k);
  const eva = Number($("elapsed").value) > 0 && astronautCell() !== habitat;
  const onGoal = eva && astronautCell() === state.goal;
  if (state.goal !== habitat) marker(state.goal, tok("--accent"), onGoal ? "EVA · destino" : state.goal === idx(sites.cheyava_falls.cell) ? "Cheyava Falls" : "destino", k);
  if (eva && !onGoal) marker(astronautCell(), tok("--info"), "EVA", k);

  $("elapsed-out").textContent = `${$("elapsed").value} %`;
  const safe = { ok: ["Sí", "ok"], no: ["No · falta energía", "bad"], forbidden: ["Prohibido", "bad"], unreachable: ["Sin ruta", "bad"] }[state.safe];
  $("r-reserve").textContent = safe[0];
  $("r-reserve").dataset.state = safe[1];
}

canvas.addEventListener("click", (e) => {
  const rect = canvas.getBoundingClientRect();
  const c = Math.min(cols - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * cols)));
  const r = Math.min(rows - 1, Math.max(0, Math.floor(((e.clientY - rect.top) / rect.height) * rows)));
  setGoal(r * cols + c);
});
canvas.addEventListener("keydown", (e) => {
  const d = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
  if (!d) return;
  const n = e.shiftKey ? 10 : 1;
  const r = Math.min(rows - 1, Math.max(0, Math.floor(state.goal / cols) + d[0] * n));
  const c = Math.min(cols - 1, Math.max(0, (state.goal % cols) + d[1] * n));
  setGoal(r * cols + c);
  e.preventDefault();
});
for (const b of document.querySelectorAll("[data-goal]")) b.addEventListener("click", () => setGoal(idx(sites[b.dataset.goal].cell)));
for (const w of WEIGHTS) {
  const show = () => { $(`w-${w}-out`).textContent = fmt(Number($(`w-${w}`).value), 1); };
  $(`w-${w}`).addEventListener("input", () => { show(); recomputeRoute(); draw(); });
  show();
}
for (const id of ["layer", "show-traverse"]) $(id).addEventListener("change", draw);
$("elapsed").addEventListener("input", () => { clearSpe(); draw(); });
$("spe").addEventListener("click", simulateSpe);

for (const btn of document.querySelectorAll("nav button")) {
  btn.addEventListener("click", () => {
    document.body.className = `mode-${btn.dataset.mode}`;
    for (const b of document.querySelectorAll("nav button")) b.setAttribute("aria-pressed", b === btn);
  });
}

const base = (100 * energy.filter((e) => e !== Infinity).length) / energy.length;
$("r-valid").innerHTML = `${fmt(validation(), 1)} %<small>media AOI ${fmt(base, 1)} %</small>`;
new ResizeObserver(() => draw()).observe(canvas);
recomputeRoute();
draw();
$("status").hidden = true;
