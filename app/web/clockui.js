import { state, set, on } from "./store.js";
import { t, num, shown } from "./i18n.js";
import { $, esc, tag, ico } from "./ui.js";
import { mars, solToUtc, clockUtc, utcAtLs, fmtHM, seasonOf } from "./marsclock.js";
import { loadEnv, resolveEnv, at } from "./env.js";
import { submit, hubNow } from "./sync.js";

const RATES = [1, 60, 600, 3600];
const PRESET_LS = [0, 90, 180, 270];
const MODES = ["replay", "live", "scenario"];
const DEFAULT_REPLAY_SOL = 1210;
const DEFAULT_REPLAY_LTST = 11;
const MAX_UTC_MS = 8.64e15;
const CLOCK_PUBLISH_INTERVAL_MS = 900;
const DASH = "—";

const PLAY_PATH = "M4 2L13 8L4 14Z";
const PAUSE_PATH = "M3.5 2H7V14H3.5ZM9 2H12.5V14H9Z";

const SPARK_WIDTH = 232;
const SPARK_HEIGHT = 44;
const SPARK_PAD_X = 4;
const SPARK_BOTTOM = 52;

const ENV_GROUPS = [
  ["met", [["t_air", "°C", 1], ["t_ground", "°C", 1], ["wind"], ["rh", "%", 0], ["tau", "", 2]]],
  ["atm", [
    ["pressure", "Pa", 0],
    ["density", "kg/m³", 4],
    ["pressure_var", "Pa", 1, true],
    ["t_air_var", "°C", 1, true],
  ]],
  ["rad", [["uv", "W/m²", 1], ["rad", "µGy/day", 0]]],
];

const HAZARD_TRIANGLE = `<path d="M24 4L45 41H3Z"
  style="fill:var(--yellow);stroke:var(--ink)" stroke-width="3" stroke-linejoin="round"/>`;
const HAZARD_WAVES = `<path d="M12 31q4-4 8 0t8 0 8 0M14 24q3-3 6 0t6 0 6 0"
  fill="none" style="stroke:var(--ink)" stroke-width="2.5"/>`;
const HAZARD_ICON = `<svg viewBox="0 0 48 48" aria-hidden="true">`
  + `${HAZARD_TRIANGLE}${HAZARD_WAVES}</svg>`;

let ctx;
let envData = null;
let envFailed = false;
let timer = null;

let lastClock = null;
let lastOverride;
let lastUtc = null;
let lastHazardKey = "";
let lastPublishAt = 0;
let lastPublishClock = null;
let drawn = { storm: null, wind: null };

let lastSparkSol = null;
let lastTags = {};
const openNotes = new Set();

function season(name) {
  return t(`clock.season.${name}`);
}

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function hazardKey(hazard) {
  if (!hazard) return "";
  const parts = [hazard.level, hazard.cell, hazard.radius_m, hazard.tag, hazard.label];
  return [...parts, hazard.reasons.join()].join("|");
}

function tick(force) {
  const clockDoc = state.doc.clock;
  const override = state.doc.env?.override ?? null;
  const utc = clockUtc(clockDoc, hubNow());
  if (!Number.isFinite(utc) || Math.abs(utc) > MAX_UTC_MS) return;
  const unchanged = utc === lastUtc && clockDoc === lastClock && override === lastOverride;
  if (!force && unchanged) return;
  lastUtc = utc;
  lastClock = clockDoc;
  lastOverride = override;

  const marsNow = mars(utc);
  const isReplay = clockDoc.mode === "replay" && clockDoc.replaySol != null;
  const clock = {
    utcMs: utc,
    sol: isReplay ? clockDoc.replaySol : marsNow.sol,
    ltst: marsNow.ltst,
    lmst: marsNow.lmst,
    ls: marsNow.ls,
    season: marsNow.season,
    dustSeason: marsNow.dustSeason,
    sunEl: marsNow.sunEl,
    sunAz: marsNow.sunAz,
    rAU: marsNow.rAU,
    mode: clockDoc.mode,
    rate: clockDoc.rate,
    paused: !!clockDoc.paused,
    replaySol: clockDoc.replaySol ?? null,
  };

  let env = {};
  if (envData) {
    env = resolveEnv(envData, marsNow, clockDoc, override, utc);
    env.hazard.cell ??= ctx.data.habitat;
  }

  state.env = env;
  state.clock = clock;
  const key = hazardKey(env.hazard);
  if (key !== lastHazardKey) {
    lastHazardKey = key;
    set("env", env, true);
  }
  const wallNow = performance.now();
  const publishDue = wallNow - lastPublishAt >= CLOCK_PUBLISH_INTERVAL_MS;
  if (force || clockDoc !== lastPublishClock || publishDue) {
    lastPublishAt = wallNow;
    lastPublishClock = clockDoc;
    set("clock", clock, true);
  }

  try {
    renderBar();
  } catch (error) {
    console.error("ARIADNE clock bar:", error);
  }
  renderEnv();
  renderHazard();
  drawMap();
  schedule(clockDoc.rate);
}

function schedule(rate) {
  const ms = rate >= 600 ? 250 : 1000;
  if (timer?.ms === ms) return;
  clearInterval(timer?.id);
  const id = setInterval(() => {
    if (!document.hidden) tick();
  }, ms);
  timer = { ms, id };
}

function anchorNow(patch) {
  const clockDoc = state.doc.clock;
  const now = hubNow();
  submit({
    t: "set",
    path: "clock",
    v: { ...clockDoc, anchorUtcMs: clockUtc(clockDoc, now), anchorWallMs: now, ...patch },
  });
}

function buildBar() {
  const bar = $("clock-bar");
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", t("clock.bar"));
  const rateOptions = RATES.map((rate) => `<option value="${rate}">×${rate}</option>`).join("");
  const chipTitle = esc(t("clock.chip.title"));
  const rateLabel = esc(t("clock.rate"));
  const playIcon = `<svg viewBox="0 0 16 16" aria-hidden="true">`
    + `<path id="clk-play-icon" d=""/></svg>`;
  bar.innerHTML = `<button type="button" class="clk-chip" id="clk-chip"
      title="${chipTitle}"></button>
    <span class="clk-cell clk-time" id="clk-time"></span>
    <span class="clk-cell clk-ls" id="clk-ls"></span>
    <span class="clk-cell clk-sun" id="clk-sun"></span>
    <span class="clk-cell clk-earth" id="clk-earth"></span>
    <button type="button" class="clk-btn" id="clk-play">${playIcon}</button>
    <select class="clk-rate" id="clk-rate" aria-label="${rateLabel}">${rateOptions}</select>`;

  $("clk-chip").addEventListener("click", openDialog);
  $("clk-play").addEventListener("click", () => {
    anchorNow({ paused: !state.doc.clock.paused });
  });
  $("clk-rate").addEventListener("change", (event) => {
    anchorNow({ rate: +event.target.value });
  });
}

function chipText(clockDoc, clock) {
  if (clockDoc.mode === "replay") return t("clock.chip.replay", { sol: clock.sol });
  if (clockDoc.mode === "live") return t("clock.chip.live");
  return t("clock.chip.scenario", { rate: clockDoc.rate });
}

function renderBar() {
  const clock = state.clock;
  const clockDoc = state.doc.clock;
  if (!clock.utcMs) return;

  setText($("clk-chip"), chipText(clockDoc, clock));
  setText($("clk-time"), t("clock.solltst", { sol: clock.sol, hm: fmtHM(clock.ltst) }));

  const lsText = t("clock.ls", { ls: num(clock.ls, 0), season: season(clock.season) });
  const dustText = clock.dustSeason ? ` · ${esc(t("clock.dust"))}` : "";
  $("clk-ls").innerHTML = `${esc(lsText)}<span class="clk-dust">${dustText}</span>`;

  const sun = $("clk-sun");
  const sunUp = clock.sunEl >= 0;
  const sunIcon = ico(sunUp ? "g-solar" : "g-moon");
  const sunHtml = `${sunIcon} ${num(clock.sunEl, 0)}°`;
  if (sun.dataset.h !== sunHtml) {
    sun.dataset.h = sunHtml;
    sun.innerHTML = sunHtml;
  }
  const sunTitleKey = sunUp ? "clock.sun.up" : "clock.sun.down";
  sun.title = t(sunTitleKey, { deg: num(Math.abs(clock.sunEl), 0) });

  const earthTime = new Date(clock.utcMs).toISOString().slice(0, 16).replace("T", " ");
  setText($("clk-earth"), t("clock.earth", { when: earthTime }));

  const play = $("clk-play");
  const live = clockDoc.mode === "live";
  play.setAttribute("aria-label", t(clockDoc.paused ? "clock.play" : "clock.pause"));
  play.title = play.getAttribute("aria-label");
  $("clk-play-icon").setAttribute("d", clockDoc.paused ? PLAY_PATH : PAUSE_PATH);
  play.disabled = live;

  const select = $("clk-rate");
  const rate = live ? 1 : clockDoc.rate;
  if (!RATES.includes(rate) && !select.querySelector(`option[value="${rate}"]`)) {
    select.add(new Option(`×${rate}`, rate));
  }
  select.value = String(rate);
  select.disabled = live;
  select.title = live ? t("clock.rate.live") : t("clock.rate");
}

function parseHM(text) {
  const [hours, minutes] = String(text).split(":").map(Number);
  return Number.isFinite(hours) ? hours + (minutes || 0) / 60 : null;
}

function utcInputValue(ms) {
  return new Date(ms).toISOString().slice(0, 16);
}

function solOptionHtml(entry, selectedSol) {
  const marsAtNoon = mars(solToUtc(entry.sol, 12));
  const dustNote = marsAtNoon.dustSeason ? t("clock.opt.dust") : "";
  const windNote = entry.wind_ms ? t("clock.opt.wind") : "";
  const extra = dustNote + windNote;
  const label = t("clock.opt.sol", {
    sol: entry.sol,
    ls: Math.round(entry.ls),
    season: season(marsAtNoon.season),
    extra,
  });
  const selected = entry.sol === selectedSol ? " selected" : "";
  return `<option value="${entry.sol}"${selected}>${esc(label)}</option>`;
}

function modeRadioHtml(mode, clockDoc, hasSols) {
  const checked = clockDoc.mode === mode ? " checked" : "";
  const disabled = mode === "replay" && !hasSols ? " disabled" : "";
  const name = esc(t(`clock.mode.${mode}`));
  const input = `<input type="radio" name="clk-mode" value="${mode}"${checked}${disabled}>`;
  return `<label class="clk-radio">${input}<span><b>${name}</b></span></label>`;
}

function presetButtonHtml(ls) {
  const label = t("clock.preset", { ls, season: season(seasonOf(ls)) });
  return `<button type="button" class="clk-preset" data-ls="${ls}">${esc(label)}</button>`;
}

function speedOptionsHtml(clockDoc) {
  const rates = [...new Set([...RATES, clockDoc.rate])].sort((a, b) => a - b);
  const selectedRate = clockDoc.mode === "live" ? 60 : clockDoc.rate;
  return rates
    .map((rate) => {
      const selected = rate === selectedRate ? " selected" : "";
      return `<option value="${rate}"${selected}>×${rate}</option>`;
    })
    .join("");
}

function dialogHtml(clockDoc, sols) {
  const selectedSol = clockDoc.replaySol ?? DEFAULT_REPLAY_SOL;
  const solOptions = sols.map((entry) => solOptionHtml(entry, selectedSol)).join("");
  const modeRadios = MODES.map((mode) => modeRadioHtml(mode, clockDoc, sols.length > 0)).join("");
  const presets = PRESET_LS.map(presetButtonHtml).join("");

  return `<form class="clk-form" method="dialog">
    <h2 id="clk-dlg-t">${esc(t("clock.dlg.title"))}</h2>
    <fieldset class="clk-modes"><legend>${esc(t("clock.mode"))}</legend>
      ${modeRadios}
    </fieldset>
    <p class="clk-desc" id="clk-desc"></p>
    <div class="clk-sec" data-mode="replay">
      <label class="clk-field">${esc(t("clock.pick.sol"))}<select
        id="ck-sol">${solOptions}</select></label>
      <label class="clk-field">${esc(t("clock.start"))}<input
        type="time" id="ck-r-ltst" value="11:00"></label>
    </div>
    <div class="clk-sec" data-mode="scenario">
      <label class="clk-field">${esc(t("clock.utc"))}<input
        type="datetime-local" id="ck-utc" step="60"></label>
      <div class="clk-row2">
        <label class="clk-field">${esc(t("clock.in.sol"))}<input
          type="number" id="ck-sol-n" min="0" max="4000" step="1" inputmode="numeric"></label>
        <label class="clk-field">${esc(t("clock.in.ltst"))}<input
          type="time" id="ck-ltst"></label>
        <label class="clk-field">${esc(t("clock.in.ls"))}<input
          type="number" id="ck-ls" min="0" max="359.9" step="0.1" inputmode="decimal"></label>
      </div>
      <div class="clk-presets" role="group"
        aria-label="${esc(t("clock.presets"))}">${presets}</div>
    </div>
    <label class="clk-field clk-speed" data-notmode="live">${esc(t("clock.speed"))}<select
      id="ck-rate">${speedOptionsHtml(clockDoc)}</select></label>
    <p class="hint">${esc(t("clock.dlg.sync"))}</p>
    <menu class="clk-actions"><button type="button" class="clk-primary"
      id="ck-apply">${esc(t("clock.apply"))}</button><button type="button"
      id="ck-cancel">${esc(t("clock.cancel"))}</button></menu>
  </form>`;
}

function openDialog() {
  const dlg = $("clock-dialog");
  const clockDoc = state.doc.clock;
  const current = state.clock.utcMs ?? Date.now();
  dlg.innerHTML = dialogHtml(clockDoc, envData?.sols ?? []);
  dlg.setAttribute("aria-labelledby", "clk-dlg-t");

  let target = current;

  const fillInputs = (except) => {
    const marsAtTarget = mars(target);
    if (except !== "utc") $("ck-utc").value = utcInputValue(target);
    if (except !== "sol") $("ck-sol-n").value = marsAtTarget.sol;
    if (except !== "ltst") $("ck-ltst").value = fmtHM(marsAtTarget.ltst);
    if (except !== "ls") $("ck-ls").value = marsAtTarget.ls.toFixed(1);
  };

  const selectedMode = () => dlg.querySelector('input[name="clk-mode"]:checked').value;

  const showMode = () => {
    const mode = selectedMode();
    for (const section of dlg.querySelectorAll("[data-mode]")) {
      section.hidden = section.dataset.mode !== mode;
    }
    dlg.querySelector("[data-notmode]").hidden = mode === "live";
    $("clk-desc").textContent = t(`clock.mode.${mode}.d`);
  };

  const onUtcChange = (event) => {
    const ms = Date.parse(`${event.target.value}:00Z`);
    if (!Number.isFinite(ms)) return;
    target = ms;
    fillInputs("utc");
  };

  const onSolOrLtstChange = () => {
    const solText = $("ck-sol-n").value;
    const ltstText = $("ck-ltst").value;
    const sol = +solText;
    const ltst = parseHM(ltstText);
    const filled = solText.trim() !== "" && ltstText.trim() !== "";
    if (filled && Number.isFinite(sol) && ltst != null) {
      target = solToUtc(sol, ltst);
      fillInputs();
    }
  };

  const goToLs = (ls) => {
    if (!Number.isFinite(ls)) return;
    const wrappedLs = ((ls % 360) + 360) % 360;
    const sol = mars(utcAtLs(wrappedLs, current)).sol;
    target = solToUtc(sol, 11);
    fillInputs();
  };

  const apply = () => {
    const mode = selectedMode();
    const now = hubNow();
    const rate = +$("ck-rate").value;
    if (mode === "live") {
      submit({
        t: "set",
        path: "clock",
        v: {
          mode: "live",
          replaySol: null,
          anchorUtcMs: now,
          anchorWallMs: now,
          rate: 1,
          paused: false,
        },
      });
    } else if (mode === "replay") {
      const sol = parseInt($("ck-sol").value, 10);
      const ltst = parseHM($("ck-r-ltst").value) ?? DEFAULT_REPLAY_LTST;
      if (!Number.isFinite(sol)) return;
      submit({
        t: "set",
        path: "clock",
        v: {
          mode: "replay",
          replaySol: sol,
          anchorUtcMs: solToUtc(sol, ltst),
          anchorWallMs: now,
          rate,
          paused: false,
        },
      });
    } else {
      submit({
        t: "set",
        path: "clock",
        v: {
          mode: "scenario",
          replaySol: null,
          anchorUtcMs: target,
          anchorWallMs: now,
          rate,
          paused: false,
        },
      });
    }
    dlg.close();
  };

  fillInputs();
  showMode();
  for (const radio of dlg.querySelectorAll('input[name="clk-mode"]')) {
    radio.addEventListener("change", showMode);
  }
  $("ck-utc").addEventListener("change", onUtcChange);
  $("ck-sol-n").addEventListener("change", onSolOrLtstChange);
  $("ck-ltst").addEventListener("change", onSolOrLtstChange);
  $("ck-ls").addEventListener("change", (event) => {
    if (event.target.value.trim() !== "") goToLs(parseFloat(event.target.value));
  });
  for (const button of dlg.querySelectorAll(".clk-preset")) {
    button.addEventListener("click", () => goToLs(+button.dataset.ls));
  }
  $("ck-cancel").addEventListener("click", () => dlg.close());
  dlg.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    $("ck-apply").click();
  });
  $("ck-apply").addEventListener("click", apply);

  dlg.showModal();
  dlg.querySelector('input[name="clk-mode"]:checked')?.focus();
}

function envRowHtml(key) {
  const name = t(`clock.v.${key}`);
  const expanded = openNotes.has(key);
  const infoLabel = esc(t("clock.env.info", { name }));
  const label = `<span class="clk-label">${esc(name)}</span>`;
  const value = `<span class="clk-val" id="ev-${key}">${DASH}</span>`;
  const tagSlot = `<span class="clk-tag" id="et-${key}"></span>`;
  const infoButton = `<button type="button" class="clk-info" data-k="${key}"`
    + ` aria-expanded="${expanded}" aria-controls="en-${key}" aria-label="${infoLabel}">`
    + `${ico("g-info")}</button>`;
  const note = `<div class="clk-note" id="en-${key}"${expanded ? "" : " hidden"}></div>`;
  return `<li class="clk-r" data-k="${key}">${label}${value}${tagSlot}${infoButton}${note}</li>`;
}

function envGroupHtml(group, rowDefs) {
  const spark = group === "met" ? `<figure class="clk-spark" id="env-spark"></figure>` : "";
  const items = rowDefs.map(([key]) => envRowHtml(key)).join("");
  const title = esc(t(`clock.g.${group}`));
  return `<section class="clk-group"><h3>${title}</h3>${spark}<ul>${items}</ul></section>`;
}

function buildEnv() {
  const pane = $("pane-env");
  if (envFailed) {
    pane.innerHTML = `<p class="clk-err">${esc(t("clock.env.err"))}</p>`;
    return;
  }
  const heading = `<h2 class="clk-h">${esc(t("clock.env.title"))}</h2>`;
  const source = `<p class="hint clk-source" id="env-source"></p>`;
  pane.innerHTML = heading + source
    + ENV_GROUPS.map(([group, rowDefs]) => envGroupHtml(group, rowDefs)).join("");

  for (const button of pane.querySelectorAll(".clk-info")) {
    button.addEventListener("click", () => {
      const key = button.dataset.k;
      const expand = !openNotes.has(key);
      if (expand) {
        openNotes.add(key);
      } else {
        openNotes.delete(key);
      }
      button.setAttribute("aria-expanded", String(expand));
      $(`en-${key}`).hidden = !expand;
      renderEnv();
    });
  }
  lastSparkSol = null;
  lastTags = {};
}

function formatValue(value, unit, decimals, signed) {
  if (value == null || !Number.isFinite(value)) return DASH;
  const sign = signed && value > 0 ? "+" : "";
  return `${sign}${num(value, decimals)}${unit ? ` ${unit}` : ""}`;
}

function valueText(key, reading, values, unit, decimals, signed) {
  if (key !== "wind") return formatValue(reading.v, unit, decimals, signed);
  const dir = values.wind_dir.v;
  const dirText = dir == null ? DASH : `${num(dir, 0)}°`;
  return `${formatValue(reading.v, "m/s", 1)} · ${dirText}`;
}

function noteHtml(key, reading, values) {
  const args = reading.noteArgs;
  const noteArgs = args?.label ? { ...args, label: shown(args.label) } : args ?? {};
  const parts = [
    reading.note ? t(reading.note, noteArgs) : "",
    key === "wind" && values.wind_dir.v != null ? t("clock.note.windConv") : "",
  ];
  const text = parts.filter(Boolean).join(" ");
  if (!reading.src) return esc(text);

  const isUrl = /^https?:/.test(reading.src);
  const source = isUrl
    ? `<a href="${esc(reading.src)}" target="_blank" rel="noopener noreferrer">MEDA PDS</a>`
    : esc(reading.src);
  return `${esc(text)} <span class="clk-src">${esc(t("clock.env.src"))}: ${source}</span>`;
}

function renderEnvRow([key, unit, decimals, signed], values) {
  const reading = values[key];
  const valueElement = $(`ev-${key}`);
  setText(valueElement, valueText(key, reading, values, unit, decimals, signed));

  const title = reading.v == null ? t("clock.env.nodata") : "";
  if (valueElement.title !== title) valueElement.title = title;

  const tagName = reading.v == null ? "" : reading.tag;
  if (lastTags[key] !== tagName) {
    lastTags[key] = tagName;
    $(`et-${key}`).innerHTML = tagName && tag(tagName);
  }

  if (openNotes.has(key)) {
    const html = noteHtml(key, reading, values);
    const note = $(`en-${key}`);
    if (note.innerHTML !== html) note.innerHTML = html;
  }
}

function renderEnv() {
  const env = state.env;
  const values = env?.values;
  if (!values || !$("env-source")) return;

  const source = env.source;
  $("env-source").textContent = source.kind === "replay"
    ? t("clock.env.source.replay", { sol: source.sol })
    : t("clock.env.source.climatology", { sol: source.sol, ls: Math.round(source.ls) });

  for (const [, rowDefs] of ENV_GROUPS) {
    for (const rowDef of rowDefs) {
      renderEnvRow(rowDef, values);
    }
  }
  renderSpark(source.sol);
}

function sparkX(hour) {
  return SPARK_PAD_X + (hour / 24) * SPARK_WIDTH;
}

function sparkY(value, lo, hi) {
  return SPARK_BOTTOM - ((value - lo) / (hi - lo || 1)) * SPARK_HEIGHT;
}

function sparkHtml(temps) {
  const points = temps.map((v, hour) => (v == null ? null : [hour, v])).filter(Boolean);
  const lo = Math.min(...points.map(([, v]) => v));
  const hi = Math.max(...points.map(([, v]) => v));
  const polyline = points
    .map(([hour, v]) => `${sparkX(hour).toFixed(1)},${sparkY(v, lo, hi).toFixed(1)}`)
    .join(" ");
  const svgOpen = `<svg viewBox="0 0 240 56" role="img" aria-label="${esc(t("clock.env.spark"))}"`
    + ` preserveAspectRatio="none">`;
  const frame = `<rect x="0.5" y="0.5" width="239" height="55" fill="none"`
    + ` stroke="currentColor" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  const line = `<polyline fill="none" stroke="currentColor" stroke-width="2"`
    + ` vector-effect="non-scaling-stroke" points="${polyline}"/>`;
  const dot = `<circle id="env-dot" r="4" fill="currentColor"/>`;
  const range = `${esc(t("clock.v.t_air"))} · ${num(lo, 0)} … ${num(hi, 0)} °C`;
  const caption = `<figcaption><span>00:00</span><span>${range}</span>`
    + `<span>24:00</span></figcaption>`;
  const html = `${svgOpen}${frame}${line}${dot}</svg>${caption}`;
  return { html, lo, hi };
}

function renderSpark(sol) {
  const figure = $("env-spark");
  const temps = envData?.bySol.get(sol)?.t_air_c;
  if (!figure || !temps) return;

  if (lastSparkSol !== sol) {
    lastSparkSol = sol;
    const { html, lo, hi } = sparkHtml(temps);
    figure.innerHTML = html;
    figure.dataset.lo = lo;
    figure.dataset.hi = hi;
  }

  const dot = $("env-dot");
  const ltst = state.clock.ltst;
  const temp = at(temps, ltst);
  if (dot && temp != null) {
    const lo = +figure.dataset.lo;
    const hi = +figure.dataset.hi;
    dot.setAttribute("cx", sparkX(ltst).toFixed(1));
    dot.setAttribute("cy", sparkY(temp, lo, hi).toFixed(1));
    dot.removeAttribute("hidden");
  } else {
    dot?.setAttribute("hidden", "");
  }
}

function renderHazard() {
  const slot = $("hazard-slot");
  const hazard = state.env?.hazard;
  const warningOnly = hazard && hazard.level >= 1 && hazard.level < 2;
  if (!warningOnly) {
    if (slot.innerHTML) slot.innerHTML = "";
    return;
  }

  const key = `${hazard.level}|${hazard.reasons.join()}|${hazard.tag}|${hazard.label ?? ""}`;
  if (slot.dataset.key !== key || !$("hz-val")) {
    slot.dataset.key = key;
    const reasons = hazard.reasons.map((reason) => esc(t(`clock.hz.r.${reason}`))).join(" ");
    const label = hazard.label ? ` ${esc(shown(hazard.label))}` : "";
    slot.innerHTML = `<section class="z535 clk-hazard" data-tone="warning" role="status"
      aria-labelledby="hz-t">
      <div class="symbol">${HAZARD_ICON}</div>
      <h2 class="band" id="hz-t"><span>${esc(t("clock.hz.warning"))}</span></h2>
      <div class="body" aria-live="off"><span class="value" id="hz-val"></span> ${tag(hazard.tag)}
        <p class="detail">${reasons}${label}</p><p class="detail" id="hz-act"></p></div></section>`;
  }

  const line = t("clock.hz.line", { tau: num(hazard.tau, 1), wind: num(hazard.wind_ms, 0) });
  setText($("hz-val"), line);
  const homeMin = state.plan?.homeMin;
  let action;
  if (homeMin === 0) {
    action = t("clock.hz.home.at");
  } else if (homeMin == null) {
    action = t("clock.hz.home.none");
  } else {
    action = t("clock.hz.home", { min: `${num(homeMin, 0)} min` });
  }
  setText($("hz-act"), action);
}

function drawStorm(map, hazard) {
  const key = hazard?.level >= 1
    ? [hazard.cell, hazard.radius_m, num(hazard.tau, 1), hazard.level].join("|")
    : "";
  if (drawn.storm === key) return;
  drawn.storm = key;
  if (!key) {
    map.markers("clock:storm", null);
    return;
  }
  const marker = {
    cell: hazard.cell,
    kind: "storm",
    id: "storm",
    label: t("clock.hz.plate", { tau: num(hazard.tau, 1) }),
    ...(hazard.radius_m ? { radius_m: hazard.radius_m } : {}),
  };
  map.markers("clock:storm", [marker]);
}

function drawWind(map, values) {
  const dir = values?.wind_dir?.v;
  const key = dir == null ? "" : `${Math.round(dir)}|${num(values.wind.v, 0)}`;
  if (drawn.wind === key) return;
  drawn.wind = key;
  if (!key) {
    map.markers("clock:wind", null);
    return;
  }
  const marker = {
    cell: ctx.data.habitat,
    kind: "wind",
    id: "wind",
    rotate: (dir + 180) % 360,
    label: t("clock.wind.label", { ms: num(values.wind.v, 0), deg: num(dir, 0) }),
  };
  map.markers("clock:wind", [marker]);
}

function drawMap() {
  const map = ctx.map;
  if (!map) return;
  drawStorm(map, state.env?.hazard);
  drawWind(map, state.env?.values);
}

export async function init(c) {
  ctx = c;
  buildBar();
  try {
    envData = await loadEnv();
  } catch (error) {
    envFailed = true;
    console.error("ARIADNE env data:", error);
  }
  buildEnv();
  tick(true);

  on("doc", (doc) => {
    const overrideChanged = (doc.env?.override ?? null) !== lastOverride;
    if (doc.clock !== lastClock || overrideChanged) tick(true);
  });
  on("plan", () => renderHazard());
  on("lang", () => {
    buildBar();
    buildEnv();
    lastTags = {};
    drawn = { storm: null, wind: null };
    lastHazardKey = "";
    $("hazard-slot").innerHTML = "";
    const dlg = $("clock-dialog");
    if (dlg.open) {
      dlg.close();
      openDialog();
    }
    tick(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tick(true);
  });
}
