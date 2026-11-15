import { state, on } from "./store.js";
import { t, num } from "./i18n.js";
import { $, esc, tag } from "./ui.js";
import { fmtHM } from "./marsclock.js";
import { cellToLatLng } from "./geo.js";

const DASH = "—";
const TOPICS = ["clock", "env", "plan", "lang", "ui"];

function reading(measure, decimals, unit = "") {
  if (!measure || !Number.isFinite(measure.v)) return DASH;
  return `${num(measure.v, decimals)}${unit}`;
}

function clockItems(clock) {
  if (!clock?.utcMs) return [];
  const marsTime = t("clock.solltst", { sol: clock.sol, hm: fmtHM(clock.ltst) });
  const season = t("clock.ls", { ls: num(clock.ls, 0), season: t(`clock.season.${clock.season}`) });
  const sun = t("info.sun", { deg: num(clock.sunEl, 0) });
  const earthTime = new Date(clock.utcMs).toISOString().slice(0, 16).replace("T", " ");
  return [
    ["mars", esc(marsTime)],
    ["season", `${esc(season)} · ${esc(sun)}`],
    ["earth", `${esc(earthTime)} UTC`],
  ];
}

function positionItems(cell) {
  if (!Number.isInteger(cell)) return [];
  if (cell === state.data.habitat) return [["pos", esc(t("info.at_home"))]];
  const [lat, lon] = cellToLatLng(cell);
  return [["pos", esc(`${num(lat, 4)}° N, ${num(lon, 4)}° E`)]];
}

function weatherItems(values) {
  if (!values) return [];
  const direction = Number.isFinite(values.wind_dir?.v) ? ` · ${num(values.wind_dir.v, 0)}°` : "";
  return [
    ["air", `${reading(values.t_air, 1, " °C")} ${tag(values.t_air?.tag)}`],
    ["wind", `${reading(values.wind, 1, " m/s")}${direction} ${tag(values.wind?.tag)}`],
    ["tau", `${reading(values.tau, 2)} ${tag(values.tau?.tag)}`],
  ];
}

function alertBadge(hazard) {
  const label = esc(t(`info.hz.${hazard.level}`));
  return `<span class="info-hz" data-level="${hazard.level}">${label}</span>`;
}

function items() {
  const hazard = state.env?.hazard;
  const list = [
    ...clockItems(state.clock),
    ...positionItems(state.plan?.at?.cell),
    ...weatherItems(state.env?.values),
  ];
  if (hazard) list.push(["alert", alertBadge(hazard)]);
  return list;
}

function nowLine(list, hazard) {
  const visible = list.filter(([key]) => key !== "alert" || hazard?.level);
  const cells = visible.map(([key, html]) => {
    const label = esc(t(`info.k.${key}`));
    return `<span class="nl-i nl-${key}"><span class="nl-k">${label}</span> ${html}</span>`;
  });
  return `<b class="nl-t">${esc(t("info.title"))}</b>${cells.join("")}`;
}

function cardSummary() {
  const { clock } = state;
  const values = state.env?.values;
  const parts = [];
  if (clock?.utcMs) parts.push(`Sol ${clock.sol} · ${fmtHM(clock.ltst)}`);
  if (values?.tau && Number.isFinite(values.tau.v)) parts.push(`τ ${num(values.tau.v, 2)}`);
  if (values) parts.push(reading(values.t_air, 0, " °C"));
  return parts.map(esc).join(" · ");
}

function render() {
  const list = items();
  const hazard = state.env?.hazard;
  $("now-line").innerHTML = nowLine(list, hazard);
  if (!state.ui.guide) return;

  $("info-body").innerHTML = list
    .map(([key, html]) => `<div><dt>${esc(t(`info.k.${key}`))}</dt><dd>${html}</dd></div>`)
    .join("");
  const badge = hazard?.level ? ` ${alertBadge(hazard)}` : "";
  $("info-sum").innerHTML = `${cardSummary() || esc(t("info.title"))}${badge}`;
}

export function init() {
  for (const topic of TOPICS) on(topic, render);
  render();
}
