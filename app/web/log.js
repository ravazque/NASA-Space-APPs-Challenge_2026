import { state, set, on } from "./store.js";
import { t, tEn, num, apply, has, shown as inMyLang } from "./i18n.js";
import { $, esc, h, tag, toast } from "./ui.js";
import { submit, hubNow } from "./sync.js";
import { mars } from "./marsclock.js";
import { cellsInPolygon, cellToLatLng } from "./geo.js";
import { supersededIds } from "./effects.js";

export const SECTIONS = ["fault", "env_change", "route_deviation", "hazard", "sample", "equipment", "note"];
export const SEV_SECTIONS = new Set(["fault", "hazard", "env_change"]);
export const PROFILE_IDS = ["foot", "vehicle", "cargo"];
export const ZONE_MAX_CELLS = 9000, POLY_MAX = 64;
export const PHOTO_MAX = 45000;
const PHOTO_RE = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/;

const clip = (v, n) => String(v ?? "").trim().slice(0, n);
const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);
export const ENUMS = {
  fault: ["scarp", "fracture", "collapse", "other"],
  env: ["dust_devil", "dust_rise", "frost", "wind", "other"],
  hazard: ["rock", "loose_sand", "slope", "other"],
  eq: ["ok", "fault", "left_here"],
};
const DATA = {
  fault: (d) => ({ kind: oneOf(d.kind, ENUMS.fault, "other"), ...(Number.isFinite(d.offset_m) && d.offset_m >= 0 ? { offset_m: d.offset_m } : {}) }),
  env_change: (d) => ({ what: oneOf(d.what, ENUMS.env, "other") }),
  route_deviation: (d) => ({ path: (Array.isArray(d.path) ? d.path : []).filter(Number.isInteger).slice(0, 500), reason: clip(d.reason, 80) }),
  hazard: (d) => ({ kind: oneOf(d.kind, ENUMS.hazard, "other") }),
  sample: (d) => ({ sample_id: clip(d.sample_id, 40), rock: clip(d.rock, 40) }),
  equipment: (d) => ({ item: clip(d.item, 40), state: oneOf(d.state, ENUMS.eq, "ok") }),
  note: () => ({}),
};

export function makeEntry(f, { id, me, clock, wallMs = Date.now(), tag: tg = "REPORTED" }) {
  if (!SECTIONS.includes(f.section)) throw new Error("section");
  if (!Number.isInteger(f.cell) || f.cell < 0) throw new Error("cell");
  const title = clip(f.title, 60);
  if (!title) throw new Error("title");
  if (f.photo && !(f.photo.length <= PHOTO_MAX && PHOTO_RE.test(f.photo))) throw new Error("photo");
  const data = DATA[f.section](f.data ?? {});
  if (f.supersedes) data.supersedes = clip(f.supersedes, 60);
  if (f.photo) data.photo = f.photo;
  const profiles = PROFILE_IDS.filter((p) => (f.profiles ?? PROFILE_IDS).includes(p));
  return {
    id, section: f.section,
    severity: SEV_SECTIONS.has(f.section) ? Math.min(3, Math.max(1, Math.round(Number(f.severity)) || 2)) : 1,
    cell: f.cell, radius_m: Math.min(200, Math.max(0, Math.round(Number(f.radius_m ?? 40)) || 0)),
    profiles: profiles.length ? profiles : [...PROFILE_IDS],
    title, note: clip(f.note, 500), data,
    author: { deviceId: me.deviceId, crew: clip(me.crew, 12) },
    utcMs: clock.utcMs, wallMs, sol: clock.sol ?? null, ltst: clock.ltst ?? null, tag: tg, status: "open",
  };
}

export function listEntries(doc, { section = null } = {}) {
  const all = doc.logOrder.map((id) => doc.log[id]).filter(Boolean), sup = supersededIds(all), out = [];
  for (let i = all.length - 1; i >= 0; i--) if (!section || all[i].section === section) out.push({ e: all[i], superseded: sup.has(all[i].id) });
  return out;
}
export const activeCount = (doc) => listEntries(doc).filter(({ e, superseded }) => !superseded && e.status !== "resolved").length;

export function canSetStatus(e, status, me) {
  if (!e || e.status === "resolved" || e.status === status || e.provisional) return false;
  const mine = e.author?.deviceId === me.deviceId;
  return status === "resolved" ? mine || me.role === "base" : status === "confirmed" ? !mine && e.status === "open" : false;
}

export const canCorrect = (e, superseded, me) => !!e && !superseded && e.status !== "resolved" && (e.author?.deviceId === me.deviceId || me.role === "base");

export const thinPoly = (poly) => { const n = Math.ceil(poly.length / POLY_MAX); return n > 1 ? poly.filter((_, i) => i % n === 0).slice(0, POLY_MAX) : poly; };
export const zoneTarget = (deviceId, n) => `zone:${deviceId}:${n % 1e9}`;
export const EQUIP_ID_RE = /^[\w-]{1,32}$/;

const MARKER = { fault: "fault", hazard: "hazard", sample: "sample", equipment: "equipment", env_change: "note", route_deviation: "note", note: "note" };
export const markerOf = (e, onClick, secLabel = (s) => s) => ({
  id: e.id, cell: e.cell, kind: MARKER[e.section] ?? "note", label: inMyLang(e.title), sub: `${e.author?.crew ?? ""} · ${secLabel(e.section)}`,
  provisional: !!e.provisional, stale: e.status === "resolved",
  ...(SEV_SECTIONS.has(e.section) && e.severity >= 2 && e.status !== "resolved" ? { radius_m: e.radius_m } : {}), onClick,
});

const pad = (n) => String(n).padStart(2, "0");
export const hhmm = (h) => (Number.isFinite(h) ? `${pad(Math.floor(h) % 24)}:${pad(Math.floor(h * 60) % 60)}` : "--:--");
export const utcLabel = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "");

export function missionClock() {
  const ck = state.clock;
  if (ck?.utcMs != null) return { utcMs: ck.utcMs, sol: ck.sol ?? null, ltst: ck.ltst ?? null };
  const utcMs = hubNow();
  try { const m = mars(utcMs); return { utcMs, sol: m.sol, ltst: m.ltst }; } catch { return { utcMs, sol: null, ltst: null }; }
}

const svg = (d) => `<svg class="log-glyph" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round">${d}</svg>`;
const SEC_GLYPH = {
  fault: svg('<path d="M5 3l5 7-5 3 7 4-3 4"/>'),
  env_change: svg('<path d="M3 9h11a3 3 0 1 0-3-3M3 15h15a3 3 0 1 1-3 3"/>'),
  route_deviation: svg('<path d="M5 20c0-8 4-4 7-8s2-6 7-6M16 3l3 3-3 3"/>'),
  hazard: svg('<path d="M12 3L22 20H2Z"/><path d="M12 9v5M12 17v.5"/>'),
  sample: svg('<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>'),
  equipment: svg('<path d="M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10"/>'),
  note: svg('<path d="M5 4h14v16H5zM8 9h8M8 13h8M8 17h5"/>'),
};
const SEV_GLYPH = {
  3: svg('<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>'),
  2: svg('<path d="M12 4l9 16H3z"/>'),
  1: svg('<rect x="5" y="5" width="14" height="14"/>'),
};
const I = (key, el = "span") => `<${el} data-i18n="${key}">${esc(t(key))}</${el}>`;
const lab = (prefix, v) => (has(`${prefix}.${v}`) ? t(`${prefix}.${v}`) : esc(v));

const PAGE = 50;
const openPhotos = new Set();
let shown = PAGE;
let ctx, pane, dlg, filter = null, picking = false, shownRR = null, dismissedRR = null, memN = 0;
const me = () => state.ui.me;
const grid = () => state.data ?? ctx.data;
const hereCell = () => {
  const c = state.ui.me.manualCell ?? state.plan?.at?.cell ?? grid().habitat;
  return Number.isInteger(c) ? c : grid().habitat;
};
function cellText(cell) {
  const { cols } = grid();
  let ll = "";
  try { const [la, lo] = cellToLatLng(cell); if (Number.isFinite(la)) ll = ` · ${num(la, 4)}°, ${num(lo, 4)}°`; } catch {}
  return t("log.cell", { r: (cell / cols) | 0, c: cell % cols }) + ll;
}
function nextId() {
  const k = `ariadne.log.n.${me().deviceId}`;
  let n;
  try { n = (Number(localStorage.getItem(k)) || 0) + 1; localStorage.setItem(k, String(n)); } catch { n = Date.now() + ++memN; }
  return `${me().deviceId}:${n}`;
}
const flyTo = (cell) => { if (Number.isInteger(cell)) ctx.map?.flyTo?.(cell, 16); };

function summary(e) {
  const d = e.data ?? {}, p = [];
  if (e.section === "fault") p.push(lab("log.fault", d.kind), d.offset_m != null ? t("log.offset", { m: num(d.offset_m, 1) }) : "");
  else if (e.section === "env_change") p.push(lab("log.env", d.what));
  else if (e.section === "hazard") p.push(lab("log.hazard", d.kind));
  else if (e.section === "sample") p.push(esc(d.sample_id), esc(d.rock));
  else if (e.section === "equipment") p.push(esc(d.item), lab("log.eq", d.state));
  else if (e.section === "route_deviation") p.push(esc(d.reason));
  return p.filter(Boolean).join(" · ");
}
function rowHtml({ e, superseded }) {
  const sev = SEV_SECTIONS.has(e.section) ? e.severity : 1, st = e.status ?? "open";
  const when = `${e.sol != null ? t("log.sol", { sol: e.sol }) : "—"} · ${hhmm(e.ltst)} LTST · ${utcLabel(e.utcMs)}`;
  const hasPhoto = e.data?.photo && PHOTO_RE.test(e.data.photo);
  const photo = !hasPhoto ? "" : openPhotos.has(e.id) ? `<img class="log-photo" src="${esc(e.data.photo)}" alt="${esc(t("log.photo.alt"))}">`
    : `<button type="button" class="log-btn" data-act="photo" data-id="${esc(e.id)}">${esc(t("log.photo.show"))}</button>`;
  const act = (a, key) => `<button type="button" class="log-btn" data-act="${a}" data-id="${esc(e.id)}">${esc(t(key))}</button>`;
  const sum = summary(e);
  return `<li class="log-row" data-id="${esc(e.id)}" data-sev="${sev}" data-status="${st}"${superseded ? " data-superseded" : ""}${e.provisional ? " data-provisional" : ""}>
    <span class="log-ico" title="${esc(t(`log.sec.${e.section}`))}">${SEC_GLYPH[e.section] ?? ""}<span class="sr">${esc(t(`log.sec.${e.section}`))}</span></span>
    <div class="log-main">
      <p class="log-title"><span class="log-sev" title="${esc(t(`log.sev.${sev}`))}">${SEV_GLYPH[sev]}<span class="sr">${esc(t(`log.sev.${sev}`))}</span></span><strong>${esc(inMyLang(e.title))}</strong></p>
      <p class="log-meta">${esc(e.author?.crew ?? "?")} · ${esc(when)}</p>
      <p class="log-meta"><span class="log-status">${esc(t(`log.status.${st}`))}</span>${e.provisional ? ` · <span class="log-status">${esc(t("log.pending"))}</span>` : ""}${superseded ? ` · ${esc(t("log.superseded"))}` : ""} ${tag(e.tag === "SIMULATED" ? "SIMULATED" : "REPORTED")}</p>
      ${sum ? `<p class="log-sum">${sum}</p>` : ""}${e.note ? `<p class="log-note">${esc(e.note)}</p>` : ""}${photo}
      <p class="log-acts">${act("show", "log.show")}${canSetStatus(e, "confirmed", me()) ? act("confirm", "log.confirm") : ""}${canSetStatus(e, "resolved", me()) ? act("resolve", "log.resolve") : ""}${canCorrect(e, superseded, me()) ? act("correct", "log.correct") : ""}</p>
    </div></li>`;
}
function filterHtml() {
  const chip = (sec, inner) => `<button type="button" class="log-chip" data-act="filter" data-sec="${sec}" aria-pressed="${(filter ?? "") === sec}">${inner}</button>`;
  return chip("", esc(t("log.filter.all"))) + SECTIONS.map((s) => chip(s, `${SEC_GLYPH[s]}<span>${esc(t(`log.sec.${s}`))}</span>`)).join("");
}

const holdsLock = (l) => l.holder?.deviceId === me().deviceId || me().role === "base";
const lockOf = (target) => state.doc.locks?.[target];
function locksHtml() {
  const doc = state.doc, locks = Object.values(doc.locks ?? {}).filter((l) => l.kind !== "equipment");
  const rows = locks.map((l) => `<li class="log-row lock-row" data-lock="${esc(l.target)}"${l.provisional ? " data-provisional" : ""}>
    <div class="log-main"><p class="log-title"><strong>${esc(t(`log.lock.kind.${l.kind}`))}</strong> · ${esc(l.holder?.crew ?? "?")}</p>
    <p class="log-meta">${esc(inMyLang(l.reason ?? ""))}${l.provisional ? ` · ${esc(t("log.pending"))}` : ""}${l.sticky ? ` · ${esc(t("log.lock.sticky"))}` : ""}</p>
    ${holdsLock(l) && !l.provisional ? `<p class="log-acts"><button type="button" class="log-btn" data-act="release" data-target="${esc(l.target)}">${esc(t("log.lock.release"))}</button></p>` : ""}</div></li>`).join("");
  const assets = Object.values(doc.assets ?? {}).filter((a) => a.kind === "equipment" || a.kind === "vehicle");
  const eq = assets.map((a) => {
    const l = lockOf(`equip:${a.id}`), mine = l && l.holder?.deviceId === me().deviceId;
    return `<li class="log-row lock-row"><div class="log-main"><p class="log-title"><strong>${esc(inMyLang(a.name ?? a.id))}</strong></p>
      <p class="log-meta">${l ? esc(t("log.eq.inuse", { crew: l.holder?.crew ?? "?" })) : esc(t("log.eq.free"))}${l?.provisional ? ` · ${esc(t("log.pending"))}` : ""}</p>
      <p class="log-acts">${l ? (holdsLock(l) ? (l.provisional ? "" : `<button type="button" class="log-btn" data-act="release" data-target="${esc(l.target)}">${esc(t("log.lock.release"))}</button>`) : `<button type="button" class="log-btn" disabled>${esc(t("log.eq.take"))}</button>`)
        : `<button type="button" class="log-btn" data-act="take" data-id="${esc(a.id)}"${EQUIP_ID_RE.test(a.id) ? "" : " disabled"}>${esc(t("log.eq.take"))}</button>`}</p></div></li>`;
  }).join("");
  const mineRoute = lockOf(`route:${me().deviceId}`);
  return `<h3 class="log-h">${esc(t("log.locks"))}</h3>
    <p class="log-acts"><button type="button" class="log-btn log-btn-main" data-act="lock-zone">${esc(t("log.lock.zone"))}</button>
    <button type="button" class="log-btn log-btn-main" data-act="lock-route"${mineRoute ? " disabled" : ""}>${esc(t("log.lock.route"))}</button></p>
    ${rows ? `<ul class="log-list">${rows}</ul>` : `<p class="muted">${esc(t("log.lock.none"))}</p>`}
    ${eq ? `<h3 class="log-h">${esc(t("log.equipment"))}</h3><ul class="log-list">${eq}</ul>` : ""}`;
}

const seen = { log: null, locks: null, assets: null, me: null };
function render() {
  const doc = state.doc, rows = listEntries(doc, { section: filter }), a = pane.contains(document.activeElement) ? document.activeElement : null;
  const keep = a?.dataset?.act ? `[data-act="${a.dataset.act}"]${a.dataset.id ? `[data-id="${CSS.escape(a.dataset.id)}"]` : ""}${a.dataset.sec != null ? `[data-sec="${a.dataset.sec}"]` : ""}${a.dataset.target ? `[data-target="${CSS.escape(a.dataset.target)}"]` : ""}` : null;
  $("log-count").textContent = activeCount(doc) || "";
  pane.querySelector(".log-filter").innerHTML = filterHtml();
  pane.querySelector("#log-list").innerHTML = rows.slice(0, shown).map(rowHtml).join("");
  pane.querySelector(".log-more").innerHTML = rows.length > shown ? `<button type="button" class="log-btn" data-act="more">${esc(t("log.more", { n: rows.length - shown }))}</button>` : "";
  pane.querySelector(".log-empty").hidden = rows.length > 0;
  pane.querySelector(".log-locks").innerHTML = locksHtml();
  if (keep) pane.querySelector(keep)?.focus({ preventScroll: true });
}
function drawMap() {
  const m = ctx.map;
  if (!m) return;
  const { rows, cols } = grid(), doc = state.doc, list = listEntries(doc).filter((x) => !x.superseded).map((x) => x.e);
  m.markers?.("log:entries", list.map((e) => markerOf(e, () => selectEntry(e.id), (s) => t(`log.sec.${s}`))));
  const devs = list.filter((e) => e.section === "route_deviation" && e.status !== "resolved" && e.data?.path?.length > 1).map((e) => e.data.path);
  m.lines?.("log:deviations", devs.length ? devs : null, { token: "--ink", width: 2, halo: true, dash: "6 4" });
  const locks = Object.values(doc.locks ?? {}), mine = (l) => l.holder?.deviceId === me().deviceId;
  const zones = locks.filter((l) => l.kind === "zone"), routes = locks.filter((l) => l.kind === "route" && !mine(l) && l.cells?.length > 1);
  const mask = (ls) => {
    if (!ls.length) return null;
    const a = new Uint8Array(rows * cols);
    for (const l of ls) for (const c of l.cells ?? []) if (c >= 0 && c < a.length) a[c] = 1;
    return a;
  };
  const others = zones.filter((l) => !mine(l)), own = zones.filter(mine);
  m.outline?.("log:locks", mask(others), { token: "--red", width: 2.5, halo: true });
  m.pattern?.("log:locks-hatch", mask(others), { kind: "hatch-red" });
  m.outline?.("log:locks-own", mask(own), { token: "--ink", width: 2, halo: true, dash: "6 4" });
  m.lines?.("log:routes", routes.length ? routes.map((l) => l.cells) : null, { token: "--ink", width: 3, halo: true, dash: "2 6" });
  const plates = [...others, ...routes].filter((l) => l.cells?.length).map((l) => ({
    id: l.target, cell: l.cells[l.cells.length >> 1], kind: "note", provisional: !!l.provisional,
    label: l.kind === "zone" ? t("log.plate.locked", { crew: l.holder?.crew ?? "?", reason: inMyLang(l.reason ?? "") }) : t("log.plate.reserved", { crew: l.holder?.crew ?? "?" }),
  }));
  m.markers?.("log:lockplates", plates.length ? plates : null);
}
function selectEntry(id) {
  filter = null;
  shown = Math.max(shown, listEntries(state.doc).findIndex((x) => x.e.id === id) + 1);
  set("ui", { tab: "log" });
  render();
  requestAnimationFrame(() => {
    const row = pane.querySelector(`.log-row[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    row.dataset.flash = "1";
    setTimeout(() => delete row.dataset.flash, 1600);
  });
}

function renderReroute() {
  const rr = state.plan?.reroute, slot = $("reroute-slot");
  if (!rr || rr === dismissedRR) { if (shownRR) slot.replaceChildren(); shownRR = null; return; }
  if (rr === shownRR) return;
  shownRR = rr;
  const c = rr.cause ?? {}, who = c.crew ?? t("log.rr.someone");
  const cause = t(c.type === "lock" ? "log.rr.cause.lock" : "log.rr.cause.log", { crew: who });
  const d = Math.round(rr.deltaM ?? 0);
  const delta = d === 0 ? t("log.rr.same") : `${d > 0 ? "+" : "−"}${num(Math.abs(d))} m`;
  const text = rr.empty ? t("log.rr.empty", { cause }) : t("log.rr.text", { cause, delta });
  const sec = h("section", "z535", `${rr.empty ? `<div class="symbol"><svg aria-hidden="true"><use href="#s-forbidden"/></svg></div>` : ""}
    <h2 class="band"><svg class="glyph" aria-hidden="true"><use href="#g-route"/></svg><span>${esc(t("log.rr.title"))}</span></h2>
    <div class="body"><p class="log-rr-text">${esc(text)}</p><p class="log-acts">${c.id ? `<button type="button" class="log-btn" data-act="rr-show">${esc(t("log.show"))}</button>` : ""}<button type="button" class="log-btn" data-act="rr-dismiss">${esc(t("log.rr.dismiss"))}</button></p></div>`);
  sec.dataset.tone = rr.empty ? "danger" : "warning";
  sec.setAttribute("role", "alert");
  slot.replaceChildren(sec);
}
function rrCell() {
  const c = shownRR?.cause;
  if (!c?.id) return null;
  return c.type === "lock" ? lockOf(c.id)?.cells?.[0] : state.doc.log[c.id]?.cell;
}

export async function shrinkPhoto(file) {
  const bmp = await createImageBitmap(file);
  const probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  const type = probe.toDataURL("image/webp").startsWith("data:image/webp") ? "image/webp" : "image/jpeg";
  try {
    for (let side = 480; side >= 160; side = Math.round(side * 0.75)) {
      const k = Math.min(1, side / Math.max(bmp.width, bmp.height)), c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      for (const q of [0.7, 0.5, 0.35]) { const u = c.toDataURL(type, q); if (u.length <= PHOTO_MAX) return u; }
    }
    return null;
  } finally { bmp.close?.(); }
}

const seg = (name, value, inner, checked, attrs = "") => `<label class="log-seg"><input type="radio" name="${name}" value="${value}"${checked ? " checked" : ""}${attrs}><span>${inner}</span></label>`;
const opts = (prefix, list, sel) => list.map((v) => `<option value="${v}"${v === sel ? " selected" : ""} data-i18n="${prefix}.${v}">${esc(t(`${prefix}.${v}`))}</option>`).join("");

function reportHtml(init) {
  const sec = init.section ?? "hazard", d = init.data ?? {}, sev = init.severity ?? 2, prof = init.profiles ?? PROFILE_IDS;
  return `<form class="log-form" novalidate>
    <h2 class="log-h" data-i18n="${init.supersedes ? "log.form.correct" : "log.form.title"}">${esc(t(init.supersedes ? "log.form.correct" : "log.form.title"))}</h2>
    <fieldset class="f"><legend>${I("log.form.section")}</legend><div class="log-seg-grid">${SECTIONS.map((s) => seg("section", s, `${SEC_GLYPH[s]}${I(`log.sec.${s}`)}`, s === sec, s === sec ? " autofocus" : "")).join("")}</div></fieldset>
    <fieldset class="f" data-for="fault hazard env_change"><legend>${I("log.form.severity")}</legend><div class="log-seg-row">${[1, 2, 3].map((n) => seg("severity", n, `${SEV_GLYPH[n]}${I(`log.sev.${n}`)}`, n === sev)).join("")}</div>
      <p class="muted" data-sev-hint></p></fieldset>
    <fieldset class="f"><legend>${I("log.form.where")}</legend>
      <div class="log-seg-row"><button type="button" class="log-btn" data-form="here">${I("log.form.here")}</button><button type="button" class="log-btn" data-form="pick">${I("log.form.pick")}</button></div>
      <p class="log-loc" data-loc></p></fieldset>
    <div class="f" data-for="fault hazard env_change"><label for="lf-radius">${I("log.form.radius")}: <output data-radius></output></label>
      <input id="lf-radius" name="radius" type="range" min="0" max="200" step="10" value="${init.radius_m ?? 40}"></div>
    <fieldset class="f" data-for="fault hazard env_change"><legend>${I("log.form.profiles")}</legend><div class="log-seg-row">${PROFILE_IDS.map((p) => `<label class="log-seg"><input type="checkbox" name="profiles" value="${p}"${prof.includes(p) ? " checked" : ""}><span>${I(`log.profile.${p}`)}</span></label>`).join("")}</div></fieldset>
    <div class="f" data-for="fault"><label for="lf-fk">${I("log.form.kind")}</label><select id="lf-fk" name="fault_kind">${opts("log.fault", ENUMS.fault, d.kind)}</select>
      <label for="lf-off">${I("log.form.offset")}</label><input id="lf-off" name="fault_off" type="number" inputmode="decimal" min="0" step="0.1" value="${d.offset_m ?? ""}"></div>
    <div class="f" data-for="env_change"><label for="lf-env">${I("log.form.what")}</label><select id="lf-env" name="env_what">${opts("log.env", ENUMS.env, d.what)}</select></div>
    <div class="f" data-for="hazard"><label for="lf-hk">${I("log.form.kind")}</label><select id="lf-hk" name="haz_kind">${opts("log.hazard", ENUMS.hazard, d.kind)}</select></div>
    <div class="f" data-for="route_deviation"><label for="lf-rs">${I("log.form.reason")}</label><input id="lf-rs" name="dev_reason" maxlength="80" value="${esc(d.reason)}"><p class="muted">${I("log.form.devhint")}</p></div>
    <div class="f" data-for="sample"><label for="lf-si">${I("log.form.sample_id")}</label><input id="lf-si" name="smp_id" maxlength="40" value="${esc(d.sample_id)}">
      <label for="lf-sr">${I("log.form.rock")}</label><input id="lf-sr" name="smp_rock" maxlength="40" value="${esc(d.rock)}"></div>
    <div class="f" data-for="equipment"><label for="lf-ei">${I("log.form.item")}</label><input id="lf-ei" name="eq_item" maxlength="40" value="${esc(d.item)}">
      <label for="lf-es">${I("log.form.state")}</label><select id="lf-es" name="eq_state">${opts("log.eq", ENUMS.eq, d.state)}</select></div>
    <div class="f"><label for="lf-title">${I("log.form.title.label")}</label><input id="lf-title" name="title" maxlength="60" autocomplete="off" value="${esc(init.title)}">
      <label for="lf-note">${I("log.form.note")}</label><textarea id="lf-note" name="note" maxlength="500" rows="3">${esc(init.note)}</textarea></div>
    <div class="f"><label class="log-btn photo-btn"><input class="sr" type="file" accept="image/*" capture="environment" name="photo">${I("log.photo.add")}</label>
      <span class="photo-out"></span><p class="muted">${I("log.photo.hint")}</p></div>
    <p class="log-err" role="alert" data-err></p>
    <div class="log-foot"><button type="button" class="log-btn" data-form="cancel">${I("log.form.cancel")}</button><button type="submit" class="log-btn log-btn-main">${I("log.form.submit")}</button></div>
  </form>`;
}

function openReport(init = {}) {
  if (!dlg || !state.data) return;
  dlg.innerHTML = reportHtml(init);
  const form = dlg.querySelector("form"), err = form.querySelector("[data-err]");
  let loc = Number.isInteger(init.cell) ? init.cell : hereCell(), photo = null;
  const val = (n) => form.elements[n]?.value ?? "";
  const sync = () => {
    const sec = form.elements.section.value, sev = Number(form.elements.severity.value);
    for (const el of form.querySelectorAll("[data-for]")) el.hidden = !el.dataset.for.split(" ").includes(sec);
    const hint = sec === "env_change" ? (sev >= 2 ? "log.sev.hint.env" : "log.sev.hint.1") : `log.sev.hint.${sev}`;
    form.querySelector("[data-sev-hint]").textContent = t(hint);
    form.querySelector("[data-loc]").textContent = cellText(loc);
    form.querySelector("[data-radius]").textContent = `${form.elements.radius.value} m`;
  };
  form.addEventListener("input", sync);
  form.addEventListener("change", async (ev) => {
    sync();
    if (ev.target.name !== "photo" || !ev.target.files?.[0]) return;
    const out = form.querySelector(".photo-out");
    out.textContent = t("log.photo.busy");
    try { photo = await shrinkPhoto(ev.target.files[0]); } catch { photo = null; }
    out.innerHTML = photo ? `<img class="log-photo" src="${esc(photo)}" alt="${esc(t("log.photo.alt"))}"> <button type="button" class="log-btn" data-form="nophoto">${esc(t("log.photo.remove"))}</button>` : esc(t("log.err.photo"));
  });
  form.addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-form]");
    if (!b) return;
    if (b.dataset.form === "cancel") dlg.close();
    else if (b.dataset.form === "here") { loc = hereCell(); sync(); }
    else if (b.dataset.form === "nophoto") { photo = null; form.elements.photo.value = ""; form.querySelector(".photo-out").textContent = ""; }
    else if (b.dataset.form === "pick") {
      picking = true; dlg.close();
      const c = await ctx.map?.pickCell?.("log.pick.cell");
      picking = false; dlg.showModal();
      if (Number.isInteger(c) && c >= 0) loc = c;
      sync();
    }
  });
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const sec = val("section");
    const input = {
      section: sec, severity: Number(val("severity")), cell: loc, radius_m: Number(val("radius")), profiles: new FormData(form).getAll("profiles"),
      title: val("title").trim() || tEn(`log.sec.${sec}`), note: val("note"), photo, supersedes: init.supersedes,
      data: { kind: sec === "fault" ? val("fault_kind") : val("haz_kind"), offset_m: val("fault_off") === "" ? undefined : Number(val("fault_off")), what: val("env_what"),
        reason: val("dev_reason"), path: sec === "route_deviation" ? [state.plan?.at?.cell, loc].filter((c, i, a) => Number.isInteger(c) && a.indexOf(c) === i) : [],
        sample_id: val("smp_id"), rock: val("smp_rock"), item: val("eq_item"), state: val("eq_state") },
    };
    let entry;
    try { entry = makeEntry(input, { id: nextId(), me: me(), clock: missionClock() }); } catch (e) { err.textContent = t(has(`log.err.${e.message}`) ? `log.err.${e.message}` : "log.err.generic"); return; }
    submit({ t: "log.append", entry });
    dlg.close();
    const wait = state.net?.pending;
    toast(wait ? t("log.sent.queued", { n: wait }) : t("log.sent"), "safe");
  });
  sync();
  apply(dlg);
  dlg.showModal();
}

function openZone() {
  if (!dlg || !state.data) return;
  dlg.innerHTML = `<form class="log-form" novalidate><h2 class="log-h">${I("log.lock.zone")}</h2>
    <div class="f"><label for="lz-reason">${I("log.lock.reason")}</label><input id="lz-reason" name="reason" maxlength="80" autocomplete="off" autofocus>
      <label class="log-seg"><input type="checkbox" name="sticky"><span>${I("log.lock.sticky.label")}</span></label></div>
    <fieldset class="f"><legend>${I("log.form.profiles")}</legend><div class="log-seg-row">${PROFILE_IDS.map((p) => `<label class="log-seg"><input type="checkbox" name="profiles" value="${p}" checked><span>${I(`log.profile.${p}`)}</span></label>`).join("")}</div></fieldset>
    <p class="muted">${I("log.lock.hint")}</p>
    <div class="log-foot"><button type="button" class="log-btn" data-form="cancel">${I("log.form.cancel")}</button><button type="submit" class="log-btn log-btn-main">${I("log.lock.draw")}</button></div></form>`;
  const form = dlg.querySelector("form");
  form.addEventListener("click", (ev) => { if (ev.target.closest('[data-form="cancel"]')) dlg.close(); });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form), reason = String(fd.get("reason") || "").trim().slice(0, 80) || tEn("log.lock.reason.default"), profiles = fd.getAll("profiles"), sticky = !!fd.get("sticky");
    picking = true; dlg.close();
    const poly = await ctx.map?.pickPolygon?.("log.pick.zone");
    picking = false;
    if (!poly || poly.length < 3) return;
    const shape = thinPoly(poly), cells = [...cellsInPolygon(shape)];
    if (!cells.length || cells.length > ZONE_MAX_CELLS) return toast(t("log.lock.badsize"), "warning");
    submit({ t: "lock.request", target: zoneTarget(me().deviceId, Date.now()), kind: "zone", cells, poly: shape, profiles: profiles.length ? profiles : PROFILE_IDS, reason, sticky, ttlMs: 30000 });
    toast(t("log.lock.sent"), "neutral");
  });
  apply(dlg);
  dlg.showModal();
}

function onAction(ev) {
  const b = ev.target.closest("[data-act]");
  if (!b || b.disabled) return;
  const a = b.dataset.act, id = b.dataset.id, doc = state.doc;
  if (a === "new") openReport();
  else if (a === "filter") { filter = b.dataset.sec || null; shown = PAGE; render(); }
  else if (a === "more") { shown += PAGE; render(); }
  else if (a === "photo") { openPhotos.add(id); render(); }
  else if (a === "show") flyTo(doc.log[id]?.cell);
  else if (a === "confirm" || a === "resolve") submit({ t: "log.status", ref: id, status: a === "confirm" ? "confirmed" : "resolved" });
  else if (a === "correct") { const e = doc.log[id]; if (e) openReport({ ...e, supersedes: e.id, data: { ...e.data, photo: undefined } }); }
  else if (a === "lock-zone") openZone();
  else if (a === "lock-route") {
    const route = state.plan?.route;
    if (!route?.length) return toast(t("log.lock.noroute"), "warning");
    submit({ t: "lock.request", target: `route:${me().deviceId}`, kind: "route", cells: [...route], profiles: PROFILE_IDS, reason: tEn("log.lock.kind.route"), sticky: false, ttlMs: 30000 });
  } else if (a === "release") { const l = lockOf(b.dataset.target); if (l) submit({ t: "lock.release", target: l.target, fence: l.fence }); }
  else if (a === "take") submit({ t: "lock.request", target: `equip:${id}`, kind: "equipment", profiles: PROFILE_IDS, reason: "equipment", sticky: false, ttlMs: 30000 });
  else if (a === "rr-dismiss") { dismissedRR = shownRR; renderReroute(); }
  else if (a === "rr-show") flyTo(rrCell());
}

export async function init(c) {
  ctx = c;
  pane = $("pane-log");
  dlg = $("log-dialog");
  pane.innerHTML = `<p class="log-head"><button type="button" class="log-btn log-btn-main log-new" data-act="new">+ ${I("log.new")}</button></p>
    <div class="log-filter" role="group" data-i18n-aria="log.filter.label" aria-label="${esc(t("log.filter.label"))}"></div>
    <ul id="log-list" class="log-list"></ul><p class="log-more"></p><p class="log-empty muted" data-i18n="log.empty">${esc(t("log.empty"))}</p><section class="log-locks"></section>`;
  pane.addEventListener("click", onAction);
  $("reroute-slot").addEventListener("click", onAction);
  document.addEventListener("click", (ev) => { if (ev.target.closest?.("[data-log-new]")) openReport(); });
  on("log:new", () => openReport());
  on("map:report", () => openReport());
  dlg.addEventListener("close", () => { if (!picking && !dlg.open) dlg.replaceChildren(); });
  const refresh = () => {
    const doc = state.doc, l = state.ui.me;
    if (doc.log !== seen.log || doc.locks !== seen.locks || doc.assets !== seen.assets || l !== seen.me) {
      const logChanged = doc.log !== seen.log || doc.locks !== seen.locks || l !== seen.me;
      Object.assign(seen, { log: doc.log, locks: doc.locks, assets: doc.assets, me: l });
      render();
      if (logChanged) drawMap();
    }
  };
  on("doc", refresh);
  on("ui", refresh);
  on("plan", renderReroute);
  on("lang", () => { apply(pane); render(); drawMap(); shownRR = null; renderReroute(); if (dlg.open) apply(dlg); });
  refresh();
  renderReroute();
}
