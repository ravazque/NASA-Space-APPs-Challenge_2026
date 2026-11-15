import { state, on } from "./store.js";
import { t, num } from "./i18n.js";
import { $ } from "./ui.js";
import { setGoal } from "./plan.js";
import { setGrid } from "./geo.js";

const R_MARS = 3396190;
const TAU = 2 * Math.PI;
const css = getComputedStyle(document.documentElement);
const tok = (n) => css.getPropertyValue(n).trim();
const remPx = (v) => parseFloat(v) * parseFloat(css.fontSize);
const mk = (w, h) => new OffscreenCanvas(w, h);
const inkRgb = () => { const h = tok("--ink"); return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const wash = (n) => { const [r, g, b, a] = tok(n).match(/[\d.]+/g).map(Number); return [r, g, b, Math.round(a * 255)]; };
const loadImage = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error(src)); i.src = src; });

let rows, cols, cellM, meta, layers, trav = [], geoInfo = [], bg, grat, host, canvas, ctx;
let ready = false;
let k = 1, sx = 1, sy = 1;
let bgCache, hatchCache, geoCache, geoEdges, envCanvas, envPath, envNote, layerCanvas, forbidMask, forbidPath;
let lastForbid = null, lastEnv = null, lastRaster = null;
const MIN_FORBID_CELLS = 4;
const unitMasks = new Map(), ranges = {};
const plan = () => state.plan;

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
  x.strokeStyle = tok("--red"); x.lineWidth = Math.max(2, 2 * k); x.beginPath();
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

function forbidVisual(e) {
  const out = new Uint8Array(e.length), seen = new Uint8Array(e.length);
  for (let s = 0; s < e.length; s++) {
    if (!e[s] || seen[s]) continue;
    const reg = [s]; seen[s] = 1;
    for (let n = 0; n < reg.length; n++) {
      const i = reg[n], r = (i / cols) | 0, c = i % cols;
      for (const j of [c > 0 ? i - 1 : -1, c + 1 < cols ? i + 1 : -1, r > 0 ? i - cols : -1, r + 1 < rows ? i + cols : -1]) if (j >= 0 && e[j] && !seen[j]) { seen[j] = 1; reg.push(j); }
    }
    if (reg.length >= MIN_FORBID_CELLS) for (const i of reg) out[i] = 1;
  }
  return out;
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

function rangeOf(key) {
  if (!ranges[key]) { let lo = Infinity, hi = -Infinity; for (const v of layers[key]) { if (v < lo) lo = v; if (v > hi) hi = v; } ranges[key] = [lo, hi]; }
  return ranges[key];
}

function updateEnv() {
  const pl = plan();
  if (!pl.envMask) return;
  const envMask = pl.envMask, [r, g, b, a] = wash("--wash-outside"), id = new ImageData(cols, rows);
  for (let i = 0; i < envMask.length; i++) if (!envMask[i]) id.data.set([r, g, b, a], i * 4);
  envCanvas ??= mk(cols, rows);
  envCanvas.getContext("2d").putImageData(id, 0, 0);
  const inside = pl.envInside;
  envPath = edges(inside);
  const bx = Math.round(cols * 0.15), by = Math.round(rows * 0.15), hug = { left: [], right: [], top: [], bottom: [] };
  let inner = 0;
  for (let i = 0; i < inside.length; i++) {
    const c = i % cols, r = (i / cols) | 0;
    if (!((c + 1 < cols && inside[i] !== inside[i + 1]) || (r + 1 < rows && inside[i] !== inside[i + cols]))) continue;
    if (c < bx) hug.left.push([r, c]); else if (c >= cols - bx) hug.right.push([r, c]); else if (r < by) hug.top.push([r, c]); else if (r >= rows - by) hug.bottom.push([r, c]); else inner++;
  }
  const side = Object.keys(hug).sort((a, b) => hug[b].length - hug[a].length)[0], e = hug[side];
  envNote = inner >= 60 ? null : !e.length ? { side: "none" } : (() => {
    const horiz = side === "left" || side === "right", along = e.map((p) => p[horiz ? 0 : 1]).sort((a, b) => a - b)[e.length >> 1], depth = e.map((p) => p[horiz ? 1 : 0]);
    return { side, along, depth: side === "left" || side === "top" ? Math.max(...depth) : Math.min(...depth) };
  })();
}

function buildHatch() {
  const W = canvas.width, H = canvas.height, forbidCells = forbidVisual(plan().forbid);
  forbidMask = mk(cols, rows);
  { const id = new ImageData(cols, rows); for (let i = 0; i < forbidCells.length; i++) if (forbidCells[i]) id.data[i * 4 + 3] = 255; forbidMask.getContext("2d").putImageData(id, 0, 0); }
  hatchCache = mk(W, H);
  const hx = hatchCache.getContext("2d"), l = mk(W, H), lx = l.getContext("2d");
  hx.imageSmoothingEnabled = lx.imageSmoothingEnabled = false;
  hx.drawImage(forbidMask, 0, 0, W, H); hx.globalCompositeOperation = "source-in"; hx.fillStyle = tok("--wash-forbid"); hx.fillRect(0, 0, W, H);
  lx.fillStyle = hatchPattern(); lx.fillRect(0, 0, W, H); lx.globalCompositeOperation = "destination-in"; lx.drawImage(forbidMask, 0, 0, W, H);
  hx.globalCompositeOperation = "source-over"; hx.drawImage(l, 0, 0);
  forbidPath = edges(forbidCells);
}

function buildLayer() {
  const key = state.ui.raster, id = new ImageData(cols, rows), I = inkRgb();
  layerCanvas ??= mk(cols, rows);
  if (key === "viewshed") {
    const V = layers.viewshed, Rl = layers.viewshed_relay;
    for (let i = 0; i < V.length; i++) id.data.set([...I, V[i] > 0.5 ? 0 : Rl?.[i] > 0.5 ? 46 : 128], i * 4);
  } else if (layers[key] && key !== "geo_unit") {
    const [lo, hi] = rangeOf(key), L = layers[key], A = [0, 36, 72, 107, 143];
    for (let i = 0; i < L.length; i++) id.data.set([...I, A[Math.min(4, Math.floor((5 * (L[i] - lo)) / (hi - lo || 1)))]], i * 4);
  }
  layerCanvas.getContext("2d").putImageData(id, 0, 0);
  lastRaster = key;
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
  geoCache = null;
  if (plan().forbid) { buildHatch(); lastForbid = plan().forbid; }
  updateEnv(); lastEnv = plan().envMask;
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

function draw() {
  const pl = plan();
  if (!ready || !bgCache) return;
  const W = canvas.width, H = canvas.height, key = state.ui.raster, Wc = W / k, Hc = H / k;
  const ink = tok("--ink"), ground = tok("--ground"), surface = tok("--surface"), blue = tok("--blue"), FS = remPx(tok("--t-canvas")), FONT = tok("--font");
  const labels = [], font = (w, s) => `${w} ${s}px ${FONT}`;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bgCache, 0, 0);
  if (key !== "none" && layers[key]) {
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
  if (pl.envMask && envCanvas) { ctx.drawImage(envCanvas, 0, 0, W, H); }
  if (hatchCache) ctx.drawImage(hatchCache, 0, 0);
  ctx.lineCap = "square"; ctx.lineJoin = "miter";
  if (forbidPath) { ctx.save(); if (Math.round(k) % 2) ctx.translate(0.5, 0.5); ctx.strokeStyle = tok("--red"); ctx.lineWidth = Math.max(1, Math.round(k)); ctx.stroke(forbidPath); ctx.restore(); }
  if (envPath) { ctx.strokeStyle = ground; ctx.lineWidth = 5.5 * k; ctx.stroke(envPath); ctx.strokeStyle = tok("--green"); ctx.lineWidth = 2.5 * k; ctx.stroke(envPath); }

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
    const flip = x + 16 + ctx.measureText(text).width + 8 > Wc - 4;
    labels.push({ text, x: flip ? x - 16 : x + 16, y, a: flip ? "right" : "left", s: FS });
  };
  ctx.lineJoin = "round";
  if (state.ui.show.traverse !== false && trav.length > 1) { ctx.lineCap = "butt"; ctx.globalAlpha = 0.6; trace(trav, ink, 1, [4, 4]); ctx.globalAlpha = 1; }
  ctx.lineCap = "round";
  const route = pl.route ?? [], spe = pl.spe, habitat = pl.habitat, goal = pl.goal;
  if (route.length > 1) { trace(route, ground, 7, []); trace(route, blue, 4, []); }
  if (spe?.path.length > 1) { ctx.lineCap = "butt"; trace(spe.path, ink, 6, []); trace(spe.path, tok("--yellow"), 4, [8, 6]); }
  if (key === "viewshed" && meta.relay) { const [x, y] = P(meta.relay.cell[0] * cols + meta.relay.cell[1]); box(x, y, 18, ground); sign("s-relay", x, y, 16); mark(t("label.relay"), x, y); }
  if (habitat != null) { const [x, y] = P(habitat); box(x, y, 18, ground); box(x, y, 14, ink); box(x, y, 4, ground); mark(t("label.start"), x, y); }
  const here = pl.at?.cell, eva = pl.evaS > 0 && here !== habitat, onGoal = eva && here === goal;
  if (goal != null && goal !== habitat) {
    const [x, y] = P(goal);
    dot(x, y, 10, ground); dot(x, y, 8, blue); dot(x, y, 2, surface);
    if (pl.safe === "forbidden") { ctx.beginPath(); ctx.arc(x, y, 11, 0, TAU); ctx.strokeStyle = tok("--red"); ctx.lineWidth = 2; ctx.stroke(); }
    mark(t(goal === pl.cheyava ? "label.cheyava_dest" : "label.dest"), x, y);
  }
  if (eva && !onGoal) { const [x, y] = P(here); dot(x, y, 8.75, ground); dot(x, y, 7.25, ink); dot(x, y, 4.75, surface); mark(t("label.eva"), x, y); }
  if (spe && spe.refuge !== habitat) { const [x, y0] = P(spe.refuge), y = spe.kind === "here" ? y0 - 20 : y0; box(x, y, 22, ground); sign("s-refuge", x, y, 18); mark(t("label.refuge"), x, y); }
  if (key === "geo_unit") for (const u of geoInfo) if (u.n >= 150) { const [x, y] = P(u.cell); labels.push({ text: u.symbol, x, y, a: "center", s: 12 }); }
  const sb = scaleBox(Hc, ink, ground, font, Wc < 600), placed = [sb];
  const hair = 1 / k, snap = (v) => Math.round(v * k) / k, PADX = 4;
  ctx.textBaseline = "middle"; ctx.setLineDash([]);
  const plate = (l, optional) => {
    ctx.font = font(600, l.s);
    const tw = ctx.measureText(l.text).width, ar = l.arrow, ex = ar === "left" || ar === "right" ? 14 : 0, ey = ar === "up" || ar === "down" ? 12 : 0;
    const w = snap(tw + 2 * PADX + ex), h = snap(Math.round(l.s * 1.5) + ey);
    const x = snap(l.a === "left" ? l.x - PADX - (ar === "left" ? ex : 0) : l.a === "right" ? l.x - w + PADX + (ar === "right" ? ex : 0) : l.x - w / 2), y = snap(l.y - h / 2), r = { x, y, w, h };
    if (optional && placed.some((p) => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y)) return null;
    placed.push(r);
    ctx.fillStyle = l.fill ?? ground; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = ink; ctx.lineWidth = hair; ctx.strokeRect(x + hair / 2, y + hair / 2, w - hair, h - hair);
    const cx = x + (ar === "left" ? ex : 0) + (w - ex) / 2, cy = y + (ar === "up" ? ey : 0) + (h - ey) / 2;
    ctx.fillStyle = l.color ?? ink; ctx.textAlign = "center"; ctx.fillText(l.text, cx, cy);
    if (ar) {
      const [mx, my] = { left: [x + 4, y + h / 2], right: [x + w - 4, y + h / 2], up: [x + w / 2, y + 3], down: [x + w / 2, y + h - 3] }[ar], d = { left: [1, 0], right: [-1, 0], up: [0, 1], down: [0, -1] }[ar];
      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(mx + d[0] * 8 - d[1] * 4, my + d[1] * 8 + d[0] * 4); ctx.lineTo(mx + d[0] * 8 + d[1] * 4, my + d[1] * 8 - d[0] * 4); ctx.closePath(); ctx.fill();
    }
    return r;
  };
  for (const l of labels) plate(l);
  if (envNote) {
    const n = envNote, green = tok("--green"), on = tok("--on-color"), cw = sx / k, ch = sy / k, text = t(n.side === "none" ? "label.env_none" : "label.env");
    const base = { text, s: FS, fill: green, color: on }, at = { none: { a: "right", x: Wc - 12, y: 40 }, left: { a: "left", x: (n.depth + 3) * cw + 8, y: (n.along + 0.5) * ch, arrow: "left" },
      right: { a: "right", x: (n.depth - 3) * cw - 8, y: (n.along + 0.5) * ch, arrow: "right" }, top: { a: "center", x: (n.along + 0.5) * cw, y: (n.depth + 3) * ch + 16, arrow: "up" }, bottom: { a: "center", x: (n.along + 0.5) * cw, y: (n.depth - 3) * ch - 16, arrow: "down" } }[n.side];
    for (let i = 0; i < 8 && !plate({ ...base, ...at, y: Math.min(Hc - 30, Math.max(30, at.y)) + ((i + 1) >> 1) * (i % 2 ? -28 : 28) }, true); i++);
  }
  const gs = Wc < 600 ? 4 : 2;
  for (const [v, c] of grat.lon) if (Math.round(v * 100) % gs === 0 && c * sx / k > 24 && c * sx / k < Wc - 24) plate({ text: t("grat.lon", { v: num(v, 2) }), x: c * sx / k, y: 16, a: "center", s: FS }, true);
  for (const [v, r] of grat.lat) if (Math.round(v * 100) % gs === 0 && r * sy / k > 30 && r * sy / k < Hc - 30) plate({ text: t("grat.lat", { v: num(v, 2) }), x: 10, y: r * sy / k, a: "left", s: FS }, true);
}

function scaleBox(Hc, ink, ground, font, compact) {
  const cw = sx / k, L = [25, 50, 100].find((n) => n * cw >= 90) ?? 100, bar = L * cw, pad = 6, hair = 1 / k, snap = (v) => Math.round(v * k) / k;
  ctx.font = font(400, 12);
  const end = `${L * 20} m`, w = Math.max(bar + ctx.measureText(end).width / 2, compact ? 0 : ctx.measureText(t("scale.cell")).width);
  const bw = pad * 2 + w + (compact ? 18 : 22), bh = pad * 2 + 6 + 4 + 14 + (compact ? 0 : 16), x0 = 12, y0 = snap(Hc - 12 - bh), bx = x0 + pad, by = y0 + pad;
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
  if (!compact) { ctx.textAlign = "left"; ctx.fillText(t("scale.cell"), bx, ly + 16); }
  const ax = x0 + bw - pad - 6, ah = compact ? 8 : 12;
  ctx.beginPath(); ctx.moveTo(ax, by); ctx.lineTo(ax + 4, by + ah); ctx.lineTo(ax - 4, by + ah); ctx.closePath(); ctx.fill();
  ctx.font = font(700, 12); ctx.textAlign = "center"; ctx.fillText(t("scale.north"), ax, by + ah + 10);
  return { x: x0, y: y0, w: bw, h: bh };
}

const renderHint = () => { $("hint").textContent = `${bg ? "" : `${t("map.nobg")} `}${t("map.hint")}`; };

function onPlan() {
  if (!ready || !bgCache) return;
  const pl = plan();
  if (pl.forbid && pl.forbid !== lastForbid) { buildHatch(); lastForbid = pl.forbid; }
  if (pl.envMask && pl.envMask !== lastEnv) { updateEnv(); lastEnv = pl.envMask; }
  draw();
}

const api = {
  raster() {}, pattern() {}, wash() {}, outline() {}, lines() {}, markers() {}, show() {}, flyTo() {},
  pickPolygon: async () => null,
  pickCell(promptKey) {
    return new Promise((done) => {
      const fin = (v) => { canvas.removeEventListener("click", click, true); document.removeEventListener("keydown", key, true); canvas.style.cursor = ""; done(v); };
      const click = (e) => { e.stopImmediatePropagation(); fin(cellAt(e)); };
      const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); fin(null); } };
      canvas.addEventListener("click", click, true); document.addEventListener("keydown", key, true); canvas.style.cursor = "crosshair";
    });
  },
  cellToPoint(cell) { const r = canvas.getBoundingClientRect(), h = host.getBoundingClientRect(); return { x: r.left - h.left + (((cell % cols) + 0.5) / cols) * r.width, y: r.top - h.top + ((((cell / cols) | 0) + 0.5) / rows) * r.height }; },
  get el() { return host; },
};
const cellAt = (e) => {
  const r = canvas.getBoundingClientRect();
  return Math.min(rows - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * rows))) * cols + Math.min(cols - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * cols)));
};

export async function init(c) {
  ({ rows, cols, cellM, meta, layers, geoInfo } = c.data);
  trav = c.data.traverse;
  setGrid(meta);
  [bg] = await Promise.all([loadImage("data/hirise_aoi.webp").catch(() => null), document.fonts.load("600 14px Barlow").catch(() => 0), document.fonts.load("400 12px Barlow").catch(() => 0)]);
  host = $("map");
  canvas = document.createElement("canvas"); canvas.setAttribute("aria-hidden", "true"); canvas.style.cssText = "display:block;width:100%;height:100%";
  host.append(canvas); ctx = canvas.getContext("2d");
  host.style.aspectRatio = `${cols} / ${rows}`;
  grat = graticule();

  canvas.addEventListener("click", (e) => setGoal(cellAt(e)));
  host.addEventListener("keydown", (e) => {
    const d = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key], goal = plan().goal;
    if (!d || e.altKey || e.ctrlKey || e.metaKey || goal == null) return;
    const n = e.shiftKey ? 10 : 1;
    setGoal(Math.min(rows - 1, Math.max(0, Math.floor(goal / cols) + d[0] * n)) * cols + Math.min(cols - 1, Math.max(0, (goal % cols) + d[1] * n)));
    e.preventDefault();
  });
  on("plan", onPlan);
  on("ui", () => { if (state.ui.raster !== lastRaster) buildLayer(); draw(); });
  on("lang", () => { renderHint(); draw(); });

  ready = true;
  $("status").hidden = true;
  buildLayer();
  renderHint();
  let rz; new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(resize, 100); }).observe(host);
  resize();
  { const sc = document.querySelector(".map-scroll"), mid = ((c.data.habitat % cols) + (c.data.cheyava % cols)) / 2 / cols; sc.scrollLeft = Math.max(0, sc.scrollWidth * mid - sc.clientWidth / 2); }
  return api;
}
