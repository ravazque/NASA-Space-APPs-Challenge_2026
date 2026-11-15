import * as store from "./store.js";
import { register, t, num, date, pick, getLang } from "./i18n.js";
import core from "./i18n/core.js";
import { toast, $ } from "./ui.js";
import { initShell, setControls, showCoreError } from "./shell.js";
import { energyGrid } from "./pathfind.js";

const I18N_MODULES = ["map", "layers", "clock", "hub", "log"];
const MODULES = ["sync", "clockui", "map", "plan", "layers", "log", "hubui", "infocard", "dev"];

window.ARIADNE = { store, submit: null, data: null, map: null, t, num, date, pick, getLang };

async function loadJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const error = new Error(`${url}: HTTP ${res.status}`);
    error.file = url.split("/").pop();
    throw error;
  }
  return res.json();
}

const loadOptionalJson = (url) => loadJson(url).catch(() => null);

async function registerLanguageModules() {
  register(core);
  for (const name of I18N_MODULES) {
    try {
      const module = await import(`./i18n/${name}.js`);
      register(module.default);
    } catch (error) {
      console.error(`ARIADNE i18n/${name}:`, error);
    }
  }
}

function loadCoreFiles() {
  return Promise.all([
    loadJson("data/jezero_cost_grid.json"),
    loadJson("data/mission_config.json"),
    loadJson("data/traverse_cells.json"),
  ]);
}

function loadOptionalFiles() {
  return Promise.all([
    loadOptionalJson("data/donki_mars_2024-05.json"),
    loadOptionalJson("data/meda_sol1210.json"),
    loadOptionalJson("data/science.json"),
    loadOptionalJson("data/pov/pov.json"),
    loadOptionalJson("data/validation.json"),
    loadOptionalJson("data/geounits.json"),
    loadOptionalJson("data/credits.json"),
  ]);
}

function isWalkable(cost) {
  return cost !== Infinity;
}

function percentWalkable(cells, energy) {
  const walkable = cells.filter((i) => isWalkable(energy[i]));
  return (100 * walkable.length) / cells.length;
}

function geoUnitInfo(geoLayer, geounits, cols) {
  const stats = new Map();
  for (let i = 0; i < geoLayer.length; i++) {
    const id = geoLayer[i];
    if (!id) continue;
    const entry = stats.get(id) ?? { count: 0, rowSum: 0, colSum: 0, bestDist: Infinity };
    entry.count++;
    entry.rowSum += Math.floor(i / cols);
    entry.colSum += i % cols;
    stats.set(id, entry);
  }
  for (let i = 0; i < geoLayer.length; i++) {
    const id = geoLayer[i];
    if (!id) continue;
    const entry = stats.get(id);
    const rowDiff = Math.floor(i / cols) - entry.rowSum / entry.count;
    const colDiff = (i % cols) - entry.colSum / entry.count;
    const dist = rowDiff ** 2 + colDiff ** 2;
    if (dist < entry.bestDist) {
      entry.bestDist = dist;
      entry.cell = i;
    }
  }
  return geounits
    .filter((unit) => stats.has(unit.id))
    .map((unit) => ({ ...unit, n: stats.get(unit.id).count, cell: stats.get(unit.id).cell }));
}

function buildData(grid, cfg, traverseRC, optional) {
  const [donki, meda, science, pov, validation, geounits, credits] = optional;
  const meta = grid.meta;
  const { rows, cols, cell_m: cellM } = meta;
  const toIndex = ([r, c]) => r * cols + c;

  const layers = {};
  for (const [name, values] of Object.entries(grid.layers)) {
    layers[name] = Float32Array.from(values);
  }
  const habitat = toIndex(meta.sites.three_forks.cell);
  const cheyava = toIndex(meta.sites.cheyava_falls.cell);
  const traverse = traverseRC.map(toIndex);
  const energy = energyGrid(layers, cellM, cfg);
  const traversePct = traverse.length ? percentWalkable(traverse, energy) : NaN;
  const basePct = (100 * energy.filter(isWalkable).length) / energy.length;
  const geoInfo = layers.geo_unit && geounits ? geoUnitInfo(layers.geo_unit, geounits, cols) : [];

  return {
    meta, rows, cols, cellM, layers, cfg, traverse,
    donki, meda, science, pov, validation, geounits, credits,
    habitat, cheyava, traversePct, basePct, geoInfo,
  };
}

async function initModules(data) {
  const ctx = { data, map: null };
  for (const name of MODULES) {
    try {
      const module = await import(`./${name}.js`);
      const result = await module.init(ctx);
      if (name === "sync") window.ARIADNE.submit = module.submit;
      if (name === "map") {
        ctx.map = result;
        window.ARIADNE.map = result;
      }
    } catch (error) {
      console.error(`ARIADNE ${name}:`, error);
      toast(t("err.module", { name }), "danger");
    }
  }
}

async function boot() {
  await registerLanguageModules();
  initShell();
  setControls(false);

  const coreFiles = loadCoreFiles();
  const optionalFiles = loadOptionalFiles();
  let grid;
  let cfg;
  let traverseRC;
  try {
    [grid, cfg, traverseRC] = await coreFiles;
  } catch (error) {
    return showCoreError(error.file ?? error.message);
  }
  const optional = await optionalFiles;

  const data = buildData(grid, cfg, traverseRC, optional);
  store.set("data", data, true);
  window.ARIADNE.data = data;

  await initModules(data);
  setControls(true);
  const goal = store.state.plan.goal;
  $("reset-goal").hidden = goal == null || goal === data.cheyava;
  $("status").hidden = true;
  document.querySelector("main").setAttribute("aria-busy", "false");
  store.emit("lang", getLang());
}

boot().catch((error) => {
  console.error(error);
  showCoreError(error.file ?? error.message);
});
