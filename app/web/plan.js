import { state, set, on } from "./store.js";
import { t, num, date, pick, getLang, shown } from "./i18n.js";
import { $, tag } from "./ui.js";
import { submit } from "./sync.js";
import {
  planningGrid,
  dijkstra,
  shortestPath,
  pathStats,
  evaTimeline,
  stateAt,
  turnaround,
  walkbackMask,
} from "./pathfind.js";
import { PROFILES, passMask, routeEnergy, planPenalty, blockReason, limits } from "./profiles.js";
import { overlay, entryCells, lockCells } from "./effects.js";
import { SOL_S } from "./marsclock.js";

const WEIGHTS = ["energy", "risk", "comms", "radiation", "science"];
const REFUGE_SVF_PERCENTILE = 0.05;
const MARS_HOUR_S = SOL_S / 24;
const WEIGHT_SEND_INTERVAL_MS = 250;
const ELAPSED_STEP_S = 300;

let ctx;
let data;
let rows;
let cols;
let cellM;
let cfg;
let layers;
let planLayers;
let habitat;
let cheyava;
let refugeSvf;

let spe = null;
let speFrom = -1;
let lastGoal = -1;
let manualS = null;

let footCache = { key: null };
let baseEnergyCache = {};
let penaltyCache = {};
let forbidPrev = null;
let current = {};

function extraLayers() {
  return ctx.extra ?? null;
}

function goalCell() {
  const goal = state.doc.settings.goal;
  const valid = Number.isInteger(goal) && goal >= 0 && goal < rows * cols;
  return valid ? goal : cheyava;
}

function profileId() {
  return PROFILES[state.ui.profile] ? state.ui.profile : "foot";
}

function speedOf(profile) {
  return PROFILES[profile]?.speed_ms ?? cfg.walk_speed_ms;
}

function walkMin(meters) {
  return meters / cfg.walk_speed_ms / 60;
}

function duration(minutes) {
  const m = Math.round(minutes);
  if (m < 60) return t("dur.m", { m });
  if (m % 60 === 0) return t("dur.h", { h: m / 60 });
  return t("dur.hm", { h: Math.floor(m / 60), m: m % 60 });
}

function hhmm(hours) {
  const minutes = Math.round(hours * 60);
  const hh = String(Math.floor(minutes / 60) % 24).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function baseEnergy(profile) {
  const key = `${profile}|${extraLayers() ? 1 : 0}`;
  if (baseEnergyCache[key]) return baseEnergyCache[key];

  const energy = Float32Array.from(routeEnergy(profile, layers, extraLayers(), cellM, cfg));
  const passable = passMask(profile, layers, extraLayers(), cfg);
  for (let i = 0; i < energy.length; i++) {
    if (!passable[i]) energy[i] = Infinity;
  }
  baseEnergyCache[key] = energy;
  return energy;
}

function penaltyOf(profile) {
  if (!(profile in penaltyCache)) {
    penaltyCache[profile] = planPenalty(profile, layers, extraLayers());
  }
  return penaltyCache[profile];
}

function withBlocks(energy, multiplier) {
  let out = energy;
  for (let i = 0; i < multiplier.length; i++) {
    if (multiplier[i] !== Infinity || energy[i] === Infinity) continue;
    if (out === energy) out = Float32Array.from(energy);
    out[i] = Infinity;
  }
  return out;
}

function buildOverlay(profile) {
  const doc = state.doc;
  return overlay({
    entries: doc.logOrder.map((id) => doc.log[id]).filter(Boolean),
    locks: Object.values(doc.locks),
    me: state.ui.me,
    profile,
    rows,
    cols,
    cellM,
    nowUtcMs: state.clock.utcMs ?? Date.now(),
    protect: [habitat, state.plan.at?.cell ?? habitat],
  });
}

function footGrids() {
  const key = [state.doc.log, state.doc.locks, state.ui.me.deviceId, ctx.extra];
  if (footCache.key && key.every((value, i) => value === footCache.key[i])) return footCache;

  const blocks = buildOverlay("foot");
  const eFoot = withBlocks(baseEnergy("foot"), blocks.mult);
  const home = dijkstra(eFoot, rows, cols, habitat);
  footCache = { key, mult: blocks.mult, eFoot, home };
  return footCache;
}

function routeStatus(route, energy, goal, turn) {
  if (!route.length) return energy[goal] === Infinity ? "forbidden" : "unreachable";
  return turn.siteS >= 0 ? "ok" : "no";
}

function explainForbidden(profile, goal) {
  return {
    reason: blockReason(profile, goal, layers, extraLayers(), cfg),
    slope: layers.slope_deg[goal],
    rough: ctx.extra?.rough_m[goal],
    lim: limits(profile, extraLayers(), cfg),
  };
}

function recompute(flags = {}) {
  const prev = state.plan;
  const profile = profileId();
  const goal = goalCell();
  const foot = footGrids();

  let eRoute = foot.eFoot;
  let mult = foot.mult;
  if (profile !== "foot") {
    const blocks = buildOverlay(profile);
    eRoute = withBlocks(baseEnergy(profile), blocks.mult);
    mult = blocks.mult;
  }

  const grid = planningGrid(eRoute, planLayers, state.doc.settings.weights);
  const penalty = penaltyOf(profile);
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== Infinity) grid[i] *= mult[i] * (penalty ? penalty[i] : 1);
  }

  const route = shortestPath(grid, rows, cols, habitat, goal);
  const stats = route.length ? pathStats(route, eRoute, cols, cellM) : null;
  const tl = evaTimeline(route, eRoute, cols, cellM, { ...cfg, walk_speed_ms: speedOf(profile) });
  const turn = turnaround(tl, foot.home.dist[goal], cfg);
  const baseSafe = routeStatus(route, eRoute, goal, turn);
  const forbidWhy = baseSafe === "forbidden" ? explainForbidden(profile, goal) : null;

  const forbid = Uint8Array.from(eRoute, (energy) => (energy === Infinity ? 1 : 0));
  const sameForbid = forbidPrev && forbidPrev.every((value, i) => value === forbid[i]);
  if (!sameForbid) forbidPrev = forbid;

  const reroute = flags.overlay && prev.route?.length
    ? detectReroute(prev, route, stats, mult, flags.prevDoc)
    : null;

  current = {
    profile,
    goal,
    route,
    stats,
    tl,
    turn,
    baseSafe,
    forbidWhy,
    mult,
    eFoot: foot.eFoot,
    forbid: forbidPrev,
    reroute,
    habitat,
    cheyava,
  };

  if (goal !== lastGoal) {
    lastGoal = goal;
    manualS = null;
    clearSpe(true);
  } else if (spe) {
    buildSpe();
  }
  refresh(true);
  $("reset-goal").hidden = goal === cheyava;
}

function detectReroute(prev, route, stats, mult, prevDoc) {
  const oldMult = prev.mult;
  const blockedMore = prev.route.some((cell) => mult[cell] > (oldMult?.[cell] ?? 1));
  if (!blockedMore) return null;

  const onRoute = new Set(prev.route);
  const crossesRoute = (cells) => cells.some((cell) => onRoute.has(cell));
  const doc = state.doc;

  const logItems = doc.logOrder
    .map((id) => doc.log[id])
    .filter(Boolean)
    .map((entry) => ({
      type: "log",
      id: entry.id,
      crew: entry.author?.crew,
      fresh: prevDoc?.log?.[entry.id] !== entry,
      cells: entryCells(entry),
    }));
  const lockItems = Object.values(doc.locks).map((lock) => ({
    type: "lock",
    id: lock.target,
    crew: lock.holder?.crew,
    fresh: prevDoc?.locks?.[lock.target] !== lock,
    cells: lockCells(lock),
  }));
  const items = [...logItems, ...lockItems].filter((item) => crossesRoute(item.cells));

  const cause = items.filter((item) => item.fresh).at(-1) ?? items.at(-1);
  return {
    deltaM: (stats?.lengthM ?? 0) - (prev.stats?.lengthM ?? 0),
    empty: !route.length,
    cause: cause
      ? { type: cause.type, id: cause.id, crew: cause.crew }
      : { type: "log", id: null, crew: null },
  };
}

function evaSeconds() {
  const evaDurationS = cfg.eva_duration_h * 3600;
  const clock = state.clock;
  if (state.ui.follow && clock?.utcMs != null && Number.isFinite(clock.ltst)) {
    const elapsedS = (clock.ltst - state.doc.settings.evaStartLtst) * MARS_HOUR_S;
    return Math.min(evaDurationS, Math.max(0, elapsedS));
  }
  if (manualS != null) return manualS;
  if (!current.route?.length) return 0;
  return Math.min(evaDurationS, Math.ceil(current.tl.tArr / ELAPSED_STEP_S) * ELAPSED_STEP_S);
}

function frontierMask(envMask, dist) {
  const out = Uint8Array.from(envMask);
  const known = Uint8Array.from(dist, (d) => (d === Infinity ? 0 : 1));
  const queue = [];
  for (let i = 0; i < known.length; i++) {
    if (known[i]) queue.push(i);
  }
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    const r = (cell / cols) | 0;
    const c = cell % cols;
    const neighbours = [
      c > 0 ? cell - 1 : -1,
      c + 1 < cols ? cell + 1 : -1,
      r > 0 ? cell - cols : -1,
      r + 1 < rows ? cell + cols : -1,
    ];
    for (const next of neighbours) {
      if (next < 0 || known[next]) continue;
      known[next] = 1;
      out[next] = out[cell];
      queue.push(next);
    }
  }
  return out;
}

function refresh(full) {
  if (!current.route) return;

  const evaS = evaSeconds();
  const foot = footGrids();
  const here = current.tl
    ? stateAt(evaS, current.tl, current.route, habitat)
    : { cell: habitat, spent: 0 };
  const remainingJ = cfg.eva_energy_budget_j - here.spent;
  const envMask = walkbackMask(foot.home.dist, remainingJ, cfg.return_margin);
  const envInside = frontierMask(envMask, foot.home.dist);

  const canReturn = remainingJ * (1 - cfg.return_margin) >= foot.home.dist[here.cell];
  const live = evaS <= current.turn.turnS && canReturn;
  const storm = state.env?.hazard?.level >= 2;
  let safe = current.baseSafe;
  if (storm) {
    safe = "storm";
  } else if (current.baseSafe === "ok" && !live) {
    safe = "no";
  }

  if (spe && here.cell !== speFrom && !full) buildSpe();

  const elapsed = $("elapsed");
  elapsed.value = Math.round(evaS / 60);

  const published = { ...current };
  delete published.eFoot;
  set("plan", {
    ...published,
    safe,
    at: here,
    evaS,
    envMask,
    envInside,
    homeMin: homeMin(here.cell, foot),
    spe,
    refuges: refugesOf(spe),
  });
  renderOutputs();
  renderPanels();
  renderSpe();
  renderFollow();
}

function homeMin(cell, foot) {
  if (cell === habitat) return 0;
  if (foot.home.dist[cell] === Infinity) return null;
  const path = [];
  for (let i = cell; i !== -1; i = foot.home.prev[i]) {
    path.push(i);
  }
  return walkMin(pathStats(path, foot.eFoot, cols, cellM).lengthM);
}

function refugesOf(plan) {
  return plan && plan.refuge !== habitat ? [plan.refuge] : [];
}

function buildSpe() {
  const from = state.plan.at?.cell ?? habitat;
  const energy = footGrids().eFoot;
  const { dist, prev } = dijkstra(energy, rows, cols, from);

  let best = habitat;
  let bestDist = dist[habitat];
  for (let i = 0; i < dist.length; i++) {
    if (layers.svf[i] <= refugeSvf && dist[i] < bestDist) {
      best = i;
      bestDist = dist[i];
    }
  }

  const path = [];
  if (from !== habitat) {
    for (let i = best; i !== -1; i = prev[i]) {
      path.push(i);
    }
  }
  path.reverse();

  let kind = "shelter";
  if (from === habitat) {
    kind = "home";
  } else if (best === from) {
    kind = "here";
  } else if (best === habitat) {
    kind = "go_home";
  }

  speFrom = from;
  spe = {
    path,
    refuge: best,
    kind,
    min: walkMin(pathStats(path, energy, cols, cellM).lengthM),
    sky: Math.round((1 - layers.svf[best]) * 100),
  };
}

function simulateSpe() {
  if (spe) {
    clearSpe();
  } else {
    buildSpe();
  }
  refreshAfterSpe();
}

function clearSpe(silent) {
  spe = null;
  speFrom = -1;
  if (!silent) refreshAfterSpe();
}

function refreshAfterSpe() {
  if (!current.route) return;
  set("plan", { spe, refuges: refugesOf(spe) });
  renderSpe();
}

function setUse(svg, id) {
  const use = svg.tagName === "use" ? svg : svg.querySelector("use");
  if (id) {
    use.setAttribute("href", `#${id}`);
  } else {
    use.removeAttribute("href");
  }
}

function routeDetail(plan, stats) {
  const hasProfileKey = plan.profile !== "foot" && PROFILES[plan.profile];
  const key = hasProfileKey ? `layers.route.${plan.profile}` : "route.detail";
  const speed = speedOf(plan.profile);
  return t(key, { dur: duration(stats.lengthM / speed / 60), speed: num(speed, 1) });
}

function forbiddenText(plan) {
  const why = plan.forbidWhy;
  const reason = why?.reason;
  const slopeText = () => t("safe.detail.forbidden", { max: num(cfg.max_slope_deg, 0) });
  if (plan.profile === "foot" && reason === "slope") return slopeText();
  if (!why) return slopeText();
  if (!reason) return t("layers.forbid.overlay");

  const isRough = reason === "rough";
  return t(`layers.forbid.${reason}`, {
    slope: num(why.slope, 1),
    max: num(isRough ? why.lim.rough : why.lim.slope, isRough ? 2 : 0),
    rough: num(why.rough ?? 0, 2),
  });
}

function energyTexts(spent, budget, over) {
  return {
    value: t("energy.value", { pct: num((100 * spent) / budget, 0) }),
    detail: t(over ? "energy.detail_over" : "energy.detail", {
      mj: num(spent / 1e6, 2),
      budget: num(budget / 1e6, 2),
    }),
  };
}

function safeDetail(plan, status) {
  if (plan.baseSafe === "no") {
    return t("safe.detail.short", {
      arr: duration(plan.tl.tArr / 60),
      margin: num(cfg.return_margin * 100, 0),
    });
  }
  if (status === "no") return t("safe.detail.late");

  const dest = plan.goal === cheyava ? t("label.cheyava") : t("dest.the");
  const toMinutes = (seconds) => Math.floor(seconds / 60);
  return t("safe.detail.ok", {
    arr: duration(plan.tl.tArr / 60),
    site: duration(toMinutes(plan.turn.siteS)),
    dest,
    back: duration(toMinutes(plan.turn.turnS)),
  });
}

function stormDetail(detail) {
  const hazard = state.env?.hazard;
  if (!hazard) return detail;
  const line = t("clock.hz.line", { tau: num(hazard.tau, 1), wind: num(hazard.wind_ms, 0) });
  return [`${line}.`, hazard.label ? shown(hazard.label) : "", detail].filter(Boolean).join(" ");
}

function renderPanels() {
  const plan = state.plan;
  const stats = plan.stats;
  const panel = $("safe");
  const budget = cfg?.eva_energy_budget_j;
  const status = plan.safe ?? "pending";
  const spent = plan.at?.spent ?? 0;

  panel.dataset.tone = { ok: "safe", pending: "pending" }[status] ?? "danger";
  let glyph = "g-prohibit";
  let symbol = "s-forbidden";
  if (status === "ok") {
    glyph = "g-return";
    symbol = "s-return";
  } else if (status === "pending") {
    glyph = null;
    symbol = null;
  }
  setUse($("safe-t").querySelector("svg"), glyph);
  setUse(panel.querySelector(".symbol svg"), symbol);
  $("safe-title").textContent = t(`safe.title.${status}`);

  let value = "—";
  let detail = "";
  let routeValue = "—";
  let routeText = "";
  let energyValue = "—";
  let energyText = "";
  let over = false;
  const routeValueOf = () => t("route.value", { km: num(stats.lengthM / 1000, 2) });

  if (cfg && (status === "ok" || status === "no")) {
    value = t(status === "ok" ? "safe.value.yes" : "safe.value.no");
    detail = safeDetail(plan, status);
    routeValue = routeValueOf();
    routeText = routeDetail(plan, stats);
    over = spent > budget;
    const energy = energyTexts(spent, budget, over);
    energyValue = energy.value;
    energyText = energy.detail;
  } else if (status === "storm") {
    value = t("safe.value.no");
    const homeText = plan.homeMin == null ? "—" : duration(plan.homeMin);
    detail = t("safe.detail.storm", { min: homeText });
    if (stats) {
      routeValue = routeValueOf();
      routeText = routeDetail(plan, stats);
      const energy = energyTexts(spent, budget, false);
      energyValue = energy.value;
      energyText = energy.detail;
    }
  } else if (status === "forbidden") {
    detail = forbiddenText(plan);
    routeText = t("route.none");
  } else if (status === "unreachable") {
    detail = t("safe.detail.unreachable");
    routeText = t("route.none");
  }

  const hazard = state.env?.hazard;
  const isStorm = status === "storm" && hazard;
  if (isStorm) detail = stormDetail(detail);
  $("safe-tag").innerHTML = isStorm ? tag(hazard.tag) : "";
  panel.setAttribute("role", status === "storm" ? "alert" : "status");

  $("safe-value").textContent = value;
  $("safe-detail").textContent = detail;
  $("route-value").textContent = routeValue;
  $("route-detail").textContent = routeText;

  if (energyValue === "—" && !energyText) {
    energyText = t(status === "pending" ? "energy.pending" : "energy.none");
  }
  $("energy-value").textContent = energyValue;
  $("energy-detail").textContent = energyText;
  $("energy-value").classList.toggle("over", over);

  const energyPanel = $("energy-t").closest(".z535");
  energyPanel.dataset.tone = over ? "danger" : "neutral";
  setUse($("energy-t").querySelector("svg"), over ? "g-prohibit" : null);
}

function renderOutputs() {
  for (const weight of WEIGHTS) {
    $(`w-${weight}-out`).textContent = num($(`w-${weight}`).value, 1);
  }
  const elapsed = $("elapsed");
  const seconds = state.plan.evaS ?? elapsed.value * 60;
  $("elapsed-out").textContent = duration(seconds / 60);
  elapsed.setAttribute("aria-valuetext", duration(seconds / 60));
}

function renderFollow() {
  const clock = state.clock;
  const clockReady = clock?.utcMs != null && Number.isFinite(clock.ltst);
  const startLtst = state.doc.settings.evaStartLtst;
  const beforeStart = state.ui.follow && clockReady && clock.ltst < startLtst;
  const startNote = $("eva-start");
  startNote.hidden = !beforeStart;
  if (beforeStart) startNote.textContent = t("eva.starts", { ltst: hhmm(startLtst) });
  $("eva-follow").hidden = state.ui.follow;
}

function donkiLine() {
  const arrivals = (data.donki ?? [])
    .map((event) => Date.parse(event.arrivalTime))
    .filter(Number.isFinite);
  if (!arrivals.length) return "";
  const format = (ms) => date(new Date(ms).toISOString(), { day: "numeric", month: "short" });
  return t("spe.donki", {
    n: arrivals.length,
    first: format(Math.min(...arrivals)),
    last: format(Math.max(...arrivals)),
  });
}

function radLine() {
  const radiation = cfg?.radiation;
  if (!radiation) return "";
  return t("spe.rad", {
    date: date(radiation.event_date ?? radiation.rad_event_date),
    uGy: num(radiation.event_dose_uGy ?? radiation.rad_event_uGy, 0),
    xr: num(radiation.event_equiv_chest_xrays ?? radiation.chest_xray_equiv, 0),
  });
}

function speLine(className, text) {
  if (!text) return null;
  const paragraph = document.createElement("p");
  paragraph.className = className;
  paragraph.textContent = text;
  return paragraph;
}

function renderSpe() {
  const body = $("spe-body");
  $("spe").setAttribute("aria-pressed", String(!!spe));
  $("spe-label").textContent = t(spe ? "spe.button_active" : "spe.button");
  $("spe-panel").hidden = !spe;
  for (const item of document.querySelectorAll("[data-only=spe]")) {
    item.hidden = !(spe?.path.length > 1);
  }
  for (const item of document.querySelectorAll("[data-only=refuge]")) {
    item.hidden = !(spe && spe.refuge !== habitat);
  }
  if (!spe) return body.replaceChildren();

  const actKey = {
    home: "spe.at_home",
    here: "spe.here",
    go_home: "spe.go_home",
    shelter: "spe.go_shelter",
  }[spe.kind];

  let lines;
  if (spe.kind === "home") {
    const text = state.plan.route?.length ? t(actKey) : `${t(actKey).split(". ")[0]}.`;
    lines = [speLine("spe-act long", text)];
  } else {
    lines = [
      speLine("spe-act", t(actKey, { min: num(spe.min, 0) })),
      speLine("spe-line sky", t("spe.sky", { pct: num(spe.sky, 0) })),
      speLine("spe-line", donkiLine()),
      speLine("spe-line", radLine()),
    ];
  }
  body.replaceChildren(...lines.filter(Boolean));
}

function renderScenario() {
  const element = $("scenario");
  const meda = data.meda;
  if (!meda) {
    element.textContent = t("scenario.fallback");
    element.removeAttribute("title");
    return;
  }

  const { start_h: startH, end_h: endH } = meda.eva_window;
  const hourText = (hour) => `${String(hour).padStart(2, "0")}:00`;
  const airTemps = meda.t_air_c.slice(startH, endH).filter((temp) => temp != null);
  const parts = [
    t("scenario.base", { sol: meda.sol, date: date(meda.date_utc) }),
    t("scenario.window", { start: hourText(startH), end: hourText(endH) }),
  ];
  if (airTemps.length) {
    parts.push(t("scenario.air", {
      min: num(Math.min(...airTemps), 0),
      max: num(Math.max(...airTemps), 0),
    }));
  }
  element.textContent = parts.join(" · ");
  element.title = t("scenario.title");
}

function renderAll() {
  renderOutputs();
  renderScenario();
  renderPanels();
  renderSpe();
  renderFollow();
  $("why").hidden = !data.science;
  document.dispatchEvent(new CustomEvent("ariadne:render", {
    detail: { data, t, num, date, pick, getLang },
  }));
}

export function setGoal(cell) {
  submit({ t: "set", path: "settings.goal", v: cell === cheyava ? null : cell });
}

export const toggleSpe = simulateSpe;

function bindWeightSliders() {
  let timer = 0;
  let lastSentAt = 0;

  const readWeights = () => {
    return Object.fromEntries(WEIGHTS.map((weight) => [weight, Number($(`w-${weight}`).value)]));
  };

  const flushWeights = () => {
    clearTimeout(timer);
    timer = 0;
    const weights = readWeights();
    if (JSON.stringify(weights) === JSON.stringify(state.doc.settings.weights)) return;
    lastSentAt = performance.now();
    submit({ t: "set", path: "settings.weights", v: weights });
  };

  const onInput = () => {
    renderOutputs();
    const wait = lastSentAt + WEIGHT_SEND_INTERVAL_MS - performance.now();
    if (wait <= 0) {
      flushWeights();
    } else if (!timer) {
      timer = setTimeout(flushWeights, wait);
    }
  };

  for (const weight of WEIGHTS) {
    $(`w-${weight}`).addEventListener("input", onInput);
    $(`w-${weight}`).addEventListener("change", flushWeights);
  }
}

function syncSliders() {
  for (const weight of WEIGHTS) {
    const value = state.doc.settings.weights[weight];
    const slider = $(`w-${weight}`);
    if (Number(slider.value) !== value) slider.value = value;
  }
}

function bindControls() {
  bindWeightSliders();
  $("elapsed").addEventListener("input", (event) => {
    manualS = event.target.value * 60;
    set("ui", { follow: false });
    clearSpe(true);
    refresh(true);
  });
  $("eva-follow").addEventListener("click", () => {
    set("ui", { follow: true });
    refresh(true);
  });
  $("reset-goal").addEventListener("click", () => setGoal(cheyava));
  $("spe").addEventListener("click", simulateSpe);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && spe && event.target.tagName !== "SELECT") clearSpe();
  });
}

function bindStoreEvents() {
  const seen = {
    doc: state.doc,
    goal: goalCell(),
    w: JSON.stringify(state.doc.settings.weights),
    start: state.doc.settings.evaStartLtst,
    profile: profileId(),
    follow: state.ui.follow,
  };

  on("doc", (doc) => {
    const prevDoc = seen.doc;
    const goal = goalCell();
    const weights = JSON.stringify(doc.settings.weights);
    const overlayChanged = doc.log !== prevDoc.log || doc.locks !== prevDoc.locks;
    const planChanged = goal !== seen.goal || weights !== seen.w || overlayChanged;
    seen.doc = doc;
    seen.goal = goal;
    seen.w = weights;
    syncSliders();
    if (planChanged) {
      recompute({ overlay: overlayChanged, prevDoc });
    } else if (doc.settings.evaStartLtst !== seen.start) {
      seen.start = doc.settings.evaStartLtst;
      refresh();
    }
  });

  on("ui", () => {
    const profile = profileId();
    const follow = state.ui.follow;
    if (profile !== seen.profile) {
      seen.profile = profile;
      recompute();
    } else if (follow !== seen.follow) {
      seen.follow = follow;
      if (current.route) refresh();
    }
  });

  on("clock", () => {
    if (state.ui.follow && current.route) refresh();
  });
  on("env", () => {
    if (current.route) refresh();
  });
  on("extra", () => {
    footCache = { key: null };
    baseEnergyCache = {};
    penaltyCache = {};
    recompute();
  });
  on("lang", renderAll);
}

export async function init(c) {
  ctx = c;
  data = c.data;
  ({ rows, cols, cellM, layers, cfg, habitat, cheyava } = data);

  planLayers = layers;
  if (layers.viewshed_relay) {
    const viewshed = layers.viewshed.map((v, i) => Math.max(v, layers.viewshed_relay[i]));
    planLayers = { ...layers, viewshed };
  }

  const sortedSvf = Float32Array.from(layers.svf).sort();
  refugeSvf = sortedSvf[Math.floor(sortedSvf.length * REFUGE_SVF_PERCENTILE)];
  $("elapsed").max = cfg.eva_duration_h * 60;

  bindControls();
  bindStoreEvents();
  syncSliders();
  recompute();
  renderAll();
}
