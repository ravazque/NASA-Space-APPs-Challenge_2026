import { state, set, on } from "./store.js";
import { t, num, date, pick, getLang } from "./i18n.js";
import { $ } from "./ui.js";
import { submit } from "./sync.js";
import { planningGrid, dijkstra, shortestPath, pathStats, evaTimeline, stateAt, turnaround, walkbackMask } from "./pathfind.js";
import { PROFILES, passMask, routeEnergy, planPenalty, blockReason, limits } from "./profiles.js";
import { overlay, entryCells, lockCells } from "./effects.js";
import { SOL_S } from "./marsclock.js";

const WEIGHTS = ["energy", "risk", "comms", "radiation", "science"];
const REFUGE_SVF_PERCENTILE = 0.05;
const MARS_HOUR_S = SOL_S / 24;

let ctx, d, rows, cols, cellM, cfg, layers, planLayers, habitat, cheyava, refugeSvf;
let spe = null, speFrom = -1, lastGoal = -1, manualS = 0;
let cache = { key: null }, routeCache = { key: null }, baseEnergy = {}, penalty = {}, forbidPrev = null;

const goalCell = () => { const g = state.doc.settings.goal; return Number.isInteger(g) && g >= 0 && g < rows * cols ? g : cheyava; };
const profileId = () => (PROFILES[state.ui.profile] ? state.ui.profile : "foot");
const speedOf = (p) => PROFILES[p]?.speed_ms ?? cfg.walk_speed_ms;
const walkMin = (m) => m / cfg.walk_speed_ms / 60;
const duration = (min) => { const m = Math.round(min); return m < 60 ? t("dur.m", { m }) : m % 60 === 0 ? t("dur.h", { h: m / 60 }) : t("dur.hm", { h: Math.floor(m / 60), m: m % 60 }); };
const hhmm = (h) => { const m = Math.round(h * 60); return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };

function base(profile) {
  const key = `${profile}|${ctx.extra ? 1 : 0}`;
  if (baseEnergy[key]) return baseEnergy[key];
  const e = Float32Array.from(routeEnergy(profile, layers, ctx.extra ?? null, cellM, cfg)), pass = passMask(profile, layers, ctx.extra ?? null, cfg);
  for (let i = 0; i < e.length; i++) if (!pass[i]) e[i] = Infinity;
  return (baseEnergy[key] = e);
}
const penaltyOf = (profile) => (profile in penalty ? penalty[profile] : (penalty[profile] = planPenalty(profile, layers, ctx.extra ?? null)));
function withBlocks(b, mult) {
  let out = b;
  for (let i = 0; i < mult.length; i++) if (mult[i] === Infinity && b[i] !== Infinity) { if (out === b) out = Float32Array.from(b); out[i] = Infinity; }
  return out;
}
const ovl = (profile) => overlay({
  entries: state.doc.logOrder.map((id) => state.doc.log[id]).filter(Boolean), locks: Object.values(state.doc.locks),
  me: state.ui.me, profile, rows, cols, cellM, nowUtcMs: state.clock.utcMs ?? Date.now(), protect: [habitat, state.plan.at?.cell ?? habitat],
});
function footGrids() {
  const key = [state.doc.log, state.doc.locks, state.ui.me.deviceId, ctx.extra];
  if (cache.key && key.every((v, i) => v === cache.key[i])) return cache;
  const o = ovl("foot"), eFoot = withBlocks(base("foot"), o.mult), home = dijkstra(eFoot, rows, cols, habitat);
  return (cache = { key, mult: o.mult, eFoot, home });
}

function recompute(flags = {}) {
  const prev = state.plan, doc = state.doc, profile = profileId(), goal = goalCell(), W = doc.settings.weights;
  const f = footGrids();
  let eRoute = f.eFoot, mult = f.mult;
  if (profile !== "foot") { const o = ovl(profile); eRoute = withBlocks(base(profile), o.mult); mult = o.mult; }
  const pg = planningGrid(eRoute, planLayers, W), pen = penaltyOf(profile);
  for (let i = 0; i < pg.length; i++) if (pg[i] !== Infinity) pg[i] *= mult[i] * (pen ? pen[i] : 1);
  const route = shortestPath(pg, rows, cols, habitat, goal);
  const stats = route.length ? pathStats(route, eRoute, cols, cellM) : null;
  const tl = evaTimeline(route, eRoute, cols, cellM, { ...cfg, walk_speed_ms: speedOf(profile) });
  const turn = turnaround(tl, f.home.dist[goal], cfg);
  const baseSafe = !route.length ? (eRoute[goal] === Infinity ? "forbidden" : "unreachable") : turn.siteS >= 0 ? "ok" : "no";
  const forbidWhy = baseSafe === "forbidden" ? { reason: blockReason(profile, goal, layers, ctx.extra ?? null, cfg), slope: layers.slope_deg[goal], rough: ctx.extra?.rough_m[goal], lim: limits(profile, ctx.extra ?? null, cfg) } : null;
  const forbid = Uint8Array.from(eRoute, (v) => (v === Infinity ? 1 : 0));
  const same = forbidPrev && forbidPrev.every((v, i) => v === forbid[i]);
  if (!same) forbidPrev = forbid;
  const reroute = flags.overlay && prev.route?.length ? detectReroute(prev, route, stats, mult, flags.prevDoc) : null;
  P = { profile, goal, route, stats, tl, turn, baseSafe, forbidWhy, mult, eFoot: f.eFoot, forbid: forbidPrev, reroute, habitat, cheyava };
  if (goal !== lastGoal) { lastGoal = goal; if (!state.ui.follow) set("ui", { follow: true }); }
  clearSpe(true);
  refresh(true);
  $("reset-goal").hidden = goal === cheyava;
}
let P = {};

function detectReroute(prev, route, stats, mult, prevDoc) {
  const old = prev.mult, hit = prev.route.some((c) => mult[c] > (old?.[c] ?? 1));
  if (!hit) return null;
  const onRoute = new Set(prev.route), crosses = (cells) => cells.some((c) => onRoute.has(c));
  const doc = state.doc, items = [
    ...doc.logOrder.map((id) => doc.log[id]).filter(Boolean).map((e) => ({ type: "log", id: e.id, crew: e.author?.crew, fresh: prevDoc?.log?.[e.id] !== e, cells: entryCells(e) })),
    ...Object.values(doc.locks).map((l) => ({ type: "lock", id: l.target, crew: l.holder?.crew, fresh: prevDoc?.locks?.[l.target] !== l, cells: lockCells(l) })),
  ].filter((it) => crosses(it.cells));
  const c = items.filter((it) => it.fresh).at(-1) ?? items.at(-1);
  return { deltaM: (stats?.lengthM ?? 0) - (prev.stats?.lengthM ?? 0), empty: !route.length, cause: c ? { type: c.type, id: c.id, crew: c.crew } : { type: "log", id: null, crew: null } };
}

function evaSeconds() {
  const dur = cfg.eva_duration_h * 3600, ck = state.clock;
  if (state.ui.follow) {
    if (ck?.utcMs != null && Number.isFinite(ck.ltst)) return Math.min(dur, Math.max(0, (ck.ltst - state.doc.settings.evaStartLtst) * MARS_HOUR_S));
    return P.route?.length ? Math.min(dur, Math.ceil(P.tl.tArr / 300) * 300) : 0;
  }
  return manualS;
}

function refresh(full) {
  if (!P.route) return;
  const evaS = evaSeconds(), f = footGrids(), here = P.tl ? stateAt(evaS, P.tl, P.route, habitat) : { cell: habitat, spent: 0 };
  const envMask = walkbackMask(f.home.dist, cfg.eva_energy_budget_j - here.spent, cfg.return_margin);
  const envInside = envMask.map((v, i) => (v || f.home.dist[i] === Infinity ? 1 : 0));
  const live = evaS <= P.turn.turnS && (cfg.eva_energy_budget_j - here.spent) * (1 - cfg.return_margin) >= f.home.dist[here.cell];
  const storm = state.env?.hazard?.level >= 2;
  const safe = storm ? "storm" : P.baseSafe === "ok" && !live ? "no" : P.baseSafe;
  if (spe && here.cell !== speFrom && !full) buildSpe();
  const el = $("elapsed"); el.value = Math.round(evaS / 60);
  const { eFoot, ...pub } = P;
  set("plan", { ...pub, safe, at: here, evaS, envMask, envInside, homeMin: homeMin(here.cell, f), spe, refuges: spe && spe.refuge !== habitat ? [spe.refuge] : [] });
  renderOutputs(); renderPanels(); renderSpe(); renderFollow();
}
function homeMin(cell, f) {
  if (cell === habitat) return 0;
  if (f.home.dist[cell] === Infinity) return null;
  const path = []; for (let i = cell; i !== -1; i = f.home.prev[i]) path.push(i);
  return walkMin(pathStats(path, f.eFoot, cols, cellM).lengthM);
}

function buildSpe() {
  const from = state.plan.at?.cell ?? habitat, e = footGrids().eFoot, { dist, prev } = dijkstra(e, rows, cols, from);
  let best = habitat, bestD = dist[habitat];
  for (let i = 0; i < dist.length; i++) if (layers.svf[i] <= refugeSvf && dist[i] < bestD) { best = i; bestD = dist[i]; }
  const path = [];
  if (from !== habitat) for (let i = best; i !== -1; i = prev[i]) path.push(i);
  path.reverse();
  speFrom = from;
  spe = { path, refuge: best, kind: from === habitat ? "home" : best === from ? "here" : best === habitat ? "go_home" : "shelter",
    min: walkMin(pathStats(path, e, cols, cellM).lengthM), sky: Math.round((1 - layers.svf[best]) * 100) };
}
function simulateSpe() { if (spe) clearSpe(); else { buildSpe(); } refreshAfterSpe(); }
function clearSpe(silent) { spe = null; speFrom = -1; if (!silent) refreshAfterSpe(); }
function refreshAfterSpe() { if (!P.route) return; set("plan", { spe, refuges: spe && spe.refuge !== habitat ? [spe.refuge] : [] }); renderSpe(); }

const setUse = (svg, id) => { const u = svg.tagName === "use" ? svg : svg.querySelector("use"); id ? u.setAttribute("href", `#${id}`) : u.removeAttribute("href"); };

function renderPanels() {
  const pl = state.plan, st = pl.stats, p = $("safe"), B = cfg?.eva_energy_budget_j, s = pl.safe ?? "pending", spent = pl.at?.spent ?? 0;
  p.dataset.tone = { ok: "safe", pending: "pending" }[s] ?? "danger";
  const [glyph, sym] = s === "ok" ? ["g-return", "s-return"] : s === "pending" ? [null, null] : ["g-prohibit", "s-forbidden"];
  setUse($("safe-t").querySelector("svg"), glyph); setUse(p.querySelector(".symbol svg"), sym);
  $("safe-title").textContent = t(`safe.title.${s}`);
  let value = "—", detail = "", rv = "—", rd = "", ev = "—", ed = "", over = false;
  if (cfg && (s === "ok" || s === "no")) {
    value = t(s === "ok" ? "safe.value.yes" : "safe.value.no");
    const dest = pl.goal === cheyava ? t("label.cheyava") : t("dest.the"), mins = (sec) => Math.floor(sec / 60);
    detail = pl.baseSafe === "no" ? t("safe.detail.short", { arr: duration(pl.tl.tArr / 60), margin: num(cfg.return_margin * 100, 0) })
      : s === "no" ? t("safe.detail.late")
      : t("safe.detail.ok", { arr: duration(pl.tl.tArr / 60), site: duration(mins(pl.turn.siteS)), dest, back: duration(mins(pl.turn.turnS)) });
    rv = t("route.value", { km: num(st.lengthM / 1000, 2) });
    rd = routeDetail(pl, st);
    over = spent > B;
    ev = t("energy.value", { pct: num((100 * spent) / B, 0) });
    ed = t(over ? "energy.detail_over" : "energy.detail", { mj: num(spent / 1e6, 2), budget: num(B / 1e6, 2) });
  } else if (s === "storm") {
    value = t("safe.value.no"); detail = t("safe.detail.storm", { min: pl.homeMin == null ? "—" : duration(pl.homeMin) });
    if (st) { rv = t("route.value", { km: num(st.lengthM / 1000, 2) }); rd = routeDetail(pl, st); }
  } else if (s === "forbidden") { detail = forbiddenText(pl); rd = t("route.none"); }
  else if (s === "unreachable") { detail = t("safe.detail.unreachable"); rd = t("route.none"); }
  $("safe-value").textContent = value; $("safe-detail").textContent = detail;
  $("route-value").textContent = rv; $("route-detail").textContent = rd;
  $("energy-value").textContent = ev; $("energy-detail").textContent = ed;
  $("energy-value").classList.toggle("over", over);
  const ep = $("energy-t").closest(".z535"); ep.dataset.tone = over ? "danger" : "neutral"; setUse($("energy-t").querySelector("svg"), over ? "g-prohibit" : null);
}

const routeDetail = (pl, st) => t(pl.profile === "foot" || !PROFILES[pl.profile] ? "route.detail" : `layers.route.${pl.profile}`, { dur: duration(st.lengthM / speedOf(pl.profile) / 60), speed: num(speedOf(pl.profile), 1) });

function forbiddenText(pl) {
  const w = pl.forbidWhy, why = w?.reason;
  if (pl.profile === "foot" && why === "slope") return t("safe.detail.forbidden", { max: num(cfg.max_slope_deg, 0) });
  if (!w) return t("safe.detail.forbidden", { max: num(cfg.max_slope_deg, 0) });
  if (!why) return t("layers.forbid.overlay");
  return t(`layers.forbid.${why}`, { slope: num(w.slope, 1), max: num(why === "rough" ? w.lim.rough : w.lim.slope, why === "rough" ? 2 : 0), rough: num(w.rough ?? 0, 2) });
}

function renderOutputs() {
  for (const w of WEIGHTS) $(`w-${w}-out`).textContent = num($(`w-${w}`).value, 1);
  const el = $("elapsed"), secs = state.plan.evaS ?? el.value * 60;
  $("elapsed-out").textContent = duration(secs / 60);
  el.setAttribute("aria-valuetext", duration(secs / 60));
}

function renderFollow() {
  const ck = state.clock, before = state.ui.follow && ck?.utcMs != null && Number.isFinite(ck.ltst) && ck.ltst < state.doc.settings.evaStartLtst, n = $("eva-start");
  n.hidden = !before; if (before) n.textContent = t("eva.starts", { ltst: hhmm(state.doc.settings.evaStartLtst) });
  $("eva-follow").hidden = state.ui.follow;
}

function donkiLine() {
  const ts = (d.donki ?? []).map((e) => Date.parse(e.arrivalTime)).filter(Number.isFinite);
  if (!ts.length) return "";
  const f = (ms) => date(new Date(ms).toISOString(), { day: "numeric", month: "short" });
  return t("spe.donki", { n: ts.length, first: f(Math.min(...ts)), last: f(Math.max(...ts)) });
}
function radLine() {
  const r = cfg?.radiation;
  return r ? t("spe.rad", { date: date(r.event_date ?? r.rad_event_date), uGy: num(r.event_dose_uGy ?? r.rad_event_uGy, 0), xr: num(r.event_equiv_chest_xrays ?? r.chest_xray_equiv, 0) }) : "";
}
function renderSpe() {
  const s = spe, b = $("spe"), box = $("spe-body");
  b.setAttribute("aria-pressed", String(!!s));
  $("spe-label").textContent = t(s ? "spe.button_active" : "spe.button");
  $("spe-panel").hidden = !s;
  for (const li of document.querySelectorAll("[data-only=spe]")) li.hidden = !(s?.path.length > 1);
  for (const li of document.querySelectorAll("[data-only=refuge]")) li.hidden = !(s && s.refuge !== habitat);
  if (!s) return box.replaceChildren();
  const line = (cls, text) => { if (!text) return null; const p = document.createElement("p"); p.className = cls; p.textContent = text; return p; };
  const act = { home: "spe.at_home", here: "spe.here", go_home: "spe.go_home", shelter: "spe.go_shelter" }[s.kind];
  box.replaceChildren(...(s.kind === "home" ? [line("spe-act long", state.plan.route?.length ? t(act) : t(act).split(". ")[0] + ".")]
    : [line("spe-act", t(act, { min: num(s.min, 0) })), line("spe-line sky", t("spe.sky", { pct: num(s.sky, 0) })), line("spe-line", donkiLine()), line("spe-line", radLine())]).filter(Boolean));
}

function renderScenario() {
  const el = $("scenario"), meda = d.meda;
  if (!meda) { el.textContent = "EVA · sol 1210 · Jezero"; el.removeAttribute("title"); return; }
  const { start_h: a, end_h: b } = meda.eva_window, hh = (v) => `${String(v).padStart(2, "0")}:00`;
  const air = meda.t_air_c.slice(a, b).filter((v) => v != null);
  const parts = [t("scenario.base", { sol: meda.sol, date: date(meda.date_utc) }), t("scenario.window", { start: hh(a), end: hh(b) })];
  if (air.length) parts.push(t("scenario.air", { min: num(Math.min(...air), 0), max: num(Math.max(...air), 0) }));
  el.textContent = parts.join(" · "); el.title = t("scenario.title");
}

function renderAll() {
  renderOutputs(); renderScenario(); renderPanels(); renderSpe(); renderFollow();
  $("why").hidden = !d.science;
  document.dispatchEvent(new CustomEvent("ariadne:render", { detail: { data: d, t, num, date, pick, getLang } }));
}

export function setGoal(cell) {
  set("ui", { follow: true });
  submit({ t: "set", path: "settings.goal", v: cell === cheyava ? null : cell });
}
export const toggleSpe = simulateSpe;

export async function init(c) {
  ctx = c; d = c.data;
  ({ rows, cols, cellM, layers, cfg, habitat, cheyava } = d);
  planLayers = layers;
  if (layers.viewshed_relay) planLayers = { ...layers, viewshed: layers.viewshed.map((v, i) => Math.max(v, layers.viewshed_relay[i])) };
  const sv = Float32Array.from(layers.svf).sort();
  refugeSvf = sv[Math.floor(sv.length * REFUGE_SVF_PERCENTILE)];
  $("elapsed").max = cfg.eva_duration_h * 60;

  let pending = 0;
  const weightsFromUi = () => Object.fromEntries(WEIGHTS.map((w) => [w, Number($(`w-${w}`).value)]));
  for (const w of WEIGHTS) $(`w-${w}`).addEventListener("input", () => { renderOutputs(); pending ||= requestAnimationFrame(() => { pending = 0; submit({ t: "set", path: "settings.weights", v: weightsFromUi() }); }); });
  $("elapsed").addEventListener("input", (e) => { manualS = e.target.value * 60; set("ui", { follow: false }); clearSpe(true); refresh(true); });
  $("eva-follow").addEventListener("click", () => { set("ui", { follow: true }); refresh(true); });
  $("reset-goal").addEventListener("click", () => setGoal(cheyava));
  $("spe").addEventListener("click", simulateSpe);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && spe && e.target.tagName !== "SELECT") clearSpe(); });

  let seen = { doc: state.doc, goal: goalCell(), w: JSON.stringify(state.doc.settings.weights), start: state.doc.settings.evaStartLtst, profile: profileId(), follow: state.ui.follow };
  const syncSliders = () => { for (const w of WEIGHTS) { const v = state.doc.settings.weights[w], el = $(`w-${w}`); if (Number(el.value) !== v) el.value = v; } };
  on("doc", (doc) => {
    const prevDoc = seen.doc, goal = goalCell(), w = JSON.stringify(doc.settings.weights), overlayChanged = doc.log !== prevDoc.log || doc.locks !== prevDoc.locks;
    const planChanged = goal !== seen.goal || w !== seen.w || overlayChanged;
    seen = { ...seen, doc, goal, w };
    syncSliders();
    if (planChanged) recompute({ overlay: overlayChanged, prevDoc });
    else if (doc.settings.evaStartLtst !== seen.start) { seen.start = doc.settings.evaStartLtst; refresh(); }
  });
  on("ui", () => {
    const profile = profileId(), follow = state.ui.follow;
    if (profile !== seen.profile) { seen.profile = profile; recompute(); }
    else if (follow !== seen.follow) { seen.follow = follow; if (P.route) refresh(); }
  });
  on("clock", () => { if (state.ui.follow && P.route) refresh(); });
  on("env", () => { if (P.route) refresh(); });
  on("extra", () => { cache = { key: null }; baseEnergy = {}; penalty = {}; recompute(); });
  on("lang", renderAll);

  syncSliders();
  recompute();
  renderAll();
}
