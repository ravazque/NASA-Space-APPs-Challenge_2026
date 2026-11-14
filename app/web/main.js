import { energyGrid, planningGrid, dijkstra, shortestPath, walkbackMask, pathStats } from "./pathfind.js";
import { t, num, date, pick, apply, setLang, getLang, has } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const WEIGHTS = ["energy", "risk", "comms", "radiation", "science"];
const REFUGE_SVF_PERCENTILE = 0.05;
const R_MARS = 3396190;
const TAU = 2 * Math.PI;
const css = getComputedStyle(document.documentElement);
const tok = (n) => css.getPropertyValue(n).trim();
const remPx = (v) => parseFloat(v) * parseFloat(css.fontSize);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const mk = (w, h) => new OffscreenCanvas(w, h);
const inkRgb = () => { const h = tok("--ink"); return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const wash = (n) => { const [r, g, b, a] = tok(n).match(/[\d.]+/g).map(Number); return [r, g, b, Math.round(a * 255)]; };

async function loadJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw Object.assign(new Error(`${url}: HTTP ${res.status}`), { file: url.split("/").pop() });
  return res.json();
}
const opt = (url) => loadJson(url).catch(() => null);
const loadImage = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error(src)); i.src = src; });

let rows, cols, cellM, meta, layers, cfg, traverse, donki, meda, science, pov, validation, geounits, credits, bg;
let energy, returnEnergy, planLayers, refugeSvf, habitat, cheyava, trav = [], geoInfo = [], traversePct = NaN, basePct = NaN;
let ready = false, coreErr = null;
const state = { goal: 0, route: [], stats: null, spe: null, safe: "pending" };

const canvas = $("map"), ctx = canvas.getContext("2d");
let k = 1, sx = 1, sy = 1;
let bgCache, hatchCache, geoCache, geoEdges, envCanvas, envPath, layerCanvas, forbidMask;
const unitMasks = new Map(), ranges = {};
const idx = ([r, c]) => r * cols + c;
const weights = () => Object.fromEntries(WEIGHTS.map((w) => [w, Number($(`w-${w}`).value)]));

const PAT = { Aeb: { dots: [4, 0.9] }, NHjf2: { lines: [5, "h"] }, Njf: { lines: [7, "\\"] }, Nue: { lines: [7, "v"] }, cr: { lines: [8, "x"] }, Nnp1: { dots: [9, 1.4] } };
function pattern(spec, kk) {
  const g = (spec.dots ?? spec.lines)[0], T = Math.round(g * kk), c = mk(T, T), x = c.getContext("2d");
  x.fillStyle = x.strokeStyle = `rgba(${inkRgb()},.55)`; x.lineWidth = Math.max(1, Math.round(kk));
  x.beginPath();
  if (spec.dots) { x.arc(T / 2, T / 2, spec.dots[1] * kk, 0, TAU); x.fill(); return x.createPattern(c, "repeat"); }
  const d = spec.lines[1];
  if (d === "h" || d === "x") { x.moveTo(0, T / 2); x.lineTo(T, T / 2); }
  if (d === "v" || d === "x") { x.moveTo(T / 2, 0); x.lineTo(T / 2, T); }
  if (d === "\\") for (const o of [-T, 0, T]) { x.moveTo(o, 0); x.lineTo(o + T, T); }
  x.stroke();
  return x.createPattern(c, "repeat");
}
function hatchPattern() {
  const T = Math.round(6 * k), c = mk(T, T), x = c.getContext("2d");
  x.strokeStyle = tok("--red"); x.lineWidth = 1.5 * k; x.beginPath();
  for (const o of [-T, 0, T]) { x.moveTo(o, T); x.lineTo(o + T, 0); }
  x.stroke();
  return x.createPattern(c, "repeat");
}

function edges(a) {
  const p = new Path2D();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    if (c + 1 < cols && a[i] !== a[i + 1]) { const x = Math.round((c + 1) * sx); p.moveTo(x, Math.round(r * sy)); p.lineTo(x, Math.round((r + 1) * sy)); }
    if (r + 1 < rows && a[i] !== a[i + cols]) { const y = Math.round((r + 1) * sy); p.moveTo(Math.round(c * sx), y); p.lineTo(Math.round((c + 1) * sx), y); }
  }
  return p;
}

function sign(id, cx, cy, size) {
  ctx.save(); ctx.translate(cx - size / 2, cy - size / 2); ctx.scale(size / 48, size / 48);
  for (const el of $(id).children) {
    const st = el.getAttribute("style") || "";
    const col = (p) => { const v = st.match(new RegExp(`${p}:\\s*([^;]+)`))?.[1].trim() ?? el.getAttribute(p); return v?.startsWith("var(") ? tok(v.slice(4, -1)) : v; };
    const f = col("fill"), s = col("stroke"), g = new Path2D();
    if (el.tagName === "rect") g.rect(0, 0, 48, 48);
    else if (el.tagName === "circle") g.arc(+el.getAttribute("cx"), +el.getAttribute("cy"), +el.getAttribute("r"), 0, TAU);
    else g.addPath(new Path2D(el.getAttribute("d")));
    if (f && f !== "none") { ctx.fillStyle = f; ctx.fill(g); }
    if (s) { ctx.strokeStyle = s; ctx.lineWidth = +el.getAttribute("stroke-width") || 1; ctx.stroke(g); }
  }
  ctx.restore();
}

const walkMin = (m) => m / cfg.walk_speed_ms / 60;
const duration = (min) => { const m = Math.round(min); return m < 60 ? t("dur.m", { m }) : t("dur.hm", { h: Math.floor(m / 60), m: m % 60 }); };
function astronautIdx() {
  const f = $("elapsed").value / 100;
  return Math.min(state.route.length - 1, Math.floor(f * state.route.length));
}
const astronautCell = () => (state.route.length ? state.route[astronautIdx()] : habitat);

function updateEnv() {
  const walked = state.route.length ? pathStats(state.route.slice(0, astronautIdx() + 1), energy, cols, cellM).energyJ : 0;
  const envMask = walkbackMask(returnEnergy, cfg.eva_energy_budget_j - walked, cfg.return_margin);
  const [r, g, b, a] = wash("--wash-outside"), id = new ImageData(cols, rows);
  for (let i = 0; i < envMask.length; i++) if (!envMask[i]) id.data.set([r, g, b, a], i * 4);
  envCanvas ??= mk(cols, rows);
  envCanvas.getContext("2d").putImageData(id, 0, 0);
  envPath = edges(envMask);
}

function recompute() {
  state.route = shortestPath(planningGrid(energy, planLayers, weights()), rows, cols, habitat, state.goal);
  state.stats = state.route.length ? pathStats(state.route, energy, cols, cellM) : null;
  state.safe = !state.route.length ? (energy[state.goal] === Infinity ? "forbidden" : "unreachable")
    : (cfg.eva_energy_budget_j - state.stats.energyJ) * (1 - cfg.return_margin) >= returnEnergy[state.goal] ? "ok" : "no";
  clearSpe(); updateEnv(); renderPanels(); draw();
}
function setGoal(i) { state.goal = i; $("reset-goal").disabled = i === cheyava; recompute(); }

function simulateSpe() {
  if (state.spe) { clearSpe(); draw(); return; }
  const from = astronautCell(), { dist, prev } = dijkstra(energy, rows, cols, from);
  let best = habitat, bestD = dist[habitat];
  for (let i = 0; i < dist.length; i++) if (layers.svf[i] <= refugeSvf && dist[i] < bestD) { best = i; bestD = dist[i]; }
  const path = [];
  if (from !== habitat) for (let i = best; i !== -1; i = prev[i]) path.push(i);
  path.reverse();
  state.spe = { path, refuge: best, kind: from === habitat ? "home" : best === from ? "here" : best === habitat ? "go_home" : "shelter",
    min: walkMin(pathStats(path, energy, cols, cellM).lengthM), sky: Math.round((1 - layers.svf[best]) * 100) };
  renderSpe(); draw();
}
function clearSpe() { state.spe = null; renderSpe(); }

const setUse = (svg, id) => { const u = svg.tagName === "use" ? svg : svg.querySelector("use"); id ? u.setAttribute("href", `#${id}`) : u.removeAttribute("href"); };

function renderPanels() {
  const s = state.safe, st = state.stats, p = $("safe");
  p.dataset.tone = { ok: "safe", pending: "pending" }[s] ?? "danger";
  const [glyph, sym] = s === "ok" ? ["g-return", "s-return"] : s === "pending" ? [null, null] : ["g-prohibit", "s-forbidden"];
  setUse($("safe-t").querySelector("svg"), glyph); setUse(p.querySelector(".symbol svg"), sym);
  $("safe-title").textContent = t(`safe.title.${s}`);
  let value = "—", detail = "", rv = "—", rd = "", ev = "—", ed = "";
  if (cfg && (s === "ok" || s === "no")) {
    const B = cfg.eva_energy_budget_j, E = st.energyJ;
    value = t(s === "ok" ? "safe.value.yes" : "safe.value.no");
    detail = t("safe.detail.ok", { left: num(Math.max(0, (100 * (B - E)) / B), 0), need: num((100 * returnEnergy[state.goal]) / (B * (1 - cfg.return_margin)), 0), margin: num(cfg.return_margin * 100, 0) });
    rv = t("route.value", { km: num(st.lengthM / 1000, 2) });
    rd = t("route.detail", { dur: duration(walkMin(st.lengthM)), speed: num(cfg.walk_speed_ms, 1) });
    ev = t("energy.value", { pct: num((100 * E) / B, 0) });
    ed = t("energy.detail", { mj: num(E / 1e6, 2), budget: num(B / 1e6, 2) });
  } else if (s === "forbidden") { detail = t("safe.detail.forbidden", { max: num(cfg.max_slope_deg, 0) }); rd = t("route.none"); }
  else if (s === "unreachable") { detail = t("safe.detail.unreachable"); rd = t("route.none"); }
  $("safe-value").textContent = value; $("safe-detail").textContent = detail;
  $("route-value").textContent = rv; $("route-detail").textContent = rd;
  $("energy-value").textContent = ev; $("energy-detail").textContent = ed;
}

function renderOutputs() {
  for (const w of WEIGHTS) $(`w-${w}-out`).textContent = num($(`w-${w}`).value, 1);
  $("elapsed-out").textContent = t("eva.value", { pct: num($("elapsed").value, 0) });
}

function donkiLine() {
  const ts = (donki ?? []).map((e) => Date.parse(e.arrivalTime)).filter(Number.isFinite);
  if (!ts.length) return "";
  const d = (ms) => date(new Date(ms).toISOString(), { day: "numeric", month: "short" });
  return t("spe.donki", { n: ts.length, first: d(Math.min(...ts)), last: d(Math.max(...ts)) });
}
function radLine() {
  const r = cfg?.radiation;
  return r ? t("spe.rad", { date: date(r.event_date ?? r.rad_event_date), uGy: num(r.event_dose_uGy ?? r.rad_event_uGy, 0), xr: num(r.event_equiv_chest_xrays ?? r.chest_xray_equiv, 0) }) : "";
}
function renderSpe() {
  const s = state.spe, b = $("spe"), box = $("spe-body");
  b.setAttribute("aria-pressed", String(!!s));
  $("spe-panel").hidden = !s;
  for (const li of document.querySelectorAll("[data-only=spe]")) li.hidden = !s;
  if (!s) return box.replaceChildren();
  const line = (cls, text) => { if (!text) return null; const p = document.createElement("p"); p.className = cls; p.textContent = text; return p; };
  const act = { home: "spe.at_home", here: "spe.here", go_home: "spe.go_home", shelter: "spe.go_shelter" }[s.kind];
  box.replaceChildren(...(s.kind === "home" ? [line("spe-act long", state.route.length ? t(act) : t(act).split(". ")[0] + ".")]
    : [line("spe-act", t(act, { min: num(s.min, 0) })), line("spe-line sky", t("spe.sky", { pct: num(s.sky, 0) })), line("spe-line", donkiLine()), line("spe-line", radLine())]).filter(Boolean));
}

function renderLegend() {
  for (const el of document.querySelectorAll("[data-lg]")) el.textContent = t(`legend.${el.dataset.lg}`, { max: num(cfg?.max_slope_deg ?? 18, 0) });
  for (const li of document.querySelectorAll("[data-only=traverse]")) li.hidden = !$("show-traverse").checked;
}

const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const sws = (alphas) => `<span class="sws">${alphas.map((a) => `<i style="--a:${a}"></i>`).join("")}</span>`;
function rangeOf(key) {
  if (!ranges[key]) { let lo = Infinity, hi = -Infinity; for (const v of layers[key]) { if (v < lo) lo = v; if (v > hi) hi = v; } ranges[key] = [lo, hi]; }
  return ranges[key];
}
function geoSwatch(u) {
  const c = h("canvas", "sw-geo"), d = devicePixelRatio || 1;
  c.width = Math.round(remPx("1.5rem") * d); c.height = Math.round(remPx("1rem") * d);
  if (PAT[u.symbol]) { const x = c.getContext("2d"); x.fillStyle = pattern(PAT[u.symbol], d); x.fillRect(0, 0, c.width, c.height); }
  return c;
}
function renderLayerLegend() {
  const key = $("layer").value, box = $("layer-legend");
  box.replaceChildren();
  if (!ready || key === "none") return;
  if (key === "viewshed") {
    const r = meta.relay;
    box.append(h("span", "grp", `${sws([0])} ${esc(t("comms.direct"))}`));
    if (r) box.append(h("span", "grp", `${sws([0.18])} ${esc(t("comms.relay"))}`));
    box.append(h("span", "grp", `${sws([0.5])} ${esc(t("comms.none"))}`));
    if (r) {
      box.append(h("span", "", esc(t("comms.coverage", { before: num(r.coverage_before_pct, 0), after: num(r.coverage_after_pct, 0) }))));
      box.append(h("span", "grp", `<svg class="sign" viewBox="0 0 48 48" aria-hidden="true"><use href="#s-relay"/></svg>${esc(t("comms.relay_note"))}`));
    }
  } else if (key === "geo_unit") {
    for (const u of geoInfo) { const row = h("span", "geo-row"); row.append(geoSwatch(u), h("b", "", esc(u.symbol)), h("span", "", esc(pick(u, "plain")))); box.append(row); }
    box.append(h("span", "note", esc(t("geo.note"))));
  } else {
    const [lo, hi] = rangeOf(key), unit = $("layer").selectedOptions[0].dataset.unit, d = key === "elevation_m" || key === "thermal_inertia_si" ? 0 : 1;
    const u = unit ? (unit === "°" ? unit : ` ${unit}`) : "";
    box.append(h("span", "grp", `${esc(t("layer.less"))} ${num(lo, d)} ${sws([0, 0.14, 0.28, 0.42, 0.56])} ${num(hi, d)}${esc(u)} ${esc(t("layer.more"))}`));
    if (key === "svf") box.append(h("span", "", esc(t("layer.svf_note"))));
  }
}

function renderScenario() {
  const el = $("scenario");
  if (!meda) { el.textContent = "EVA · sol 1210 · Jezero"; el.removeAttribute("title"); return; }
  const { start_h: a, end_h: b } = meda.eva_window, hh = (v) => `${String(v).padStart(2, "0")}:00`;
  const air = meda.t_air_c.slice(a, b).filter((v) => v != null);
  const parts = [t("scenario.base", { sol: meda.sol, date: date(meda.date_utc) }), t("scenario.window", { start: hh(a), end: hh(b) })];
  if (air.length) parts.push(t("scenario.air", { min: num(Math.min(...air), 0), max: num(Math.max(...air), 0) }));
  el.textContent = parts.join(" · "); el.title = t("scenario.title");
}

function renderFooter() {
  const items = credits ? (Array.isArray(credits) ? credits : credits.items) : null;
  const link = (u, txt) => (/^https?:/.test(u ?? "") ? `<a href="${esc(u)}">${esc(txt)}</a>` : esc(txt));
  const data = items ? items.map((i) => `${esc(has(`cr.${i.id}`) ? t(`cr.${i.id}`) : pick(i, "what"))}: ${link(i.url, i.credit)}`) : [esc(t("foot.fallback"))];
  if (items && meda && !items.some((i) => i.id === "meda")) data.push(esc(meda.credit));
  $("credits").innerHTML = `<p>${esc(t("foot.data"))}: ${data.join(" · ")}</p><p>${["foot.photos", "foot.font", "foot.nominal", "foot.disclaimer"].map((x) => esc(t(x))).join(" ")}</p>`;
}

const renderHint = () => { $("hint").textContent = `${bg || !ready ? "" : `${t("map.nobg")} `}${t("map.hint")}`; };

function renderAll() {
  renderHint(); renderOutputs(); renderLegend(); renderScenario(); renderFooter();
  if (coreErr) $("err-body").textContent = t("err.core", { file: coreErr });
  if (!ready) return renderPanels();
  renderPanels(); renderSpe(); renderLayerLegend(); draw();
  window.ARIADNE = { data: { science, pov, validation, meda, credits, cfg, meta, traversePct, basePct }, t, num, date, pick, getLang };
  document.dispatchEvent(new CustomEvent("ariadne:render", { detail: window.ARIADNE }));
  $("why").hidden = !science;
}
const onLang = () => { apply(); renderAll(); };

function buildLayer() {
  const key = $("layer").value, id = new ImageData(cols, rows), I = inkRgb();
  layerCanvas ??= mk(cols, rows);
  if (key === "viewshed") {
    const V = layers.viewshed, Rl = layers.viewshed_relay;
    for (let i = 0; i < V.length; i++) id.data.set([...I, V[i] > 0.5 ? 0 : Rl?.[i] > 0.5 ? 46 : 128], i * 4);
  } else if (key !== "none" && key !== "geo_unit") {
    const [lo, hi] = rangeOf(key), L = layers[key], A = [0, 36, 72, 107, 143];
    for (let i = 0; i < L.length; i++) id.data.set([...I, A[Math.min(4, Math.floor((5 * (L[i] - lo)) / (hi - lo || 1)))]], i * 4);
  }
  layerCanvas.getContext("2d").putImageData(id, 0, 0);
}
const unitMask = (u) => {
  if (!unitMasks.has(u)) {
    const m = mk(cols, rows), id = new ImageData(cols, rows);
    for (let i = 0; i < layers.geo_unit.length; i++) if (layers.geo_unit[i] === u) id.data[i * 4 + 3] = 255;
    m.getContext("2d").putImageData(id, 0, 0); unitMasks.set(u, m);
  }
  return unitMasks.get(u);
};
function buildGeo() {
  if (geoCache) return;
  const W = canvas.width, H = canvas.height, s = mk(W, H), sc = s.getContext("2d");
  geoCache = mk(W, H); sc.imageSmoothingEnabled = false;
  for (const u of geoInfo) {
    if (!PAT[u.symbol]) continue;
    sc.globalCompositeOperation = "source-over"; sc.clearRect(0, 0, W, H); sc.drawImage(unitMask(u.id), 0, 0, W, H);
    sc.globalCompositeOperation = "source-in"; sc.fillStyle = pattern(PAT[u.symbol], k); sc.fillRect(0, 0, W, H);
    geoCache.getContext("2d").drawImage(s, 0, 0);
  }
  geoEdges = edges(layers.geo_unit);
}

function rebuildStatic() {
  const W = canvas.width, H = canvas.height;
  bgCache = mk(W, H);
  const b = bgCache.getContext("2d");
  b.fillStyle = tok("--ground-2"); b.fillRect(0, 0, W, H);
  if (bg) { b.imageSmoothingQuality = "high"; b.drawImage(bg, 0, 0, W, H); }
  hatchCache = mk(W, H);
  const hx = hatchCache.getContext("2d"), l = mk(W, H), lx = l.getContext("2d");
  hx.imageSmoothingEnabled = lx.imageSmoothingEnabled = false;
  hx.drawImage(forbidMask, 0, 0, W, H); hx.globalCompositeOperation = "source-in"; hx.fillStyle = tok("--wash-forbid"); hx.fillRect(0, 0, W, H);
  lx.fillStyle = hatchPattern(); lx.fillRect(0, 0, W, H); lx.globalCompositeOperation = "destination-in"; lx.drawImage(forbidMask, 0, 0, W, H);
  hx.globalCompositeOperation = "source-over"; hx.drawImage(l, 0, 0);
  geoCache = null;
  updateEnv();
}
function resize() {
  const w = canvas.clientWidth;
  if (!ready || !w) return;
  k = devicePixelRatio || 1;
  const W = Math.round(w * k), H = Math.round((w * rows * k) / cols);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  sx = W / cols; sy = H / rows;
  rebuildStatic(); draw();
}

function graticule() {
  const [left, top] = meta.origin_m, deg = (m) => ((m / R_MARS) * 180) / Math.PI, rad = (d) => (d * Math.PI) / 180 * R_MARS;
  const lon = [], lat = [];
  for (let v = Math.ceil(deg(left) * 100) / 100; v <= deg(left + cols * cellM); v = Math.round((v + 0.01) * 100) / 100) lon.push([v, (rad(v) - left) / cellM]);
  for (let v = Math.ceil(deg(top - rows * cellM) * 100) / 100; v <= deg(top); v = Math.round((v + 0.01) * 100) / 100) lat.push([v, (top - rad(v)) / cellM]);
  return { lon, lat };
}
let grat;

function draw() {
  if (!ready || !bgCache) return;
  const W = canvas.width, H = canvas.height, key = $("layer").value, Wc = W / k, Hc = H / k;
  const ink = tok("--ink"), ground = tok("--ground"), surface = tok("--surface"), blue = tok("--blue"), FS = remPx(tok("--t-canvas")), FONT = tok("--font");
  const labels = [], font = (w, s) => `${w} ${s}px ${FONT}`;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bgCache, 0, 0);
  if (key !== "none") {
    ctx.fillStyle = tok("--wash-layer"); ctx.fillRect(0, 0, W, H);
    if (key === "geo_unit") {
      buildGeo(); ctx.drawImage(geoCache, 0, 0);
      ctx.save(); if (Math.round(k) % 2) ctx.translate(0.5, 0.5); ctx.strokeStyle = ink; ctx.lineWidth = k; ctx.stroke(geoEdges); ctx.restore();
    } else ctx.drawImage(layerCanvas, 0, 0, W, H);
  }
  ctx.strokeStyle = `rgba(${inkRgb()},.22)`; ctx.lineWidth = 1; ctx.beginPath();
  for (const [, c] of grat.lon) { const x = Math.round(c * sx) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (const [, r] of grat.lat) { const y = Math.round(r * sy) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();
  ctx.drawImage(envCanvas, 0, 0, W, H); ctx.drawImage(hatchCache, 0, 0);
  ctx.lineCap = "square"; ctx.lineJoin = "miter";
  ctx.strokeStyle = ground; ctx.lineWidth = 5.5 * k; ctx.stroke(envPath);
  ctx.strokeStyle = tok("--green"); ctx.lineWidth = 2.5 * k; ctx.stroke(envPath);

  ctx.setTransform(k, 0, 0, k, 0, 0);
  const P = (i) => [((i % cols) + 0.5) * sx / k, (((i / cols) | 0) + 0.5) * sy / k];
  const trace = (cells, color, w, dash) => {
    ctx.beginPath(); ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.lineWidth = w;
    cells.forEach((i, n) => { const [x, y] = P(i); n ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke(); ctx.setLineDash([]);
  };
  const box = (x, y, s, c) => { ctx.fillStyle = c; ctx.fillRect(x - s / 2, y - s / 2, s, s); };
  const dot = (x, y, r, c) => { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = c; ctx.fill(); };
  const mark = (text, x, y) => {
    ctx.font = font(600, FS);
    const flip = x + 11 + ctx.measureText(text).width > Wc - 4;
    labels.push({ text, x: flip ? x - 11 : x + 11, y, a: flip ? "right" : "left", w: 600, s: FS });
  };
  ctx.lineJoin = "round";
  if ($("show-traverse").checked && trav.length > 1) { ctx.lineCap = "butt"; trace(trav, ground, 3.5, []); trace(trav, ink, 1.5, [5, 4]); }
  ctx.lineCap = "round";
  if (state.route.length > 1) { trace(state.route, ground, 7, []); trace(state.route, blue, 4, []); }
  if (state.spe?.path.length > 1) { ctx.lineCap = "butt"; trace(state.spe.path, ink, 6, []); trace(state.spe.path, tok("--yellow"), 4, [8, 6]); }
  if (key === "viewshed" && meta.relay) { const [x, y] = P(idx(meta.relay.cell)); box(x, y, 18, ground); sign("s-relay", x, y, 16); mark(t("label.relay"), x, y); }
  if (state.spe && state.spe.refuge !== habitat && state.spe.path.length) { const [x, y] = P(state.spe.refuge); box(x, y, 22, ground); sign("s-refuge", x, y, 18); mark(t("label.refuge"), x, y); }
  { const [x, y] = P(habitat); box(x, y, 18, ground); box(x, y, 14, ink); box(x, y, 4, ground); mark(t("label.start"), x, y); }
  const eva = Number($("elapsed").value) > 0 && astronautCell() !== habitat, onGoal = eva && astronautCell() === state.goal;
  if (state.goal !== habitat) {
    const [x, y] = P(state.goal);
    dot(x, y, 10, ground); dot(x, y, 8, blue); dot(x, y, 2, surface);
    if (state.safe === "forbidden") { ctx.beginPath(); ctx.arc(x, y, 11, 0, TAU); ctx.strokeStyle = tok("--red"); ctx.lineWidth = 2; ctx.stroke(); }
    mark(t(onGoal ? "label.eva_dest" : state.goal === cheyava ? "label.cheyava" : "label.dest"), x, y);
  }
  if (eva && !onGoal) { const [x, y] = P(astronautCell()); dot(x, y, 8.75, ground); dot(x, y, 7.25, ink); dot(x, y, 4.75, surface); mark(t("label.eva"), x, y); }
  if (key === "geo_unit") for (const u of geoInfo) if (u.n >= 150) { const [x, y] = P(u.cell); labels.push({ text: u.symbol, x, y, a: "center", w: 600, s: 12 }); }
  for (const [v, c] of grat.lon) if (Math.round(v * 100) % 2 === 0 && c * sx / k > 24 && c * sx / k < Wc - 24) labels.push({ text: t("grat.lon", { v: num(v, 2) }), x: c * sx / k, y: 14, a: "center", w: 400, s: FS });
  for (const [v, r] of grat.lat) if (Math.round(v * 100) % 2 === 0 && r * sy / k > 24 && r * sy / k < Hc - 60) labels.push({ text: t("grat.lat", { v: num(v, 2) }), x: 6, y: r * sy / k, a: "left", w: 400, s: FS });
  ctx.textBaseline = "middle"; ctx.lineJoin = "round"; ctx.setLineDash([]);
  for (const l of labels) {
    ctx.font = font(l.w, l.s); ctx.textAlign = l.a; ctx.lineWidth = 3.5; ctx.strokeStyle = tok("--halo"); ctx.strokeText(l.text, l.x, l.y);
    ctx.fillStyle = ink; ctx.fillText(l.text, l.x, l.y);
  }
  scaleBox(Hc, ink, ground, font);
}

function scaleBox(Hc, ink, ground, font) {
  const cw = sx / k, L = [25, 50, 100].find((n) => n * cw >= 90) ?? 100, bar = L * cw, pad = 6, hair = 1 / k, snap = (v) => Math.round(v * k) / k;
  ctx.font = font(400, 12);
  const end = `${L * 20} m`, w = Math.max(bar + ctx.measureText(end).width / 2, ctx.measureText(t("scale.cell")).width);
  const bw = pad * 2 + w + 22, bh = pad * 2 + 6 + 4 + 14 + 16, x0 = 12, y0 = snap(Hc - 12 - bh), bx = x0 + pad, by = y0 + pad;
  ctx.fillStyle = ground; ctx.fillRect(x0, y0, bw, bh);
  ctx.strokeStyle = ink; ctx.lineWidth = hair; ctx.strokeRect(x0 + hair / 2, y0 + hair / 2, bw - hair, bh - hair);
  for (let s = 0; s < L / 5; s++) { ctx.fillStyle = s % 2 ? ground : ink; ctx.fillRect(bx + s * 5 * cw, by, 5 * cw, 6); }
  ctx.strokeRect(snap(bx) + hair / 2, by + hair / 2, bar, 6 - hair);
  ctx.beginPath();
  for (let c = 0; c <= L; c += cw >= 3 ? 1 : 5) { const x = snap(bx + c * cw) + hair / 2; ctx.moveTo(x, by + 6); ctx.lineTo(x, by + 10); }
  ctx.stroke();
  ctx.fillStyle = ink; ctx.textBaseline = "middle"; ctx.textAlign = "center";
  const ly = by + 10 + 8;
  ctx.fillText("0", bx, ly); ctx.fillText(end, bx + bar, ly);
  if (5 * cw >= 30) ctx.fillText("100", bx + 5 * cw, ly);
  ctx.textAlign = "left"; ctx.fillText(t("scale.cell"), bx, ly + 16);
  const ax = x0 + bw - pad - 6;
  ctx.beginPath(); ctx.moveTo(ax, by); ctx.lineTo(ax + 4, by + 12); ctx.lineTo(ax - 4, by + 12); ctx.closePath(); ctx.fill();
  ctx.font = font(700, 12); ctx.textAlign = "center"; ctx.fillText(t("scale.north"), ax, by + 22);
}

const controls = () => document.querySelectorAll(".side-col input, .side-col button, .map-strip input, .map-strip select, #reset-goal");
function showCoreError(file) {
  coreErr = file; $("why").hidden = true; $("status").hidden = true; $("map-error").hidden = false;
  $("err-body").textContent = t("err.core", { file });
  document.querySelector("main").setAttribute("aria-busy", "false");
  console.error(`ARIADNE: core data failed to load (${file})`);
}

async function boot() {
  apply();
  for (const b of document.querySelectorAll("[data-lang]")) b.addEventListener("click", () => setLang(b.dataset.lang, onLang));
  for (const c of controls()) c.disabled = true;
  renderAll();
  const core = Promise.all([loadJson("data/jezero_cost_grid.json"), loadJson("data/mission_config.json"), loadJson("data/traverse_cells.json")]);
  const optional = Promise.all([opt("data/donki_mars_2024-05.json"), opt("data/meda_sol1210.json"), opt("data/science.json"), opt("data/pov/pov.json"),
    opt("data/validation.json"), opt("data/geounits.json"), opt("data/credits.json"),
    loadImage("data/hirise_aoi.webp").catch(() => null),
    document.fonts.load("600 14px Barlow").catch(() => 0), document.fonts.load("400 12px Barlow").catch(() => 0)]);
  let grid;
  try { [grid, cfg, traverse] = await core; } catch (e) { return showCoreError(e.file ?? e.message); }
  [donki, meda, science, pov, validation, geounits, credits, bg] = await optional;

  ({ rows, cols, cell_m: cellM } = grid.meta); meta = grid.meta;
  layers = Object.fromEntries(Object.entries(grid.layers).map(([n, v]) => [n, Float32Array.from(v)]));
  habitat = idx(meta.sites.three_forks.cell); cheyava = idx(meta.sites.cheyava_falls.cell);
  energy = energyGrid(layers, cellM, cfg);
  returnEnergy = dijkstra(energy, rows, cols, habitat).dist;
  planLayers = layers;
  if (layers.viewshed_relay) planLayers = { ...layers, viewshed: layers.viewshed.map((v, i) => Math.max(v, layers.viewshed_relay[i])) };
  const sv = Float32Array.from(layers.svf).sort();
  refugeSvf = sv[Math.floor(sv.length * REFUGE_SVF_PERCENTILE)];
  trav = traverse.map(idx);
  const walkable = (e) => e !== Infinity;
  traversePct = traverse.length ? (100 * traverse.filter((rc) => walkable(energy[idx(rc)])).length) / traverse.length : NaN;
  basePct = (100 * energy.filter(walkable).length) / energy.length;
  forbidMask = mk(cols, rows);
  { const id = new ImageData(cols, rows); for (let i = 0; i < energy.length; i++) if (energy[i] === Infinity) id.data[i * 4 + 3] = 255; forbidMask.getContext("2d").putImageData(id, 0, 0); }
  if (layers.geo_unit && geounits) {
    const acc = new Map(), g = layers.geo_unit;
    for (let i = 0; i < g.length; i++) if (g[i]) { const a = acc.get(g[i]) ?? { n: 0, r: 0, c: 0, d: Infinity }; a.n++; a.r += (i / cols) | 0; a.c += i % cols; acc.set(g[i], a); }
    for (let i = 0; i < g.length; i++) if (g[i]) { const a = acc.get(g[i]), d = (((i / cols) | 0) - a.r / a.n) ** 2 + ((i % cols) - a.c / a.n) ** 2; if (d < a.d) { a.d = d; a.cell = i; } }
    geoInfo = geounits.filter((u) => acc.has(u.id)).map((u) => ({ ...u, n: acc.get(u.id).n, cell: acc.get(u.id).cell }));
  }
  for (const o of [...$("layer").options]) if (o.value !== "none" && (!layers[o.value] || (o.value === "geo_unit" && !geoInfo.length))) o.remove();
  grat = graticule();
  canvas.parentElement.style.aspectRatio = `${cols} / ${rows}`;
  state.goal = cheyava;

  const cell = (e) => {
    const r = canvas.getBoundingClientRect();
    return Math.min(rows - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * rows))) * cols + Math.min(cols - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * cols)));
  };
  canvas.addEventListener("click", (e) => setGoal(cell(e)));
  canvas.addEventListener("keydown", (e) => {
    const d = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
    if (!d || e.altKey || e.ctrlKey || e.metaKey) return;
    const n = e.shiftKey ? 10 : 1;
    setGoal(Math.min(rows - 1, Math.max(0, Math.floor(state.goal / cols) + d[0] * n)) * cols + Math.min(cols - 1, Math.max(0, (state.goal % cols) + d[1] * n)));
    e.preventDefault();
  });
  $("reset-goal").addEventListener("click", () => setGoal(cheyava));
  let pending = 0;
  for (const w of WEIGHTS) $(`w-${w}`).addEventListener("input", () => { renderOutputs(); pending ||= requestAnimationFrame(() => { pending = 0; recompute(); }); });
  $("elapsed").addEventListener("input", () => { renderOutputs(); clearSpe(); updateEnv(); draw(); });
  $("layer").addEventListener("change", () => { buildLayer(); renderLayerLegend(); draw(); });
  $("show-traverse").addEventListener("change", () => { renderLegend(); draw(); });
  $("spe").addEventListener("click", simulateSpe);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.spe && e.target.tagName !== "SELECT") { clearSpe(); draw(); } });

  ready = true;
  for (const c of controls()) c.disabled = false;
  $("reset-goal").disabled = true; $("status").hidden = true;
  buildLayer();
  let rz; new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(resize, 100); }).observe(canvas);
  resize();
  recompute();
  renderAll();
  document.querySelector("main").setAttribute("aria-busy", "false");
}
boot().catch((e) => { console.error(e); showCoreError(e.file ?? e.message); });
