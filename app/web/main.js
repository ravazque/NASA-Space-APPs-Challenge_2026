import * as store from "./store.js";
import { register, t, num, date, pick, getLang } from "./i18n.js";
import core from "./i18n/core.js";
import { toast, $ } from "./ui.js";
import { initShell, setControls, showCoreError } from "./shell.js";
import { energyGrid } from "./pathfind.js";

const I18N_MODULES = ["map", "layers", "clock", "hub", "log"];
const MODULES = ["sync", "clockui", "map", "plan", "layers", "log", "hubui"];

window.ARIADNE = { store, submit: null, data: null, map: null, t, num, date, pick, getLang };

async function loadJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw Object.assign(new Error(`${url}: HTTP ${res.status}`), { file: url.split("/").pop() });
  return res.json();
}
const opt = (url) => loadJson(url).catch(() => null);

async function boot() {
  register(core);
  for (const l of I18N_MODULES) { try { register((await import(`./i18n/${l}.js`)).default); } catch (e) { console.error(`ARIADNE i18n/${l}:`, e); } }
  initShell();
  setControls(false);

  const coreFiles = Promise.all([loadJson("data/jezero_cost_grid.json"), loadJson("data/mission_config.json"), loadJson("data/traverse_cells.json")]);
  const optional = Promise.all([opt("data/donki_mars_2024-05.json"), opt("data/meda_sol1210.json"), opt("data/science.json"), opt("data/pov/pov.json"),
    opt("data/validation.json"), opt("data/geounits.json"), opt("data/credits.json")]);
  let grid, cfg, traverseRC;
  try { [grid, cfg, traverseRC] = await coreFiles; } catch (e) { return showCoreError(e.file ?? e.message); }
  const [donki, meda, science, pov, validation, geounits, credits] = await optional;

  const { rows, cols, cell_m: cellM } = grid.meta, meta = grid.meta, idx = ([r, c]) => r * cols + c;
  const layers = Object.fromEntries(Object.entries(grid.layers).map(([n, v]) => [n, Float32Array.from(v)]));
  const habitat = idx(meta.sites.three_forks.cell), cheyava = idx(meta.sites.cheyava_falls.cell);
  const traverse = traverseRC.map(idx), energy = energyGrid(layers, cellM, cfg), walkable = (e) => e !== Infinity;
  const traversePct = traverse.length ? (100 * traverse.filter((i) => walkable(energy[i])).length) / traverse.length : NaN;
  const basePct = (100 * energy.filter(walkable).length) / energy.length;
  let geoInfo = [];
  if (layers.geo_unit && geounits) {
    const acc = new Map(), g = layers.geo_unit;
    for (let i = 0; i < g.length; i++) if (g[i]) { const a = acc.get(g[i]) ?? { n: 0, r: 0, c: 0, d: Infinity }; a.n++; a.r += (i / cols) | 0; a.c += i % cols; acc.set(g[i], a); }
    for (let i = 0; i < g.length; i++) if (g[i]) { const a = acc.get(g[i]), d = (((i / cols) | 0) - a.r / a.n) ** 2 + ((i % cols) - a.c / a.n) ** 2; if (d < a.d) { a.d = d; a.cell = i; } }
    geoInfo = geounits.filter((u) => acc.has(u.id)).map((u) => ({ ...u, n: acc.get(u.id).n, cell: acc.get(u.id).cell }));
  }
  const data = { meta, rows, cols, cellM, layers, cfg, traverse, donki, meda, science, pov, validation, geounits, credits, habitat, cheyava, traversePct, basePct, geoInfo };
  store.set("data", data, true);
  window.ARIADNE.data = data;

  const ctx = { data, map: null };
  for (const name of MODULES) {
    try {
      const mod = await import(`./${name}.js`), r = await mod.init(ctx);
      if (name === "sync") window.ARIADNE.submit = mod.submit;
      if (name === "map") window.ARIADNE.map = ctx.map = r;
    } catch (e) { console.error(`ARIADNE ${name}:`, e); toast(t("err.module", { name }), "danger"); }
  }
  setControls(true);
  $("reset-goal").hidden = store.state.plan.goal == null || store.state.plan.goal === cheyava;
  $("status").hidden = true;
  document.querySelector("main").setAttribute("aria-busy", "false");
  store.emit("lang", getLang());
}
boot().catch((e) => { console.error(e); showCoreError(e.file ?? e.message); });
