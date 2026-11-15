import { state, set, on } from "./store.js";
import { t, num } from "./i18n.js";
import { $, esc, tag } from "./ui.js";
import { mars, solToUtc, clockUtc, utcAtLs, fmtHM } from "./marsclock.js";
import { loadEnv, resolveEnv, at } from "./env.js";
import { submit, hubNow } from "./sync.js";

const RATES = [1, 60, 600, 3600], PRESETS = [0, 90, 180, 270];
let ctx, envData = null, envFailed = false, timer = null, lastCk = null, lastOv, lastUtc = null, lastHz = "", lastAnn = 0, lastAnnCk = null, drawn = { storm: null, wind: null };
const open = new Set();
const season = (s) => t(`clock.season.${s}`);
const dash = "—";

function tick(force) {
  const ck = state.doc.clock, ov = state.doc.env?.override ?? null, utc = clockUtc(ck, hubNow());
  if (!Number.isFinite(utc) || Math.abs(utc) > 8.64e15) return;
  if (!force && utc === lastUtc && ck === lastCk && ov === lastOv) return;
  lastUtc = utc; lastCk = ck; lastOv = ov;
  const m = mars(utc);
  const clock = { utcMs: utc, sol: ck.mode === "replay" && ck.replaySol != null ? ck.replaySol : m.sol, ltst: m.ltst, lmst: m.lmst, ls: m.ls, season: m.season, dustSeason: m.dustSeason, sunEl: m.sunEl, sunAz: m.sunAz,
    rAU: m.rAU, mode: ck.mode, rate: ck.rate, paused: !!ck.paused, replaySol: ck.replaySol ?? null };
  let env = {};
  if (envData) {
    env = resolveEnv(envData, m, ck, ov, utc);
    env.hazard.cell ??= ctx.data.habitat;
  }
  const hz = env.hazard, key = hz ? [hz.level, hz.cell, hz.radius_m, hz.tag, hz.label, hz.reasons.join()].join("|") : "";
  state.env = env; state.clock = clock;
  if (key !== lastHz) { lastHz = key; set("env", env, true); }
  const wall = performance.now();
  if (force || ck !== lastAnnCk || wall - lastAnn >= 900) { lastAnn = wall; lastAnnCk = ck; set("clock", clock, true); }
  try { renderBar(); } catch (e) { console.error("ARIADNE clock bar:", e); }
  renderEnv(); renderHazard(); drawMap();
  schedule(ck.rate);
}
function schedule(rate) {
  const ms = rate >= 600 ? 250 : 1000;
  if (timer?.ms === ms) return;
  clearInterval(timer?.id);
  timer = { ms, id: setInterval(() => { if (!document.hidden) tick(); }, ms) };
}

function anchorNow(patch) {
  const ck = state.doc.clock, now = hubNow();
  submit({ t: "set", path: "clock", v: { ...ck, anchorUtcMs: clockUtc(ck, now), anchorWallMs: now, ...patch } });
}

function buildBar() {
  const bar = $("clock-bar");
  bar.setAttribute("role", "group"); bar.setAttribute("aria-label", t("clock.bar"));
  bar.innerHTML = `<button type="button" class="clk-chip" id="clk-chip" title="${esc(t("clock.chip.title"))}"></button>
    <span class="clk-cell clk-time" id="clk-time"></span>
    <span class="clk-cell clk-ls" id="clk-ls"></span>
    <span class="clk-cell clk-sun" id="clk-sun"></span>
    <span class="clk-cell clk-earth" id="clk-earth"></span>
    <button type="button" class="clk-btn" id="clk-play"><svg viewBox="0 0 16 16" aria-hidden="true"><path id="clk-play-icon" d=""/></svg></button>
    <select class="clk-rate" id="clk-rate" aria-label="${esc(t("clock.rate"))}">${RATES.map((r) => `<option value="${r}">×${r}</option>`).join("")}</select>`;
  $("clk-chip").addEventListener("click", openDialog);
  $("clk-play").addEventListener("click", () => anchorNow({ paused: !state.doc.clock.paused }));
  $("clk-rate").addEventListener("change", (e) => anchorNow({ rate: +e.target.value }));
}
const PLAY = "M4 2L13 8L4 14Z", PAUSE = "M3.5 2H7V14H3.5ZM9 2H12.5V14H9Z";
function renderBar() {
  const c = state.clock, ck = state.doc.clock;
  if (!c.utcMs) return;
  const chip = ck.mode === "replay" ? t("clock.chip.replay", { sol: c.sol }) : ck.mode === "live" ? t("clock.chip.live") : t("clock.chip.scenario", { rate: ck.rate });
  const txt = (id, s) => { const e = $(id); if (e.textContent !== s) e.textContent = s; };
  txt("clk-chip", chip);
  txt("clk-time", t("clock.solltst", { sol: c.sol, hm: fmtHM(c.ltst) }));
  const ls = $("clk-ls"), lsTxt = t("clock.ls", { ls: num(c.ls, 0), season: season(c.season) });
  ls.innerHTML = `${esc(lsTxt)}<span class="clk-dust">${c.dustSeason ? ` · ${esc(t("clock.dust"))}` : ""}</span>`;
  const sun = $("clk-sun"); sun.textContent = `${c.sunEl >= 0 ? "☼" : "☾"} ${num(c.sunEl, 0)}°`;
  sun.title = t(c.sunEl >= 0 ? "clock.sun.up" : "clock.sun.down", { deg: num(Math.abs(c.sunEl), 0) });
  txt("clk-earth", t("clock.earth", { when: new Date(c.utcMs).toISOString().slice(0, 16).replace("T", " ") }));
  const play = $("clk-play"), live = ck.mode === "live";
  play.setAttribute("aria-label", t(ck.paused ? "clock.play" : "clock.pause")); play.title = play.getAttribute("aria-label");
  $("clk-play-icon").setAttribute("d", ck.paused ? PLAY : PAUSE);
  play.disabled = live;
  const sel = $("clk-rate"), r = live ? 1 : ck.rate;
  if (!RATES.includes(r) && !sel.querySelector(`option[value="${r}"]`)) sel.add(new Option(`×${r}`, r));
  sel.value = String(r); sel.disabled = live; sel.title = live ? t("clock.rate.live") : t("clock.rate");
}

const parseHM = (s) => { const [a, b] = String(s).split(":").map(Number); return Number.isFinite(a) ? a + (b || 0) / 60 : null; };
const utcLocal = (ms) => new Date(ms).toISOString().slice(0, 16);

function openDialog() {
  const dlg = $("clock-dialog"), ck = state.doc.clock, cur = state.clock.utcMs ?? Date.now();
  const sols = envData?.sols ?? [];
  const solOpt = (s) => {
    const m = mars(solToUtc(s.sol, 12));
    return `<option value="${s.sol}"${s.sol === (ck.replaySol ?? 1210) ? " selected" : ""}>${esc(t("clock.opt.sol", {
      sol: s.sol, ls: Math.round(s.ls), season: season(m.season), extra: (m.dustSeason ? t("clock.opt.dust") : "") + (s.wind_ms ? t("clock.opt.wind") : "") }))}</option>`;
  };
  const m0 = mars(cur);
  dlg.innerHTML = `<form class="clk-form" method="dialog">
    <h2 id="clk-dlg-t">${esc(t("clock.dlg.title"))}</h2>
    <fieldset class="clk-modes"><legend>${esc(t("clock.mode"))}</legend>
      ${["replay", "live", "scenario"].map((k) => `<label class="clk-radio"><input type="radio" name="clk-mode" value="${k}"${ck.mode === k ? " checked" : ""}${k === "replay" && !sols.length ? " disabled" : ""}><span><b>${esc(t(`clock.mode.${k}`))}</b></span></label>`).join("")}
    </fieldset>
    <p class="clk-desc" id="clk-desc"></p>
    <div class="clk-sec" data-mode="replay">
      <label class="clk-field">${esc(t("clock.pick.sol"))}<select id="ck-sol">${sols.map(solOpt).join("")}</select></label>
      <label class="clk-field">${esc(t("clock.start"))}<input type="time" id="ck-r-ltst" value="11:00"></label>
    </div>
    <div class="clk-sec" data-mode="scenario">
      <label class="clk-field">${esc(t("clock.utc"))}<input type="datetime-local" id="ck-utc" step="60"></label>
      <div class="clk-row2">
        <label class="clk-field">${esc(t("clock.in.sol"))}<input type="number" id="ck-sol-n" min="0" max="4000" step="1" inputmode="numeric"></label>
        <label class="clk-field">${esc(t("clock.in.ltst"))}<input type="time" id="ck-ltst"></label>
        <label class="clk-field">${esc(t("clock.in.ls"))}<input type="number" id="ck-ls" min="0" max="359.9" step="0.1" inputmode="decimal"></label>
      </div>
      <div class="clk-presets" role="group" aria-label="${esc(t("clock.presets"))}">${PRESETS.map((l) => `<button type="button" class="clk-preset" data-ls="${l}">${esc(t("clock.preset", { ls: l, season: season(["spring", "summer", "autumn", "winter"][l / 90]) }))}</button>`).join("")}</div>
    </div>
    <label class="clk-field clk-speed" data-notmode="live">${esc(t("clock.speed"))}<select id="ck-rate">${[...new Set([...RATES, ck.rate])].sort((a, b) => a - b).map((r) => `<option value="${r}"${r === (ck.mode === "live" ? 60 : ck.rate) ? " selected" : ""}>×${r}</option>`).join("")}</select></label>
    <p class="hint">${esc(t("clock.dlg.sync"))}</p>
    <menu class="clk-actions"><button type="button" class="clk-primary" id="ck-apply">${esc(t("clock.apply"))}</button><button type="button" id="ck-cancel">${esc(t("clock.cancel"))}</button></menu>
  </form>`;
  dlg.setAttribute("aria-labelledby", "clk-dlg-t");

  let target = cur;
  const sync = (except) => {
    const m = mars(target);
    if (except !== "utc") $("ck-utc").value = utcLocal(target);
    if (except !== "sol") $("ck-sol-n").value = m.sol;
    if (except !== "ltst") $("ck-ltst").value = fmtHM(m.ltst);
    if (except !== "ls") $("ck-ls").value = m.ls.toFixed(1);
  };
  const mode = () => dlg.querySelector('input[name="clk-mode"]:checked').value;
  const showMode = () => {
    const k = mode();
    for (const s of dlg.querySelectorAll("[data-mode]")) s.hidden = s.dataset.mode !== k;
    dlg.querySelector("[data-notmode]").hidden = k === "live";
    $("clk-desc").textContent = t(`clock.mode.${k}.d`);
  };
  sync(); showMode();
  for (const r of dlg.querySelectorAll('input[name="clk-mode"]')) r.addEventListener("change", showMode);
  $("ck-utc").addEventListener("change", (e) => { const v = Date.parse(`${e.target.value}:00Z`); if (Number.isFinite(v)) { target = v; sync("utc"); } });
  const bySol = () => {
    const sv = $("ck-sol-n").value, hv = $("ck-ltst").value, s = +sv, h = parseHM(hv);
    if (sv.trim() !== "" && hv.trim() !== "" && Number.isFinite(s) && h != null) { target = solToUtc(s, h); sync(); } };
  $("ck-sol-n").addEventListener("change", bySol); $("ck-ltst").addEventListener("change", bySol);
  const byLs = (ls) => { if (Number.isFinite(ls)) { target = solToUtc(mars(utcAtLs(((ls % 360) + 360) % 360, cur)).sol, 11); sync(); } };
  $("ck-ls").addEventListener("change", (e) => e.target.value.trim() !== "" && byLs(parseFloat(e.target.value)));
  for (const b of dlg.querySelectorAll(".clk-preset")) b.addEventListener("click", () => byLs(+b.dataset.ls));
  $("ck-cancel").addEventListener("click", () => dlg.close());
  dlg.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); $("ck-apply").click(); });
  $("ck-apply").addEventListener("click", () => {
    const k = mode(), now = hubNow(), rate = +$("ck-rate").value;
    if (k === "live") submit({ t: "set", path: "clock", v: { mode: "live", replaySol: null, anchorUtcMs: now, anchorWallMs: now, rate: 1, paused: false } });
    else if (k === "replay") {
      const sol = parseInt($("ck-sol").value, 10), h = parseHM($("ck-r-ltst").value) ?? 11;
      if (!Number.isFinite(sol)) return;
      submit({ t: "set", path: "clock", v: { mode: "replay", replaySol: sol, anchorUtcMs: solToUtc(sol, h), anchorWallMs: now, rate, paused: false } });
    } else submit({ t: "set", path: "clock", v: { mode: "scenario", replaySol: null, anchorUtcMs: target, anchorWallMs: now, rate, paused: false } });
    dlg.close();
  });
  dlg.showModal();
  dlg.querySelector('input[name="clk-mode"]:checked')?.focus();
}

const ROWS = [
  ["met", [["t_air", "°C", 1], ["t_ground", "°C", 1], ["wind"], ["rh", "%", 0], ["tau", "", 2]]],
  ["atm", [["pressure", "Pa", 0], ["density", "kg/m³", 4], ["pressure_var", "Pa", 1, true], ["t_air_var", "°C", 1, true]]],
  ["rad", [["uv", "W/m²", 1], ["rad", "µGy/day", 0]]],
];
function buildEnv() {
  const pane = $("pane-env");
  if (envFailed) { pane.innerHTML = `<p class="clk-err">${esc(t("clock.env.err"))}</p>`; return; }
  pane.innerHTML = `<h2 class="clk-h">${esc(t("clock.env.title"))}</h2><p class="hint clk-source" id="env-source"></p>` +
    ROWS.map(([g, rows]) => `<section class="clk-group"><h3>${esc(t(`clock.g.${g}`))}</h3>${g === "met" ? `<figure class="clk-spark" id="env-spark"></figure>` : ""}<ul>` +
      rows.map(([k]) => `<li class="clk-r" data-k="${k}"><span class="clk-label">${esc(t(`clock.v.${k}`))}</span><span class="clk-val" id="ev-${k}">${dash}</span><span class="clk-tag" id="et-${k}"></span>` +
        `<button type="button" class="clk-info" data-k="${k}" aria-expanded="${open.has(k)}" aria-controls="en-${k}" aria-label="${esc(t("clock.env.info", { name: t(`clock.v.${k}`) }))}">ⓘ</button>` +
        `<div class="clk-note" id="en-${k}"${open.has(k) ? "" : " hidden"}></div></li>`).join("") + `</ul></section>`).join("");
  for (const b of pane.querySelectorAll(".clk-info")) b.addEventListener("click", () => {
    const k = b.dataset.k, on = !open.has(k);
    on ? open.add(k) : open.delete(k);
    b.setAttribute("aria-expanded", String(on)); $(`en-${k}`).hidden = !on; renderEnv();
  });
  lastSpark = null; lastTag = {};
}
let lastSpark = null, lastTag = {};
const fmt = (v, unit, d, signed) => (v == null || !Number.isFinite(v) ? dash : `${signed && v > 0 ? "+" : ""}${num(v, d)}${unit ? ` ${unit}` : ""}`);
function renderEnv() {
  const e = state.env, vals = e?.values;
  if (!vals || !$("env-source")) return;
  const src = e.source;
  $("env-source").textContent = src.kind === "replay" ? t("clock.env.source.replay", { sol: src.sol }) : t("clock.env.source.climatology", { sol: src.sol, ls: Math.round(src.ls) });
  for (const [, rows] of ROWS) for (const [k, unit, d, signed] of rows) {
    const x = vals[k];
    const txt = k === "wind" ? `${fmt(x.v, "m/s", 1)} · ${vals.wind_dir.v == null ? dash : `${num(vals.wind_dir.v, 0)}°`}` : fmt(x.v, unit, d, signed), ve = $(`ev-${k}`);
    if (ve.textContent !== txt) ve.textContent = txt;
    const ttl = x.v == null ? t("clock.env.nodata") : "";
    if (ve.title !== ttl) ve.title = ttl;
    const tg = x.v == null ? "" : x.tag;
    if (lastTag[k] !== tg) { lastTag[k] = tg; $(`et-${k}`).innerHTML = tg && tag(tg); }
    if (open.has(k)) {
      const n = [x.note ? t(x.note, x.noteArgs ?? {}) : "", k === "wind" && vals.wind_dir.v != null ? t("clock.note.windConv") : ""].filter(Boolean).join(" "), url = /^https?:/.test(x.src ?? "");
      const html = `${esc(n)}${x.src ? ` <span class="clk-src">${esc(t("clock.env.src"))}: ${url ? `<a href="${esc(x.src)}" target="_blank" rel="noopener noreferrer">MEDA PDS</a>` : esc(x.src)}</span>` : ""}`;
      if ($(`en-${k}`).innerHTML !== html) $(`en-${k}`).innerHTML = html;
    }
  }
  renderSpark(src.sol);
}
function renderSpark(sol) {
  const fig = $("env-spark"), s = envData?.bySol.get(sol)?.t_air_c;
  if (!fig || !s) return;
  if (lastSpark !== sol) {
    lastSpark = sol;
    const pts = s.map((v, h) => (v == null ? null : [h, v])).filter(Boolean), lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
    const X = (h) => 4 + (h / 24) * 232, Y = (v) => 52 - ((v - lo) / (hi - lo || 1)) * 44;
    fig.innerHTML = `<svg viewBox="0 0 240 56" role="img" aria-label="${esc(t("clock.env.spark"))}" preserveAspectRatio="none"><rect x="0.5" y="0.5" width="239" height="55" fill="none" stroke="currentColor" stroke-width="1" vector-effect="non-scaling-stroke"/>` +
      `<polyline fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" points="${pts.map(([h, v]) => `${X(h).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}"/><circle id="env-dot" r="4" fill="currentColor"/></svg>` +
      `<figcaption><span>00:00</span><span>${esc(t("clock.v.t_air"))} · ${num(lo, 0)} … ${num(hi, 0)} °C</span><span>24:00</span></figcaption>`;
    fig.dataset.lo = lo; fig.dataset.hi = hi;
  }
  const dot = $("env-dot"), v = at(s, state.clock.ltst), lo = +fig.dataset.lo, hi = +fig.dataset.hi;
  if (dot && v != null) { dot.setAttribute("cx", (4 + (state.clock.ltst / 24) * 232).toFixed(1)); dot.setAttribute("cy", (52 - ((v - lo) / (hi - lo || 1)) * 44).toFixed(1)); dot.removeAttribute("hidden"); }
  else dot?.setAttribute("hidden", "");
}

const TRI = `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 4L45 41H3Z" style="fill:var(--yellow);stroke:var(--ink)" stroke-width="3" stroke-linejoin="round"/><path d="M12 31q4-4 8 0t8 0 8 0M14 24q3-3 6 0t6 0 6 0" fill="none" style="stroke:var(--ink)" stroke-width="2.5"/></svg>`;
function renderHazard() {
  const slot = $("hazard-slot"), hz = state.env?.hazard;
  if (!hz || hz.level < 1) { if (slot.innerHTML) slot.innerHTML = ""; return; }
  const key = `${hz.level}|${hz.reasons.join()}|${hz.tag}|${hz.label ?? ""}`;
  if (slot.dataset.key !== key || !$("hz-val")) {
    slot.dataset.key = key;
    slot.innerHTML = `<section class="z535 clk-hazard" data-tone="${hz.level >= 2 ? "danger" : "warning"}" role="${hz.level >= 2 ? "alert" : "status"}" aria-labelledby="hz-t">
      <div class="symbol">${TRI}</div>
      <h2 class="band" id="hz-t"><span>${esc(t(hz.level >= 2 ? "clock.hz.danger" : "clock.hz.warning"))}</span></h2>
      <div class="body" aria-live="off"><span class="value" id="hz-val"></span> ${tag(hz.tag)}
        <p class="detail">${hz.reasons.map((r) => esc(t(`clock.hz.r.${r}`))).join(" ")}${hz.label ? ` ${esc(hz.label)}` : ""}</p><p class="detail" id="hz-act"></p></div></section>`;
  }
  const w = (id, s) => { const e = $(id); if (e.textContent !== s) e.textContent = s; };
  w("hz-val", t("clock.hz.line", { tau: num(hz.tau, 1), wind: num(hz.wind_ms, 0) }));
  const m = state.plan?.homeMin;
  w("hz-act", m === 0 ? t("clock.hz.home.at") : m == null ? t("clock.hz.home.none") : t("clock.hz.home", { min: `${num(m, 0)} min` }));
}
function drawMap() {
  const map = ctx.map, hz = state.env?.hazard, v = state.env?.values;
  if (!map) return;
  const sk = hz?.level >= 1 ? [hz.cell, hz.radius_m, num(hz.tau, 1), hz.level].join("|") : "";
  if (drawn.storm !== sk) {
    drawn.storm = sk;
    map.markers("clock:storm", sk ? [{ cell: hz.cell, kind: "storm", id: "storm", label: t("clock.hz.plate", { tau: num(hz.tau, 1) }), ...(hz.radius_m ? { radius_m: hz.radius_m } : {}) }] : null);
  }
  const wk = v?.wind_dir?.v == null ? "" : `${Math.round(v.wind_dir.v)}|${num(v.wind.v, 0)}`;
  if (drawn.wind !== wk) {
    drawn.wind = wk;
    map.markers("clock:wind", wk ? [{ cell: ctx.data.habitat, kind: "wind", id: "wind", rotate: (v.wind_dir.v + 180) % 360, label: t("clock.wind.label", { ms: num(v.wind.v, 0), deg: num(v.wind_dir.v, 0) }) }] : null);
  }
}

export async function init(c) {
  ctx = c;
  buildBar();
  try { envData = await loadEnv(); } catch (e) { envFailed = true; console.error("ARIADNE env data:", e); }
  buildEnv();
  tick(true);
  on("doc", (doc) => { if (doc.clock !== lastCk || (doc.env?.override ?? null) !== lastOv) tick(true); });
  on("plan", () => renderHazard());
  on("lang", () => {
    buildBar(); buildEnv(); lastTag = {}; drawn = { storm: null, wind: null }; lastHz = ""; $("hazard-slot").innerHTML = "";
    const dlg = $("clock-dialog"); if (dlg.open) { dlg.close(); openDialog(); }
    tick(true);
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(true); });
}
