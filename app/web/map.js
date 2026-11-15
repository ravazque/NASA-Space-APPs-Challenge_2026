import { state, set, on, emit } from "./store.js";
import { t, num } from "./i18n.js";
import { $, esc } from "./ui.js";
import { setGoal } from "./plan.js";
import { setGrid, cellToLatLng, latLngToCell, bounds, maskSegments, metersPerPx } from "./geo.js";

const L = window.L;
const DEG_M = (Math.PI * 3396190) / 180;
const css = getComputedStyle(document.documentElement);
const tok = (n) => (typeof n === "string" && n.startsWith("--") ? css.getPropertyValue(n).trim() : n);
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const ATTRIB = "HiRISE 25 cm mosaic: NASA/JPL/University of Arizona, via NASA Mars Trek";
const PANES = { base: 200, raster: 250, graticule: 260, wash: 300, pattern: 350, outline: 400, lines: 450, markers: 600, plates: 650 };

let map, host, rows, cols, data, B, items = new Map(), hidden = new Set(), legacyOff = false, picker = null, ui = {};
const same = (a, b) => a === b || (a && b && a.length === b.length && a.every((v, i) => v === b[i]));

const scratch = document.createElement("canvas"); scratch.width = scratch.height = 1;
function rgba(c) {
  const x = scratch.getContext("2d", { willReadFrequently: true });
  x.clearRect(0, 0, 1, 1); x.fillStyle = tok(c); x.fillRect(0, 0, 1, 1);
  return [...x.getImageData(0, 0, 1, 1).data];
}
function toUrl(px) { const c = document.createElement("canvas"); c.width = cols; c.height = rows; c.getContext("2d").putImageData(new ImageData(px, cols, rows), 0, 0); return c.toDataURL("image/png"); }

function put(id, layer, keep) {
  if (id.startsWith("layers:")) killLegacy();
  const old = items.get(id);
  if (old && old.layer !== layer) map.removeLayer(old.layer);
  if (!layer) { items.delete(id); return; }
  items.set(id, { layer, ...keep });
  if (!hidden.has(id)) layer.addTo(map);
}
function image(id, px, pane, opacity = 1) {
  if (!px) return put(id, null);
  const url = toUrl(px), o = items.get(id);
  if (o?.layer.setUrl) { o.layer.setUrl(url); o.layer.setOpacity(opacity); return; }
  put(id, L.imageOverlay(url, B, { pane, opacity, className: "px", interactive: false, zIndex: 1 }));
}

function chain(segs) {
  const key = (p) => `${p[0]},${p[1]}`, adj = new Map(), used = new Uint8Array(segs.length), out = [];
  segs.forEach((s, i) => s.forEach((p) => { const k = key(p); if (!adj.has(k)) adj.set(k, []); adj.get(k).push(i); }));
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line = [...segs[i]];
    for (let pass = 0; pass < 2; pass++) {
      for (;;) {
        const end = line[line.length - 1], j = adj.get(key(end)).find((n) => !used[n]);
        if (j == null) break;
        used[j] = 1; line.push(key(segs[j][0]) === key(end) ? segs[j][1] : segs[j][0]);
      }
      line.reverse();
    }
    out.push(line);
  }
  return out;
}

function strokes(id, polys, pane, { token = "--ink", width = 2, halo = false, dash = null, opacity = 1, cap = "round", join = "round" } = {}) {
  if (!polys?.length) return put(id, null);
  const g = L.layerGroup(), base = { pane, interactive: false, lineCap: cap, lineJoin: join, fill: false };
  if (halo) g.addLayer(L.polyline(polys, { ...base, color: tok(halo === true ? "--ground" : halo), weight: width + 3, opacity: 1 }));
  g.addLayer(L.polyline(polys, { ...base, color: tok(token), weight: width, opacity, dashArray: dash?.join(" ") }));
  put(id, g);
}

const KINDS = {
  "hatch-red": { lines: [6, "/"], w: 2, color: "--red", base: "--wash-forbid" },
  "hatch-ink": { lines: [6, "\\"], w: 1, color: "--ink", a: 0.55 },
  "dots-ink": { dots: [6, 1], color: "--ink", a: 0.55 },
};
const patCache = new Map();
function patternFor(kind, d) {
  const spec = typeof kind === "string" ? KINDS[kind] ?? KINDS["hatch-ink"] : kind, k = JSON.stringify([spec, d, tok(spec.color ?? "--ink")]);
  if (patCache.has(k)) return patCache.get(k);
  const g = (spec.dots ?? spec.lines)[0], c = document.createElement("canvas"), x = c.getContext("2d");
  c.width = c.height = Math.round(g * d); x.scale(d, d);
  x.fillStyle = x.strokeStyle = tok(spec.color ?? "--ink"); x.globalAlpha = spec.a ?? 1; x.lineWidth = spec.w ?? 1; x.lineCap = "butt"; x.beginPath();
  if (spec.dots) { x.arc(g / 2, g / 2, spec.dots[1], 0, 2 * Math.PI); x.fill(); } else {
    const m = spec.lines[1];
    if (m === "h" || m === "x") { x.moveTo(0, g / 2); x.lineTo(g, g / 2); }
    if (m === "v" || m === "x") { x.moveTo(g / 2, 0); x.lineTo(g / 2, g); }
    if (m === "\\") for (const o of [-g, 0, g]) { x.moveTo(o, 0); x.lineTo(o + g, g); }
    if (m === "/") for (const o of [-g, 0, g]) { x.moveTo(o, g); x.lineTo(o + g, 0); }
    x.stroke();
  }
  const p = x.createPattern(c, "repeat"); p.setTransform?.(new DOMMatrix().scale(1 / d));
  patCache.set(k, p);
  return p;
}
const PatternLayer = L.GridLayer.extend({
  createTile(co) {
    const m = this._map, z = co.z, d = Math.min(2, devicePixelRatio || 1), el = document.createElement("canvas"), x = el.getContext("2d"), size = this.getTileSize().x;
    el.width = el.height = size * d;
    const P0 = co.scaleBy(this.getTileSize()), a = m.project([B[1][0], B[0][1]], z), b = m.project([B[0][0], B[1][1]], z), sx = (b.x - a.x) / cols, sy = (b.y - a.y) / rows;
    const c0 = Math.max(0, Math.floor((P0.x - a.x) / sx)), c1 = Math.min(cols - 1, Math.ceil((P0.x + size - a.x) / sx));
    const r0 = Math.max(0, Math.floor((P0.y - a.y) / sy)), r1 = Math.min(rows - 1, Math.ceil((P0.y + size - a.y) / sy));
    const path = new Path2D(), mask = this.mask;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      if (!mask[r * cols + c]) continue;
      let e = c; while (e + 1 <= c1 && mask[r * cols + e + 1]) e++;
      path.rect(a.x + c * sx, a.y + r * sy, (e - c + 1) * sx, sy); c = e;
    }
    x.scale(d, d); x.translate(-P0.x, -P0.y);
    const spec = typeof this.kind === "string" ? KINDS[this.kind] : this.kind;
    if (spec?.base) { x.fillStyle = tok(spec.base); x.fill(path); }
    x.fillStyle = patternFor(this.kind, d); x.fill(path);
    return el;
  },
});

const S = (s, vb = "0 0 24 24") => `<svg viewBox="${vb}" aria-hidden="true" focusable="false">${s}</svg>`;
const G = 'fill="var(--ground)" stroke="var(--ground)" stroke-width="2"', INK = 'fill="var(--ink)"', SUR = 'fill="var(--surface)"';
const house = (f) => `<path d="M5 12L12 5.5L19 12V19H14V14H10V19H5Z" fill="${f}"/>`;
const sign = (id) => `<rect x="1" y="1" width="22" height="22" ${G}/><use href="#${id}" x="2.5" y="2.5" width="19" height="19"/>`;
const warn = (inner) => `<path d="M12 2.5L23 21.5H1Z" fill="var(--yellow)" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round"/>${inner}`;
const SYM = {
  start: S(`<rect x="2" y="2" width="20" height="20" ${G}/><rect x="4" y="4" width="16" height="16" ${INK}/><rect x="9.5" y="9.5" width="5" height="5" fill="var(--ground)"/>`),
  dest: S(`<circle cx="12" cy="12" r="10.5" ${G}/><circle cx="12" cy="12" r="8.5" fill="var(--blue)"/><circle cx="12" cy="12" r="2.4" ${SUR}/>`),
  me: S(`<circle cx="12" cy="12" r="10.5" ${G}/><circle cx="12" cy="12" r="9" ${INK}/><circle cx="12" cy="12" r="5.5" ${SUR}/>`),
  astronaut: S(`<circle cx="12" cy="12" r="10.5" ${G}/><circle cx="12" cy="12" r="9" ${SUR} stroke="var(--ink)" stroke-width="2"/><circle cx="12" cy="9" r="2.4" ${INK}/><path d="M7.5 17.5Q12 9.5 16.5 17.5Z" ${INK}/>`),
  vehicle: S(`<rect x="1.5" y="5" width="21" height="14" ${G}/><rect x="3.5" y="7" width="17" height="10" ${INK}/><rect x="6" y="9.5" width="5" height="5" ${SUR}/><rect x="14" y="3" width="4" height="3" ${INK}/><rect x="14" y="18" width="4" height="3" ${INK}/>`),
  base: S(`<rect x="1" y="1" width="22" height="22" ${G}/><rect x="3" y="3" width="18" height="18" ${INK}/>${house("var(--surface)")}`),
  supply: S(`<rect x="2" y="2" width="20" height="20" ${G}/><rect x="4" y="4" width="16" height="16" ${SUR} stroke="var(--ink)" stroke-width="2"/><path d="M4 4L20 20M20 4L4 20" stroke="var(--ink)" stroke-width="1.6"/>`),
  equipment: S(`<path d="M12 1.5L21 6.75V17.25L12 22.5L3 17.25V6.75Z" ${G}/><path d="M12 3.5L19.2 7.7V16.3L12 20.5L4.8 16.3V7.7Z" ${SUR} stroke="var(--ink)" stroke-width="2"/><circle cx="12" cy="12" r="2.6" ${INK}/>`),
  refuge: S(sign("s-refuge")),
  relay: S(sign("s-relay")),
  hazard: S(warn('<path d="M12 9.5V15" stroke="var(--ink)" stroke-width="2.4"/><circle cx="12" cy="18" r="1.4" fill="var(--ink)"/>')),
  storm: S(warn('<path d="M7 14.5Q9.5 11.5 12 14.5T17 14.5M7.5 18Q10 15.5 12 18T16.5 18" fill="none" stroke="var(--ink)" stroke-width="1.8"/>')),
  fault: S(`<path d="M2.5 18.5L8.5 8L13 14.5L21.5 4.5" fill="none" stroke="var(--ground)" stroke-width="6"/><path d="M2.5 18.5L8.5 8L13 14.5L21.5 4.5" fill="none" stroke="var(--ink)" stroke-width="2.5"/>`),
  sample: S(`<path d="M12 1.5L22.5 12L12 22.5L1.5 12Z" ${G}/><path d="M12 3.5L20.5 12L12 20.5L3.5 12Z" ${INK}/><circle cx="12" cy="12" r="2.6" ${SUR}/>`),
  note: S(`<path d="M4 2H15.5L20 6.5V22H4Z" ${G}/><path d="M5 3H15L19 7V21H5Z" ${SUR} stroke="var(--ink)" stroke-width="1.6"/><path d="M8 11H16M8 14.5H16M8 18H13" stroke="var(--ink)" stroke-width="1.4"/>`),
  site: S(`<path d="M6 22V2" stroke="var(--ground)" stroke-width="6"/><path d="M6 2H21L15 8L21 14H6Z" ${G}/><path d="M6 22V2" stroke="var(--ink)" stroke-width="2.4"/><path d="M7 3.5H18L13.5 8L18 12.5H7Z" ${INK}/>`),
  crater: S(`<circle cx="12" cy="12" r="9" fill="none" stroke="var(--ground)" stroke-width="5"/><circle cx="12" cy="12" r="9" fill="none" stroke="var(--ink)" stroke-width="2" stroke-dasharray="4 2.5"/>`),
  wind: S(`<path d="M12 1.5L19 13H14.5V22.5H9.5V13H5Z" ${G}/><path d="M12 3.8L16.6 11.5H13.2V20.5H10.8V11.5H7.4Z" ${INK}/>`),
};
const ZK = { me: 9, dest: 8, start: 7, refuge: 7, storm: 6, hazard: 6 };

function symbolMarker(it) {
  const live = !!(it.id || it.onClick), sel = state.ui.selected, isSel = sel && sel.kind === it.kind && sel.id === (it.id ?? null);
  const kind = String(it.kind).replace(/[^\w-]/g, ""), cls = ["mk", `mk-${kind}`, it.stale && "stale", it.provisional && "prov", it.tone === "danger" && "danger", isSel && "sel"].filter(Boolean).join(" ");
  const html = `<div class="${cls}" data-mk="${esc(`${it.kind}:${it.id ?? ""}`)}"><div class="sym" style="transform:translateY(${Number(it.dy) || 0}px) rotate(${Number(it.rotate) || 0}deg)">${SYM[it.kind] ?? SYM.note}</div></div>`;
  const m = L.marker(cellToLatLng(it.cell), { pane: "markers", icon: L.divIcon({ className: "mk-wrap", html, iconSize: [0, 0] }), interactive: live, keyboard: live,
    zIndexOffset: (ZK[it.kind] ?? 5) * 1000, title: [it.label, it.sub].filter(Boolean).join(" · ") });
  m._it = it;
  if (live) m.on("click", () => { const i = m._it; set("ui", { selected: { kind: i.kind, id: i.id ?? null } }); i.onClick?.(i); });
  return m;
}
function plateMarker(it) {
  const html = `<div class="plate${it.optional ? " opt" : ""}${it.dy ? " dy" : ""}" style="margin-top:${Number(it.dy) || 0}px"><b>${esc(it.label)}</b>${it.sub ? `<span>${esc(it.sub)}</span>` : ""}</div>`;
  return L.marker(cellToLatLng(it.cell), { pane: "plates", icon: L.divIcon({ className: "plate-wrap", html, iconSize: [0, 0] }), interactive: false, keyboard: false, zIndexOffset: (ZK[it.kind] ?? 5) * 1000 });
}
function ring(it) {
  const [la, lo] = cellToLatLng(it.cell), r = it.radius_m / DEG_M, pts = Array.from({ length: 64 }, (_, i) => [la + r * Math.sin((i / 64) * 2 * Math.PI), lo + r * Math.cos((i / 64) * 2 * Math.PI)]);
  return L.layerGroup([L.polygon(pts, { pane: "lines", interactive: false, color: tok("--ground"), weight: 4.5, fill: false }),
    L.polygon(pts, { pane: "lines", interactive: false, color: tok("--ink"), weight: 1.5, dashArray: "6 4", fill: false })]);
}
function markers(id, list) {
  if (id.startsWith("layers:")) killLegacy();
  if (!list?.length) return put(id, null);
  list = list.filter((it) => Number.isInteger(it?.cell) && it.cell >= 0 || void console.warn(`map.markers(${id}): item without a valid cell skipped`, it));
  const old = items.get(id), parts = new Map(), g = old?.layer ?? L.layerGroup();
  list.forEach((it, i) => {
    const pid = it.id != null ? `${it.kind}:${it.id}` : `${it.kind}#${i}`, key = JSON.stringify([it.cell, it.kind, it.label, it.sub, it.stale, it.provisional, it.rotate, it.radius_m, it.optional, it.dy, it.tone, !!(it.id || it.onClick)]);
    const prev = old?.parts.get(pid);
    if (prev && prev.key === key) { prev.layers[0]._it = it; parts.set(pid, prev); return; }
    prev?.layers.forEach((l) => g.removeLayer(l));
    const layers = [symbolMarker(it)];
    if (it.label) layers.push(plateMarker(it));
    if (it.radius_m) layers.push(ring(it));
    layers.forEach((l) => g.addLayer(l));
    parts.set(pid, { key, layers });
  });
  old?.parts.forEach((p, pid) => { if (!parts.has(pid)) p.layers.forEach((l) => g.removeLayer(l)); });
  items.set(id, { layer: g, parts });
  if (!hidden.has(id) && !map.hasLayer(g)) g.addTo(map);
  declutter();
}
let dq; const declutter = () => { cancelAnimationFrame(dq); dq = requestAnimationFrame(placePlates); };
function placePlates() {
  const H = host.getBoundingClientRect(), all = [...host.querySelectorAll(".plate")], placed = [];
  all.forEach((p) => p.classList.remove("hide", "flip"));
  const hit = (a) => placed.some((b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
  for (const p of [...all.filter((e) => !e.classList.contains("opt")), ...all.filter((e) => e.classList.contains("opt"))]) {
    let r = p.getBoundingClientRect();
    if (r.right > H.right - 4) { p.classList.add("flip"); r = p.getBoundingClientRect(); }
    if (p.classList.contains("opt") && hit(r)) p.classList.add("hide"); else placed.push(r);
  }
}

let pickBox;
function finishPick(v) { const p = picker; if (!p) return; picker = null; p.layer?.remove(); host.classList.remove("picking"); pickBox.hidden = true; p.done(v); }
function startPick(kind, promptKey) {
  finishPick(null);
  return new Promise((done) => {
    const pts = [], draw = () => { picker.layer?.remove(); const ll = pts.map(cellToLatLng); picker.layer = L.layerGroup([L.polyline(ll, { pane: "lines", interactive: false, color: tok("--ink"), weight: 2, dashArray: "6 4" }), ...ll.map((p) => L.circleMarker(p, { pane: "lines", interactive: false, radius: 5, color: tok("--ink"), weight: 2, fillColor: tok("--surface"), fillOpacity: 1 }))]).addTo(map); };
    picker = { kind, done, prompt: promptKey, click(c) {
      if (c < 0) return;
      if (kind === "cell") return finishPick(c);
      pts.push(c); draw(); renderPick();
    }, undo() { pts.pop(); draw(); renderPick(); }, ok() { if (pts.length >= 3) finishPick(pts.slice()); }, n: () => pts.length };
    host.classList.add("picking"); pickBox.hidden = false; renderPick();
  });
}
function renderPick() {
  if (!picker) return;
  const poly = picker.kind === "polygon", n = picker.n();
  $("map-pick-t").textContent = t(picker.prompt ?? (poly ? "map.pick.polygon" : "map.pick.cell")) + (poly ? ` · ${t("map.pick.points", { n })}` : "");
  for (const b of pickBox.querySelectorAll("[data-pk]")) { b.hidden = !poly && b.dataset.pk !== "cancel"; if (b.dataset.pk === "done") b.disabled = n < 3; if (b.dataset.pk === "undo") b.disabled = !n; }
}

function corner(pos, cls) { const c = L.control({ position: pos }); let el; c.onAdd = () => { el = L.DomUtil.create("div", cls); L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el); return el; }; c.addTo(map); return el; }
let scaleEl, readEl, gratEl, noteEl, hover = false;
function drawScale() {
  const mpp = metersPerPx(map.getZoom()), L1 = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((n) => n / mpp >= 72) ?? 5000, w = L1 / mpp, lab = (m) => (m >= 1000 ? `${num(m / 1000, 0)} km` : `${num(m, 0)} m`);
  scaleEl.innerHTML = `<div class="sc-row"><div class="sc-bar" style="width:${w}px">${[0, 1, 2, 3].map((i) => `<i${i % 2 ? "" : ' class="k"'}></i>`).join("")}</div><div class="sc-n" aria-hidden="true"><b>▲</b>${esc(t("scale.north"))}</div></div>`
    + `<div class="sc-lab" style="width:${w}px"><span>0</span><span>${lab(L1 / 2)}</span><span>${lab(L1)}</span></div><div class="sc-cap">${esc(t("scale.cell", { m: num(data.cellM, 0) }))}</div>`;
}
function drawReadout(ll) {
  const c = ll ?? map.getCenter(), cell = latLngToCell(c.lat, c.lng);
  readEl.textContent = [t("grat.lon", { v: num(c.lng, 4) }), t("grat.lat", { v: num(c.lat, 4) }), cell >= 0 ? t("map.cell", { r: Math.floor(cell / cols), c: cell % cols }) : t("map.outside")].join(" · ");
}
const GSTEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1];
const gstep = (zoom) => GSTEPS.find((s) => (s * DEG_M) / metersPerPx(zoom) >= 96) ?? 0.1;
const GratLayer = L.GridLayer.extend({
  createTile(co) {
    const m = this._map, z = co.z, d = Math.min(2, devicePixelRatio || 1), el = document.createElement("canvas"), x = el.getContext("2d"), size = this.getTileSize().x, st = gstep(z);
    el.width = el.height = size * d;
    const P0 = co.scaleBy(this.getTileSize()), nw = m.unproject(P0, z), se = m.unproject(P0.add([size, size]), z);
    x.scale(d, d); x.strokeStyle = tok("--ink"); x.globalAlpha = 0.22; x.lineWidth = 1 / d; x.beginPath();
    for (let v = Math.ceil(nw.lng / st) * st; v <= se.lng; v += st) { const px = Math.round((m.project([nw.lat, v], z).x - P0.x) * d) / d + 0.5 / d; x.moveTo(px, 0); x.lineTo(px, size); }
    for (let v = Math.ceil(se.lat / st) * st; v <= nw.lat; v += st) { const py = Math.round((m.project([v, nw.lng], z).y - P0.y) * d) / d + 0.5 / d; x.moveTo(0, py); x.lineTo(size, py); }
    x.stroke();
    return el;
  },
});
function drawGrat() {
  const sz = map.getSize(), st = gstep(map.getZoom()), b = map.getBounds(), every = sz.x < 600 ? 2 : 1, out = [];
  const dec = st < 0.01 ? 3 : 2;
  for (let v = Math.ceil(b.getWest() / st) * st, n = 0; v <= b.getEast(); v += st, n++) {
    const x = map.latLngToContainerPoint([b.getNorth(), v]).x; if (x > 40 && x < sz.x - 40 && n % every === 0) out.push(`<span class="plate opt g" style="left:${x}px;top:6px;transform:translateX(-50%)">${esc(t("grat.lon", { v: num(v, dec) }))}</span>`);
  }
  for (let v = Math.ceil(b.getSouth() / st) * st, n = 0; v <= b.getNorth(); v += st, n++) {
    const y = map.latLngToContainerPoint([v, b.getWest()]).y; if (y > 40 && y < sz.y - 90 && n % every === 0) out.push(`<span class="plate opt g" style="left:6px;top:${y}px;transform:translateY(-50%)">${esc(t("grat.lat", { v: num(v, dec) }))}</span>`);
  }
  gratEl.innerHTML = out.join(""); declutter();
}
let envPolys = [];
function drawNote() {
  const v = map.getBounds(), has = state.plan.envInside && envPolys.some((p) => p.some(([la, lo]) => v.contains([la, lo])));
  noteEl.hidden = !state.plan.envInside || has; noteEl.textContent = t("map.env_beyond");
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
    if (reg.length >= 4) for (const i of reg) out[i] = 1;
  }
  return out;
}
let last = {};
function drawPlan() {
  const pl = state.plan;
  if (!pl || pl.goal == null) return;
  if (pl.route !== last.route) api.lines("plan:route", pl.route?.length > 1 ? [pl.route] : null, { token: "--blue", width: 4, halo: true });
  if (pl.spe !== last.spe) api.lines("plan:spe", pl.spe?.path.length > 1 ? [pl.spe.path] : null, { token: "--yellow", width: 4, halo: "--ink", dash: [8, 6], cap: "butt" });
  if (pl.forbid && pl.forbid !== last.forbid) { const v = forbidVisual(pl.forbid); api.pattern("plan:forbid", v, { kind: "hatch-red" }); api.outline("plan:forbid.edge", v, { token: "--red", width: 1, halo: false }); }
  if (pl.envMask && !same(pl.envMask, last.envMask)) api.wash("plan:outside", Uint8Array.from(pl.envMask, (v) => (v ? 0 : 1)), "--wash-outside");
  if (pl.envInside && !same(pl.envInside, last.envInside)) { api.outline("plan:envelope", pl.envInside, { token: "--green", width: 2.5, halo: true }); envPolys = items.get("plan:envelope")?.polys ?? []; }
  last = { route: pl.route, spe: pl.spe, forbid: pl.forbid, envMask: pl.envMask, envInside: pl.envInside };
  const home = pl.habitat, here = pl.at?.cell, eva = pl.evaS > 0 && here != null && here !== home, onGoal = eva && here === pl.goal, list = [];
  if (home != null) list.push({ cell: home, kind: "start", label: t("label.start") });
  if (pl.goal != null && pl.goal !== home) list.push({ cell: pl.goal, kind: "dest", label: t(pl.goal === pl.cheyava ? "label.cheyava_dest" : "label.dest"), tone: pl.safe === "forbidden" ? "danger" : undefined });
  if (eva && !onGoal) list.push({ cell: here, kind: "me", label: t("label.eva") });
  for (const c of pl.refuges ?? []) if (c !== home) list.push({ cell: c, kind: "refuge", label: t("label.refuge"), dy: pl.spe?.kind === "here" ? -20 : 0 });
  api.markers("plan:sites", list);
  drawNote();
}

const LPAT = Object.fromEntries(Object.entries({ Aeb: { dots: [4, 0.9] }, NHjf2: { lines: [5, "h"] }, Njf: { lines: [7, "\\"] }, Nue: { lines: [7, "v"] }, cr: { lines: [8, "x"] }, Nnp1: { dots: [9, 1.4] } }).map(([k, v]) => [k, { ...v, a: 0.55 }]));
const ranges = {};
let legacyKeys = new Set();
function killLegacy() { if (legacyOff) return; legacyOff = true; for (const id of legacyKeys) put(id, null); legacyKeys.clear(); }
function legacy() {
  if (legacyOff || !data) return;
  const L1 = data.layers, key = state.ui.raster, act = new Set(), use = (id) => { act.add(id); legacyKeys.add(id); return id; };
  if (L1[key]) {
    api.wash(use("legacy:wash"), new Uint8Array(rows * cols).fill(1), "--wash-layer");
    if (key === "geo_unit") {
      for (const u of data.geoInfo) if (LPAT[u.symbol]) api.pattern(use(`legacy:geo.${u.id}`), Uint8Array.from(L1.geo_unit, (v) => (v === u.id ? 1 : 0)), { kind: LPAT[u.symbol] });
      api.outline(use("legacy:geo.edges"), L1.geo_unit, { token: "--ink", width: 1, halo: false });
    } else {
      const [r, g, b] = rgba("--ink"), px = new Uint8ClampedArray(rows * cols * 4), A = [0, 36, 72, 107, 143];
      if (key === "viewshed") { const V = L1.viewshed, Rl = L1.viewshed_relay; for (let i = 0; i < V.length; i++) px.set([r, g, b, V[i] > 0.5 ? 0 : Rl?.[i] > 0.5 ? 46 : 128], i * 4); }
      else {
        if (!ranges[key]) { let lo = Infinity, hi = -Infinity; for (const v of L1[key]) { if (v < lo) lo = v; if (v > hi) hi = v; } ranges[key] = [lo, hi]; }
        const [lo, hi] = ranges[key];
        for (let i = 0; i < L1[key].length; i++) px.set([r, g, b, A[Math.min(4, Math.floor((5 * (L1[key][i] - lo)) / (hi - lo || 1)))]], i * 4);
      }
      image(use("legacy:raster"), px, "raster");
      if (key === "viewshed" && data.meta.relay) api.markers(use("legacy:relay"), [{ cell: data.meta.relay.cell[0] * cols + data.meta.relay.cell[1], kind: "relay", label: t("label.relay") }]);
    }
  }
  api.lines(use("legacy:traverse"), state.ui.show.traverse !== false && data.traverse.length > 1 ? [data.traverse] : null, { token: "--ink", width: 1, dash: [4, 4], opacity: 0.6, cap: "butt" });
  for (const id of [...legacyKeys]) if (!act.has(id)) { put(id, null); legacyKeys.delete(id); }
}

const api = {
  raster(id, px, { opacity = 1 } = {}) { image(id, px, "raster", opacity); },
  pattern(id, mask, { kind = "hatch-ink" } = {}) {
    if (!mask) return put(id, null);
    const o = items.get(id);
    if (o?.layer.kind === kind || (o && JSON.stringify(o.layer.kind) === JSON.stringify(kind))) { o.layer.mask = mask; o.layer.redraw(); return; }
    const l = new PatternLayer({ pane: "pattern", bounds: L.latLngBounds(B), tileSize: 256, keepBuffer: 1 }); l.mask = mask; l.kind = kind;
    put(id, l);
  },
  wash(id, mask, token = "--wash-outside") {
    if (!mask) return put(id, null);
    const c = rgba(token), px = new Uint8ClampedArray(mask.length * 4);
    for (let i = 0; i < mask.length; i++) if (mask[i]) px.set(c, i * 4);
    image(id, px, "wash");
  },
  outline(id, mask, o = {}) {
    if (!mask) return put(id, null);
    const polys = chain(maskSegments(mask));
    strokes(id, polys, "outline", { token: "--green", width: 2.5, halo: true, join: "miter", cap: "square", ...o });
    const r = items.get(id); if (r) r.polys = polys;
  },
  lines(id, paths, o = {}) { strokes(id, paths?.map((p) => p.map(cellToLatLng)), "lines", { token: "--blue", width: 4, halo: true, ...o }); },
  markers,
  show(id, v) {
    if (v) hidden.delete(id); else hidden.add(id);
    const r = items.get(id);
    if (r) { if (v) r.layer.addTo(map); else map.removeLayer(r.layer); }
    if (id.startsWith("layers:")) killLegacy();
  },
  pickCell: (promptKey) => startPick("cell", promptKey),
  pickPolygon: (promptKey) => startPick("polygon", promptKey),
  flyTo(cell, zoom) {
    const ll = cellToLatLng(cell), z = zoom ?? Math.max(map.getZoom(), 16);
    matchMedia("(prefers-reduced-motion: reduce)").matches ? map.setView(ll, z, { animate: false }) : map.flyTo(ll, z, { duration: 0.8 });
  },
  cellToPoint(cell) { const p = map.latLngToContainerPoint(cellToLatLng(cell)); return { x: p.x, y: p.y }; },
  get el() { return host; },
};

const centerCell = () => { const c = map.getCenter(); return latLngToCell(c.lat, c.lng); };
const ICON = {
  layers: '<path d="M12 3L22 9L12 15L2 9Z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M2 13.5L12 19.5L22 13.5" fill="none" stroke="currentColor" stroke-width="2"/>',
  locate: '<circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 1V5M12 19V23M1 12H5M19 12H23" stroke="currentColor" stroke-width="2"/>',
  fit: '<path d="M3 9V3H9M15 3H21V9M21 15V21H15M9 21H3V15" fill="none" stroke="currentColor" stroke-width="2.25"/>',
  report: '<path d="M4 3H20V21H4Z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8V16M8 12H16" stroke="currentColor" stroke-width="2.25"/>',
};
function buildTools() {
  const box = $("map-tools"), tool = (id, inner, key, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "tool"; b.dataset.tool = id; b.dataset.i18nAria = b.dataset.i18nTitle = key; b.setAttribute("aria-label", t(key)); b.title = t(key); b.innerHTML = inner; b.addEventListener("click", fn); box.append(b); return b; };
  const svg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;
  tool("zoom-in", "+", "map.zoom_in", () => map.zoomIn()); tool("zoom-out", "−", "map.zoom_out", () => map.zoomOut());
  tool("fit", svg("fit"), "map.fit", fit);
  tool("locate", svg("locate"), "map.locate", () => api.flyTo(state.ui.me?.manualCell ?? state.plan.at?.cell ?? state.data.habitat));
  const lb = tool("layers", svg("layers"), "map.layers", () => set("ui", { drawer: !state.ui.drawer }));
  tool("report", svg("report"), "map.report", () => emit("map:report"));
  return lb;
}
const fit = () => { map.fitBounds(B, { padding: [12, 12], animate: false }); };

export async function init(c) {
  if (!L) throw new Error("Leaflet (vendor/leaflet/leaflet.js) is not loaded");
  data = c.data; ({ rows, cols } = data);
  setGrid(data.meta); B = bounds(); host = $("map");
  map = L.map(host, { crs: L.CRS.EPSG4326, minZoom: 9, maxZoom: 19, zoomSnap: 0.25, maxBounds: L.latLngBounds(B).pad(0.25), maxBoundsViscosity: 0.9, preferCanvas: true,
    zoomControl: false, attributionControl: false, doubleClickZoom: false, wheelPxPerZoomLevel: 90 });
  for (const [n, z] of Object.entries(PANES)) map.createPane(n).style.zIndex = z;

  const tb = L.latLngBounds([B[0][0] - 0.005, B[0][1] - 0.005], [B[1][0] + 0.005, B[1][1] + 0.005]), fb = L.imageOverlay("data/hirise_aoi.webp", B, { pane: "base", interactive: false, zIndex: 0 });
  fb.on("error", () => { $("hint").textContent = `${t("map.nobg")} ${t("map.hint")}`; }); fb.addTo(map);
  L.tileLayer("tiles/{z}/{y}/{x}.webp", { pane: "base", minNativeZoom: 13, maxNativeZoom: 16, maxZoom: 19, bounds: tb, errorTileUrl: BLANK, attribution: ATTRIB, zIndex: 1 }).addTo(map);
  L.tileLayer("tiles/{z}/{y}/{x}.webp", { pane: "base", minZoom: 17, minNativeZoom: 17, maxNativeZoom: 17, maxZoom: 19, bounds: tb, errorTileUrl: BLANK, zIndex: 2 }).addTo(map);
  new GratLayer({ pane: "graticule", bounds: L.latLngBounds(B).pad(0.25), tileSize: 256 }).addTo(map);

  L.control.attribution({ position: "bottomleft", prefix: false }).addTo(map);
  scaleEl = corner("bottomleft", "map-scale"); readEl = corner("bottomleft", "map-readout");
  gratEl = L.DomUtil.create("div", "map-grat", host); gratEl.setAttribute("aria-hidden", "true");
  noteEl = L.DomUtil.create("p", "map-note", host); noteEl.hidden = true;
  host.insertAdjacentHTML("beforeend", '<div class="map-cross" aria-hidden="true"></div><div class="map-pick" hidden role="status"><span id="map-pick-t"></span><span class="pk"><button type="button" data-pk="undo"></button><button type="button" data-pk="done"></button><button type="button" data-pk="cancel"></button></span></div>');
  pickBox = host.querySelector(".map-pick");
  const labels = () => { for (const b of pickBox.querySelectorAll("[data-pk]")) b.textContent = t(`map.pick.${b.dataset.pk}`); };
  pickBox.addEventListener("click", (e) => { const k = e.target.dataset?.pk; if (k === "cancel") finishPick(null); else if (k === "done") picker?.ok(); else if (k === "undo") picker?.undo(); });
  L.DomEvent.disableClickPropagation(pickBox);

  const layersBtn = buildTools();
  let fitted = false;
  const fitOnce = () => { if (fitted || !host.clientWidth || !host.clientHeight) return; fitted = true; map.invalidateSize({ pan: false }); fit(); map.setMinZoom(Math.max(9, Math.min(11, map.getBoundsZoom(B) - 0.25))); };
  let rz; new ResizeObserver(() => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { if (!fitted) return fitOnce(); map.invalidateSize({ pan: false }); map.setMinZoom(Math.max(9, Math.min(11, map.getBoundsZoom(B) - 0.25))); }); }).observe(host);
  map.setView(L.latLngBounds(B).getCenter(), 12, { animate: false }); fitOnce();

  map.on("click", (e) => {
    const cell = latLngToCell(e.latlng.lat, e.latlng.lng);
    drawReadout(e.latlng);
    if (picker) return picker.click(cell);
    if (state.ui.selected) set("ui", { selected: null });
    if (cell >= 0) setGoal(cell);
  });
  map.on("mousemove", (e) => { hover = true; drawReadout(e.latlng); });
  host.addEventListener("mouseleave", () => { hover = false; drawReadout(); });
  map.on("moveend zoomend", () => { if (!hover) drawReadout(); drawNote(); declutter(); });
  map.on("move zoom", () => { drawGrat(); });
  map.on("zoom zoomend", drawScale);
  host.addEventListener("keydown", (e) => {
    if (e.target !== host || e.key !== "Enter") return;
    const cell = centerCell(); if (cell < 0) return;
    e.preventDefault();
    if (picker) picker.click(cell); else if (e.shiftKey) emit("map:here", cell); else setGoal(cell);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && picker) { e.stopPropagation(); finishPick(null); } }, true);

  const text = () => { $("hint").textContent = t("map.hint"); labels(); drawScale(); drawReadout(); drawGrat(); drawNote(); renderPick(); last = {}; drawPlan(); };
  on("plan", drawPlan);
  on("ui", (u) => {
    layersBtn.setAttribute("aria-pressed", String(!!u.drawer));
    if (u.selected !== ui.selected) for (const m of host.querySelectorAll("[data-mk]")) m.classList.toggle("sel", !!u.selected && m.dataset.mk === `${u.selected.kind}:${u.selected.id ?? ""}`);
    if (u.raster !== ui.raster || u.show?.traverse !== ui.traverse) legacy();
    ui = { selected: u.selected, raster: u.raster, traverse: u.show?.traverse };
  });
  on("lang", text);
  $("status").hidden = true;
  text(); legacy(); declutter();
  return api;
}
