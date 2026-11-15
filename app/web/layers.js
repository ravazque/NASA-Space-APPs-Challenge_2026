import { state, set, on } from "./store.js";
import { t, num, pick } from "./i18n.js";
import { $, h, esc } from "./ui.js";

const TAU = 2 * Math.PI;
const css = getComputedStyle(document.documentElement);
const tok = (n) => css.getPropertyValue(n).trim();
const remPx = (v) => parseFloat(v) * parseFloat(css.fontSize);
const ranges = {};
let data;

const PAT = { Aeb: { dots: [4, 0.9] }, NHjf2: { lines: [5, "h"] }, Njf: { lines: [7, "\\"] }, Nue: { lines: [7, "v"] }, cr: { lines: [8, "x"] }, Nnp1: { dots: [9, 1.4] } };
function pattern(spec, k) {
  const g = (spec.dots ?? spec.lines)[0], T = Math.round(g * k), c = new OffscreenCanvas(T, T), x = c.getContext("2d");
  const [r, gg, b] = [1, 3, 5].map((i) => parseInt(tok("--ink").slice(i, i + 2), 16));
  x.fillStyle = x.strokeStyle = `rgba(${r},${gg},${b},.55)`; x.lineWidth = Math.max(1, Math.round(k));
  x.beginPath();
  if (spec.dots) { x.arc(T / 2, T / 2, spec.dots[1] * k, 0, TAU); x.fill(); return x.createPattern(c, "repeat"); }
  const d = spec.lines[1];
  if (d === "h" || d === "x") { x.moveTo(0, T / 2); x.lineTo(T, T / 2); }
  if (d === "v" || d === "x") { x.moveTo(T / 2, 0); x.lineTo(T / 2, T); }
  if (d === "\\") for (const o of [-T, 0, T]) { x.moveTo(o, 0); x.lineTo(o + T, T); }
  x.stroke();
  return x.createPattern(c, "repeat");
}
function rangeOf(key) {
  if (!ranges[key]) { let lo = Infinity, hi = -Infinity; for (const v of data.layers[key]) { if (v < lo) lo = v; if (v > hi) hi = v; } ranges[key] = [lo, hi]; }
  return ranges[key];
}
const sws = (alphas) => `<span class="sws">${alphas.map((a) => `<i style="--a:${a}"></i>`).join("")}</span>`;
function geoSwatch(u) {
  const c = h("canvas", "sw-geo"), d = devicePixelRatio || 1;
  c.width = Math.round(remPx("1.5rem") * d); c.height = Math.round(remPx("1rem") * d);
  if (PAT[u.symbol]) { const x = c.getContext("2d"); x.fillStyle = pattern(PAT[u.symbol], d); x.fillRect(0, 0, c.width, c.height); }
  return c;
}

function renderLayerLegend() {
  const key = state.ui.raster, box = $("layer-legend"), meta = data.meta;
  box.replaceChildren(); box.classList.remove("geo");
  if (key === "none") return;
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
    box.classList.add("geo");
    for (const u of data.geoInfo) { const row = h("span", "geo-row"); row.title = `${pick(u, "name")}: ${pick(u, "plain")}`; row.append(geoSwatch(u), h("b", "", esc(u.symbol)), h("span", "", esc(pick(u, "name")))); box.append(row); }
    box.append(h("span", "note", esc(t("geo.note"))));
  } else {
    const [lo, hi] = rangeOf(key), unit = $("layer").selectedOptions[0].dataset.unit, d = key === "elevation_m" || key === "thermal_inertia_si" ? 0 : 1;
    const u = unit ? (unit === "°" ? unit : ` ${unit}`) : "";
    box.append(h("span", "grp", `${esc(t("layer.less"))} ${num(lo, d)} ${sws([0, 0.14, 0.28, 0.42, 0.56])} ${num(hi, d)}${esc(u)} ${esc(t("layer.more"))}`));
    if (key === "svf") box.append(h("span", "", esc(t("layer.svf_note"))));
  }
}

function renderLegend() {
  for (const el of document.querySelectorAll("[data-lg]")) el.textContent = t(`legend.${el.dataset.lg}`, { max: num(data.cfg?.max_slope_deg ?? 18, 0) });
  for (const li of document.querySelectorAll("[data-only=traverse]")) li.hidden = !$("show-traverse").checked;
}

export async function init(ctx) {
  data = ctx.data;
  const sel = $("layer");
  for (const o of [...sel.options]) if (o.value !== "none" && (!data.layers[o.value] || (o.value === "geo_unit" && !data.geoInfo.length))) o.remove();
  set("ui", { raster: "none", show: { ...state.ui.show, traverse: true } });
  sel.addEventListener("change", () => { set("ui", { raster: sel.value }); renderLayerLegend(); });
  $("show-traverse").addEventListener("change", (e) => { set("ui", { show: { ...state.ui.show, traverse: e.target.checked } }); renderLegend(); });
  on("lang", () => { renderLegend(); renderLayerLegend(); });
  renderLegend(); renderLayerLegend();
}
