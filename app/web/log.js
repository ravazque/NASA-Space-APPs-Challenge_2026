import { state, set, on } from "./store.js";
import { t, tEn, num, apply, has, shown as inMyLang } from "./i18n.js";
import { $, esc, h, tag, toast } from "./ui.js";
import { submit, hubNow } from "./sync.js";
import { mars } from "./marsclock.js";
import { cellsInPolygon, cellToLatLng } from "./geo.js";
import { supersededIds } from "./effects.js";

export const SECTIONS = [
  "fault",
  "env_change",
  "route_deviation",
  "hazard",
  "sample",
  "equipment",
  "note",
];
export const SEV_SECTIONS = new Set(["fault", "hazard", "env_change"]);
export const PROFILE_IDS = ["foot", "vehicle", "cargo"];
export const ZONE_MAX_CELLS = 9000;
export const POLY_MAX = 64;
export const PHOTO_MAX = 45000;
const PHOTO_RE = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/;
const LOCK_TTL_MS = 30000;
const PAGE_SIZE = 50;

export const ENUMS = {
  fault: ["scarp", "fracture", "collapse", "other"],
  env: ["dust_devil", "dust_rise", "frost", "wind", "other"],
  hazard: ["rock", "loose_sand", "slope", "other"],
  eq: ["ok", "fault", "left_here"],
};

function clip(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function oneOf(value, list, fallback) {
  return list.includes(value) ? value : fallback;
}

const SECTION_DATA = {
  fault: (data) => {
    const clean = { kind: oneOf(data.kind, ENUMS.fault, "other") };
    if (Number.isFinite(data.offset_m) && data.offset_m >= 0) clean.offset_m = data.offset_m;
    return clean;
  },
  env_change: (data) => ({ what: oneOf(data.what, ENUMS.env, "other") }),
  route_deviation: (data) => {
    const path = Array.isArray(data.path) ? data.path : [];
    return { path: path.filter(Number.isInteger).slice(0, 500), reason: clip(data.reason, 80) };
  },
  hazard: (data) => ({ kind: oneOf(data.kind, ENUMS.hazard, "other") }),
  sample: (data) => ({ sample_id: clip(data.sample_id, 40), rock: clip(data.rock, 40) }),
  equipment: (data) => ({ item: clip(data.item, 40), state: oneOf(data.state, ENUMS.eq, "ok") }),
  note: () => ({}),
};

function clampSeverity(value) {
  const rounded = Math.round(Number(value)) || 2;
  return Math.min(3, Math.max(1, rounded));
}

function clampRadius(value) {
  const rounded = Math.round(Number(value ?? 40)) || 0;
  return Math.min(200, Math.max(0, rounded));
}

export function makeEntry(form, context) {
  const { id, me, clock, wallMs = Date.now(), tag: entryTag = "REPORTED" } = context;
  if (!SECTIONS.includes(form.section)) throw new Error("section");
  if (!Number.isInteger(form.cell) || form.cell < 0) throw new Error("cell");
  const title = clip(form.title, 60);
  if (!title) throw new Error("title");
  if (form.photo && !(form.photo.length <= PHOTO_MAX && PHOTO_RE.test(form.photo))) {
    throw new Error("photo");
  }

  const data = SECTION_DATA[form.section](form.data ?? {});
  if (form.supersedes) data.supersedes = clip(form.supersedes, 60);
  if (form.photo) data.photo = form.photo;

  const wanted = form.profiles ?? PROFILE_IDS;
  const profiles = PROFILE_IDS.filter((profileId) => wanted.includes(profileId));
  return {
    id,
    section: form.section,
    severity: SEV_SECTIONS.has(form.section) ? clampSeverity(form.severity) : 1,
    cell: form.cell,
    radius_m: clampRadius(form.radius_m),
    profiles: profiles.length ? profiles : [...PROFILE_IDS],
    title,
    note: clip(form.note, 500),
    data,
    author: { deviceId: me.deviceId, crew: clip(me.crew, 12) },
    utcMs: clock.utcMs,
    wallMs,
    sol: clock.sol ?? null,
    ltst: clock.ltst ?? null,
    tag: entryTag,
    status: "open",
  };
}

export function listEntries(doc, { section = null } = {}) {
  const all = doc.logOrder.map((id) => doc.log[id]).filter(Boolean);
  const superseded = supersededIds(all);
  const result = [];
  for (let i = all.length - 1; i >= 0; i--) {
    if (!section || all[i].section === section) {
      result.push({ e: all[i], superseded: superseded.has(all[i].id) });
    }
  }
  return result;
}

export function activeCount(doc) {
  const active = listEntries(doc).filter(
    ({ e: entry, superseded }) => !superseded && entry.status !== "resolved",
  );
  return active.length;
}

export function canSetStatus(entry, status, me) {
  if (!entry || entry.status === "resolved" || entry.status === status || entry.provisional) {
    return false;
  }
  const isAuthor = entry.author?.deviceId === me.deviceId;
  if (status === "resolved") return isAuthor || me.role === "base";
  if (status === "confirmed") return !isAuthor && entry.status === "open";
  return false;
}

export function canCorrect(entry, superseded, me) {
  if (!entry || superseded || entry.status === "resolved") return false;
  return entry.author?.deviceId === me.deviceId || me.role === "base";
}

export function thinPoly(poly) {
  const step = Math.ceil(poly.length / POLY_MAX);
  if (step <= 1) return poly;
  return poly.filter((_, i) => i % step === 0).slice(0, POLY_MAX);
}

export const zoneTarget = (deviceId, n) => `zone:${deviceId}:${n % 1e9}`;
export const EQUIP_ID_RE = /^[\w-]{1,32}$/;

const MARKER_KIND = {
  fault: "fault",
  hazard: "hazard",
  sample: "sample",
  equipment: "equipment",
  env_change: "note",
  route_deviation: "note",
  note: "note",
};

export function markerOf(entry, onClick, sectionLabel = (section) => section) {
  const marker = {
    id: entry.id,
    cell: entry.cell,
    kind: MARKER_KIND[entry.section] ?? "note",
    label: inMyLang(entry.title),
    sub: `${entry.author?.crew ?? ""} · ${sectionLabel(entry.section)}`,
    provisional: !!entry.provisional,
    stale: entry.status === "resolved",
  };
  if (SEV_SECTIONS.has(entry.section) && entry.severity >= 2 && entry.status !== "resolved") {
    marker.radius_m = entry.radius_m;
  }
  marker.onClick = onClick;
  return marker;
}

const pad2 = (n) => String(n).padStart(2, "0");

export function hhmm(hours) {
  if (!Number.isFinite(hours)) return "--:--";
  return `${pad2(Math.floor(hours) % 24)}:${pad2(Math.floor(hours * 60) % 60)}`;
}

export function utcLabel(ms) {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function missionClock() {
  const clock = state.clock;
  if (clock?.utcMs != null) {
    return { utcMs: clock.utcMs, sol: clock.sol ?? null, ltst: clock.ltst ?? null };
  }
  const utcMs = hubNow();
  try {
    const { sol, ltst } = mars(utcMs);
    return { utcMs, sol, ltst };
  } catch {
    return { utcMs, sol: null, ltst: null };
  }
}

function glyph(paths) {
  return `<svg class="log-glyph" viewBox="0 0 24 24" aria-hidden="true" fill="none" `
    + `stroke="currentColor" stroke-width="2.25" stroke-linejoin="round" `
    + `stroke-linecap="round">${paths}</svg>`;
}

const SECTION_GLYPH = {
  fault: glyph('<path d="M5 3l5 7-5 3 7 4-3 4"/>'),
  env_change: glyph('<path d="M3 9h11a3 3 0 1 0-3-3M3 15h15a3 3 0 1 1-3 3"/>'),
  route_deviation: glyph('<path d="M5 20c0-8 4-4 7-8s2-6 7-6M16 3l3 3-3 3"/>'),
  hazard: glyph('<path d="M12 3L22 20H2Z"/><path d="M12 9v5M12 17v.5"/>'),
  sample: glyph('<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>'),
  equipment: glyph('<path d="M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10"/>'),
  note: glyph('<path d="M5 4h14v16H5zM8 9h8M8 13h8M8 17h5"/>'),
};

const SEVERITY_GLYPH = {
  3: glyph('<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>'),
  2: glyph('<path d="M12 4l9 16H3z"/>'),
  1: glyph('<rect x="5" y="5" width="14" height="14"/>'),
};

const i18nSpan = (key, element = "span") => (
  `<${element} data-i18n="${key}">${esc(t(key))}</${element}>`
);
const label = (prefix, value) => (has(`${prefix}.${value}`) ? t(`${prefix}.${value}`) : esc(value));

const openPhotos = new Set();
let visibleCount = PAGE_SIZE;
let ctx;
let pane;
let dialog;
let sectionFilter = null;
let picking = false;
let shownReroute = null;
let dismissedReroute = null;
let memoryCounter = 0;

const me = () => state.ui.me;
const grid = () => state.data ?? ctx.data;

function hereCell() {
  const cell = state.ui.me.manualCell ?? state.plan?.at?.cell ?? grid().habitat;
  return Number.isInteger(cell) ? cell : grid().habitat;
}

function cellText(cell) {
  const { cols } = grid();
  let latLng = "";
  try {
    const [lat, lng] = cellToLatLng(cell);
    if (Number.isFinite(lat)) latLng = ` · ${num(lat, 4)}°, ${num(lng, 4)}°`;
  } catch {}
  return t("log.cell", { r: Math.floor(cell / cols), c: cell % cols }) + latLng;
}

function nextId() {
  const key = `ariadne.log.n.${me().deviceId}`;
  let n;
  try {
    n = (Number(localStorage.getItem(key)) || 0) + 1;
    localStorage.setItem(key, String(n));
  } catch {
    n = Date.now() + ++memoryCounter;
  }
  return `${me().deviceId}:${n}`;
}

function flyTo(cell) {
  if (Number.isInteger(cell)) ctx.map?.flyTo?.(cell, 16);
}

function summary(entry) {
  const data = entry.data ?? {};
  let parts = [];
  if (entry.section === "fault") {
    const offset = data.offset_m != null ? t("log.offset", { m: num(data.offset_m, 1) }) : "";
    parts = [label("log.fault", data.kind), offset];
  } else if (entry.section === "env_change") {
    parts = [label("log.env", data.what)];
  } else if (entry.section === "hazard") {
    parts = [label("log.hazard", data.kind)];
  } else if (entry.section === "sample") {
    parts = [esc(data.sample_id), esc(data.rock)];
  } else if (entry.section === "equipment") {
    parts = [esc(data.item), label("log.eq", data.state)];
  } else if (entry.section === "route_deviation") {
    parts = [esc(data.reason)];
  }
  return parts.filter(Boolean).join(" · ");
}

function actionButton(action, key, id) {
  return `<button type="button" class="log-btn" data-act="${action}" data-id="${esc(id)}">`
    + `${esc(t(key))}</button>`;
}

function photoHtml(entry) {
  const photo = entry.data?.photo;
  if (!photo || !PHOTO_RE.test(photo)) return "";
  if (openPhotos.has(entry.id)) {
    return `<img class="log-photo" src="${esc(photo)}" alt="${esc(t("log.photo.alt"))}">`;
  }
  return actionButton("photo", "log.photo.show", entry.id);
}

function rowActionsHtml(entry, superseded) {
  let html = actionButton("show", "log.show", entry.id);
  if (canSetStatus(entry, "confirmed", me())) {
    html += actionButton("confirm", "log.confirm", entry.id);
  }
  if (canSetStatus(entry, "resolved", me())) {
    html += actionButton("resolve", "log.resolve", entry.id);
  }
  if (canCorrect(entry, superseded, me())) {
    html += actionButton("correct", "log.correct", entry.id);
  }
  return html;
}

function iconHtml(entry) {
  const sectionName = esc(t(`log.sec.${entry.section}`));
  const glyphHtml = SECTION_GLYPH[entry.section] ?? "";
  return `<span class="log-ico" title="${sectionName}">${glyphHtml}`
    + `<span class="sr">${sectionName}</span></span>`;
}

function titleHtml(entry, severity) {
  const severityName = esc(t(`log.sev.${severity}`));
  return `<p class="log-title">`
    + `<span class="log-sev" title="${severityName}">${SEVERITY_GLYPH[severity]}`
    + `<span class="sr">${severityName}</span></span>`
    + `<strong>${esc(inMyLang(entry.title))}</strong></p>`;
}

function rowHtml({ e: entry, superseded }) {
  const severity = SEV_SECTIONS.has(entry.section) ? entry.severity : 1;
  const status = entry.status ?? "open";
  const sol = entry.sol != null ? t("log.sol", { sol: entry.sol }) : "—";
  const when = `${sol} · ${hhmm(entry.ltst)} LTST · ${utcLabel(entry.utcMs)}`;
  const pending = entry.provisional
    ? ` · <span class="log-status">${esc(t("log.pending"))}</span>`
    : "";
  const supersededText = superseded ? ` · ${esc(t("log.superseded"))}` : "";
  const sourceTag = tag(entry.tag === "SIMULATED" ? "SIMULATED" : "REPORTED");
  const rowAttrs = `data-id="${esc(entry.id)}" data-sev="${severity}" data-status="${status}"`
    + `${superseded ? " data-superseded" : ""}${entry.provisional ? " data-provisional" : ""}`;

  const crew = esc(entry.author?.crew ?? "?");
  const statusText = esc(t(`log.status.${status}`));
  const statusLine = `<span class="log-status">${statusText}</span>`
    + `${pending}${supersededText} ${sourceTag}`;
  const sum = summary(entry);
  const sumHtml = sum ? `<p class="log-sum">${sum}</p>` : "";
  const noteHtml = entry.note ? `<p class="log-note">${esc(entry.note)}</p>` : "";

  return `<li class="log-row" ${rowAttrs}>
    ${iconHtml(entry)}
    <div class="log-main">
      ${titleHtml(entry, severity)}
      <p class="log-meta">${crew} · ${esc(when)}</p>
      <p class="log-meta">${statusLine}</p>
      ${sumHtml}${noteHtml}${photoHtml(entry)}
      <p class="log-acts">${rowActionsHtml(entry, superseded)}</p>
    </div></li>`;
}

function filterChip(section, inner) {
  const pressed = (sectionFilter ?? "") === section;
  return `<button type="button" class="log-chip" data-act="filter" data-sec="${section}" `
    + `aria-pressed="${pressed}">${inner}</button>`;
}

function filterHtml() {
  const all = filterChip("", esc(t("log.filter.all")));
  const chips = SECTIONS.map((section) => {
    const name = esc(t(`log.sec.${section}`));
    return filterChip(section, `${SECTION_GLYPH[section]}<span>${name}</span>`);
  });
  return all + chips.join("");
}

const holdsLock = (lock) => lock.holder?.deviceId === me().deviceId || me().role === "base";
const lockOf = (target) => state.doc.locks?.[target];

function releaseButton(target) {
  return `<button type="button" class="log-btn" data-act="release" data-target="${esc(target)}">`
    + `${esc(t("log.lock.release"))}</button>`;
}

function lockRowHtml(lock) {
  const pending = lock.provisional ? ` · ${esc(t("log.pending"))}` : "";
  const sticky = lock.sticky ? ` · ${esc(t("log.lock.sticky"))}` : "";
  const canRelease = holdsLock(lock) && !lock.provisional;
  const actions = canRelease ? `<p class="log-acts">${releaseButton(lock.target)}</p>` : "";
  const provisionalAttr = lock.provisional ? " data-provisional" : "";
  const kind = esc(t(`log.lock.kind.${lock.kind}`));
  const crew = esc(lock.holder?.crew ?? "?");
  const reason = esc(inMyLang(lock.reason ?? ""));
  return `<li class="log-row lock-row" data-lock="${esc(lock.target)}"${provisionalAttr}>
    <div class="log-main"><p class="log-title"><strong>${kind}</strong> · ${crew}</p>
    <p class="log-meta">${reason}${pending}${sticky}</p>
    ${actions}</div></li>`;
}

function equipmentActionHtml(asset, lock) {
  if (!lock) {
    const disabled = EQUIP_ID_RE.test(asset.id) ? "" : " disabled";
    return `<button type="button" class="log-btn" data-act="take" `
      + `data-id="${esc(asset.id)}"${disabled}>${esc(t("log.eq.take"))}</button>`;
  }
  if (!holdsLock(lock)) {
    return `<button type="button" class="log-btn" disabled>${esc(t("log.eq.take"))}</button>`;
  }
  return lock.provisional ? "" : releaseButton(lock.target);
}

function equipmentRowHtml(asset) {
  const lock = lockOf(`equip:${asset.id}`);
  const status = lock
    ? esc(t("log.eq.inuse", { crew: lock.holder?.crew ?? "?" }))
    : esc(t("log.eq.free"));
  const pending = lock?.provisional ? ` · ${esc(t("log.pending"))}` : "";
  const name = esc(inMyLang(asset.name ?? asset.id));
  const nameHtml = `<p class="log-title"><strong>${name}</strong></p>`;
  return `<li class="log-row lock-row"><div class="log-main">${nameHtml}
      <p class="log-meta">${status}${pending}</p>
      <p class="log-acts">${equipmentActionHtml(asset, lock)}</p></div></li>`;
}

function locksHtml() {
  const doc = state.doc;
  const locks = Object.values(doc.locks ?? {}).filter((lock) => lock.kind !== "equipment");
  const lockRows = locks.map(lockRowHtml).join("");
  const assets = Object.values(doc.assets ?? {})
    .filter((asset) => asset.kind === "equipment" || asset.kind === "vehicle");
  const equipmentRows = assets.map(equipmentRowHtml).join("");
  const hasRoute = lockOf(`route:${me().deviceId}`);

  const zoneButton = `<button type="button" class="log-btn log-btn-main" data-act="lock-zone">`
    + `${esc(t("log.lock.zone"))}</button>`;
  const routeButton = `<button type="button" class="log-btn log-btn-main" data-act="lock-route"`
    + `${hasRoute ? " disabled" : ""}>${esc(t("log.lock.route"))}</button>`;
  const lockList = lockRows
    ? `<ul class="log-list">${lockRows}</ul>`
    : `<p class="muted">${esc(t("log.lock.none"))}</p>`;
  const equipmentList = equipmentRows
    ? `<h3 class="log-h">${esc(t("log.equipment"))}</h3><ul class="log-list">${equipmentRows}</ul>`
    : "";

  return `<h3 class="log-h">${esc(t("log.locks"))}</h3>
    <p class="log-acts">${zoneButton}
    ${routeButton}</p>
    ${lockList}
    ${equipmentList}`;
}

const seen = { log: null, locks: null, assets: null, me: null };

function focusSelector(el) {
  const { act, id, sec, target } = el.dataset;
  if (!act) return null;
  let selector = `[data-act="${act}"]`;
  if (id) selector += `[data-id="${CSS.escape(id)}"]`;
  if (sec != null) selector += `[data-sec="${sec}"]`;
  if (target) selector += `[data-target="${CSS.escape(target)}"]`;
  return selector;
}

function render() {
  const doc = state.doc;
  const rows = listEntries(doc, { section: sectionFilter });
  const focused = pane.contains(document.activeElement) ? document.activeElement : null;
  const keepFocus = focused ? focusSelector(focused) : null;
  const hidden = rows.length - visibleCount;

  $("log-count").textContent = activeCount(doc) || "";
  pane.querySelector(".log-filter").innerHTML = filterHtml();
  pane.querySelector("#log-list").innerHTML = rows.slice(0, visibleCount).map(rowHtml).join("");
  const moreButton = `<button type="button" class="log-btn" data-act="more">`
    + `${esc(t("log.more", { n: hidden }))}</button>`;
  pane.querySelector(".log-more").innerHTML = hidden > 0 ? moreButton : "";
  pane.querySelector(".log-empty").hidden = rows.length > 0;
  pane.querySelector(".log-locks").innerHTML = locksHtml();
  if (keepFocus) pane.querySelector(keepFocus)?.focus({ preventScroll: true });
}

function lockMask(locks, cellCount) {
  if (!locks.length) return null;
  const mask = new Uint8Array(cellCount);
  for (const lock of locks) {
    for (const cell of lock.cells ?? []) {
      if (cell >= 0 && cell < mask.length) mask[cell] = 1;
    }
  }
  return mask;
}

function lockPlate(lock) {
  const crew = lock.holder?.crew ?? "?";
  const text = lock.kind === "zone"
    ? t("log.plate.locked", { crew, reason: inMyLang(lock.reason ?? "") })
    : t("log.plate.reserved", { crew });
  return {
    id: lock.target,
    cell: lock.cells[lock.cells.length >> 1],
    kind: "note",
    provisional: !!lock.provisional,
    label: text,
  };
}

function drawMap() {
  const map = ctx.map;
  if (!map) return;
  const { rows, cols } = grid();
  const doc = state.doc;
  const cellCount = rows * cols;
  const entries = listEntries(doc).filter((item) => !item.superseded).map((item) => item.e);

  const markers = entries.map((entry) => markerOf(
    entry,
    () => selectEntry(entry.id),
    (section) => t(`log.sec.${section}`),
  ));
  map.markers?.("log:entries", markers);

  const isOpenDeviation = (entry) => entry.section === "route_deviation"
    && entry.status !== "resolved"
    && entry.data?.path?.length > 1;
  const deviations = entries.filter(isOpenDeviation).map((entry) => entry.data.path);
  map.lines?.("log:deviations", deviations.length ? deviations : null, {
    token: "--ink",
    width: 2,
    halo: true,
    dash: [6, 4],
  });

  const locks = Object.values(doc.locks ?? {});
  const isMine = (lock) => lock.holder?.deviceId === me().deviceId;
  const zones = locks.filter((lock) => lock.kind === "zone");
  const routes = locks.filter(
    (lock) => lock.kind === "route" && !isMine(lock) && lock.cells?.length > 1,
  );
  const otherZones = zones.filter((lock) => !isMine(lock));
  const ownZones = zones.filter(isMine);

  map.outline?.("log:locks", lockMask(otherZones, cellCount), {
    token: "--red",
    width: 2.5,
    halo: true,
  });
  map.pattern?.("log:locks-hatch", lockMask(otherZones, cellCount), { kind: "hatch-red" });
  map.outline?.("log:locks-own", lockMask(ownZones, cellCount), {
    token: "--ink",
    width: 2,
    halo: true,
    dash: [6, 4],
  });
  map.lines?.("log:routes", routes.length ? routes.map((lock) => lock.cells) : null, {
    token: "--ink",
    width: 3,
    halo: true,
    dash: [2, 6],
  });

  const plates = [...otherZones, ...routes].filter((lock) => lock.cells?.length).map(lockPlate);
  map.markers?.("log:lockplates", plates.length ? plates : null);
}

function selectEntry(id) {
  sectionFilter = null;
  const position = listEntries(state.doc).findIndex((item) => item.e.id === id) + 1;
  visibleCount = Math.max(visibleCount, position);
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

function rerouteDelta(deltaM) {
  const meters = Math.round(deltaM ?? 0);
  if (meters === 0) return t("log.rr.same");
  return `${meters > 0 ? "+" : "−"}${num(Math.abs(meters))} m`;
}

function renderReroute() {
  const reroute = state.plan?.reroute;
  const slot = $("reroute-slot");
  if (!reroute || reroute === dismissedReroute) {
    if (shownReroute) slot.replaceChildren();
    shownReroute = null;
    return;
  }
  if (reroute === shownReroute) return;
  shownReroute = reroute;

  const cause = reroute.cause ?? {};
  const crew = cause.crew ?? t("log.rr.someone");
  const causeKey = cause.type === "lock" ? "log.rr.cause.lock" : "log.rr.cause.log";
  const causeText = t(causeKey, { crew });
  const text = reroute.empty
    ? t("log.rr.empty", { cause: causeText })
    : t("log.rr.text", { cause: causeText, delta: rerouteDelta(reroute.deltaM) });
  const symbol = reroute.empty
    ? '<div class="symbol"><svg aria-hidden="true"><use href="#s-forbidden"/></svg></div>'
    : "";
  const showButton = cause.id
    ? `<button type="button" class="log-btn" data-act="rr-show">${esc(t("log.show"))}</button>`
    : "";

  const band = `<h2 class="band"><svg class="glyph" aria-hidden="true"><use href="#g-route"/></svg>`
    + `<span>${esc(t("log.rr.title"))}</span></h2>`;
  const dismissButton = `<button type="button" class="log-btn" data-act="rr-dismiss">`
    + `${esc(t("log.rr.dismiss"))}</button>`;
  const body = `<div class="body"><p class="log-rr-text">${esc(text)}</p>`
    + `<p class="log-acts">${showButton}${dismissButton}</p></div>`;

  const section = h("section", "z535", `${symbol}
    ${band}
    ${body}`);
  section.dataset.tone = reroute.empty ? "danger" : "warning";
  section.setAttribute("role", "alert");
  slot.replaceChildren(section);
}

function rerouteCell() {
  const cause = shownReroute?.cause;
  if (!cause?.id) return null;
  if (cause.type === "lock") return lockOf(cause.id)?.cells?.[0];
  return state.doc.log[cause.id]?.cell;
}

const PHOTO_START_SIDE = 480;
const PHOTO_MIN_SIDE = 160;
const PHOTO_QUALITIES = [0.7, 0.5, 0.35];

function preferredPhotoType() {
  const probe = document.createElement("canvas");
  probe.width = 1;
  probe.height = 1;
  return probe.toDataURL("image/webp").startsWith("data:image/webp") ? "image/webp" : "image/jpeg";
}

export async function shrinkPhoto(file) {
  const bitmap = await createImageBitmap(file);
  const type = preferredPhotoType();
  try {
    for (let side = PHOTO_START_SIDE; side >= PHOTO_MIN_SIDE; side = Math.round(side * 0.75)) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of PHOTO_QUALITIES) {
        const url = canvas.toDataURL(type, quality);
        if (url.length <= PHOTO_MAX) return url;
      }
    }
    return null;
  } finally {
    bitmap.close?.();
  }
}

function segment(name, value, inner, checked, attrs = "") {
  return `<label class="log-seg"><input type="radio" name="${name}" value="${value}"`
    + `${checked ? " checked" : ""}${attrs}><span>${inner}</span></label>`;
}

function options(prefix, list, selected) {
  return list.map((value) => {
    const isSelected = value === selected ? " selected" : "";
    return `<option value="${value}"${isSelected} data-i18n="${prefix}.${value}">`
      + `${esc(t(`${prefix}.${value}`))}</option>`;
  }).join("");
}

function profileCheckboxes(isChecked) {
  return PROFILE_IDS.map((profileId) => (
    `<label class="log-seg"><input type="checkbox" name="profiles" value="${profileId}"`
    + `${isChecked(profileId) ? " checked" : ""}>`
    + `<span>${i18nSpan(`log.profile.${profileId}`)}</span></label>`
  )).join("");
}

const SEVERITY_FIELDS = 'data-for="fault hazard env_change"';

function labelledControl(id, key, control) {
  return `<label for="${id}">${i18nSpan(key)}</label>${control}`;
}

function selectControl(id, name, prefix, list, selected) {
  return `<select id="${id}" name="${name}">${options(prefix, list, selected)}</select>`;
}

function textInput(id, name, maxLength, value) {
  return `<input id="${id}" name="${name}" maxlength="${maxLength}" value="${esc(value)}">`;
}

function profilesFieldset(isChecked, attrs = "") {
  return `<fieldset class="f"${attrs}><legend>${i18nSpan("log.form.profiles")}</legend>`
    + `<div class="log-seg-row">${profileCheckboxes(isChecked)}</div></fieldset>`;
}

function formFooter(submitKey) {
  const cancel = `<button type="button" class="log-btn" data-form="cancel">`
    + `${i18nSpan("log.form.cancel")}</button>`;
  const submitButton = `<button type="submit" class="log-btn log-btn-main">`
    + `${i18nSpan(submitKey)}</button>`;
  return `<div class="log-foot">${cancel}${submitButton}</div>`;
}

function sectionFieldset(section) {
  const segments = SECTIONS.map((name) => segment(
    "section",
    name,
    `${SECTION_GLYPH[name]}${i18nSpan(`log.sec.${name}`)}`,
    name === section,
    name === section ? " autofocus" : "",
  )).join("");
  return `<fieldset class="f"><legend>${i18nSpan("log.form.section")}</legend>`
    + `<div class="log-seg-grid">${segments}</div></fieldset>`;
}

function severityFieldset(severity) {
  const segments = [1, 2, 3].map((n) => segment(
    "severity",
    n,
    `${SEVERITY_GLYPH[n]}${i18nSpan(`log.sev.${n}`)}`,
    n === severity,
  )).join("");
  return `<fieldset class="f" ${SEVERITY_FIELDS}><legend>${i18nSpan("log.form.severity")}</legend>`
    + `<div class="log-seg-row">${segments}</div>\n`
    + `      <p class="muted" data-sev-hint></p></fieldset>`;
}

function whereFieldset() {
  const hereButton = `<button type="button" class="log-btn" data-form="here">`
    + `${i18nSpan("log.form.here")}</button>`;
  const pickButton = `<button type="button" class="log-btn" data-form="pick">`
    + `${i18nSpan("log.form.pick")}</button>`;
  return `<fieldset class="f"><legend>${i18nSpan("log.form.where")}</legend>\n`
    + `      <div class="log-seg-row">${hereButton}${pickButton}</div>\n`
    + `      <p class="log-loc" data-loc></p></fieldset>`;
}

function radiusField(radius) {
  return `<div class="f" ${SEVERITY_FIELDS}>`
    + `<label for="lf-radius">${i18nSpan("log.form.radius")}: `
    + `<output data-radius></output></label>\n`
    + `      <input id="lf-radius" name="radius" type="range" min="0" max="200" step="10" `
    + `value="${radius}"></div>`;
}

function faultFields(data) {
  const kind = selectControl("lf-fk", "fault_kind", "log.fault", ENUMS.fault, data.kind);
  const offset = `<input id="lf-off" name="fault_off" type="number" inputmode="decimal" `
    + `min="0" step="0.1" value="${data.offset_m ?? ""}">`;
  return `<div class="f" data-for="fault">${labelledControl("lf-fk", "log.form.kind", kind)}\n`
    + `      ${labelledControl("lf-off", "log.form.offset", offset)}</div>`;
}

function environmentFields(data) {
  const what = selectControl("lf-env", "env_what", "log.env", ENUMS.env, data.what);
  return `<div class="f" data-for="env_change">`
    + `${labelledControl("lf-env", "log.form.what", what)}</div>`;
}

function hazardFields(data) {
  const kind = selectControl("lf-hk", "haz_kind", "log.hazard", ENUMS.hazard, data.kind);
  return `<div class="f" data-for="hazard">`
    + `${labelledControl("lf-hk", "log.form.kind", kind)}</div>`;
}

function deviationFields(data) {
  const reason = textInput("lf-rs", "dev_reason", 80, data.reason);
  return `<div class="f" data-for="route_deviation">`
    + `${labelledControl("lf-rs", "log.form.reason", reason)}`
    + `<p class="muted">${i18nSpan("log.form.devhint")}</p></div>`;
}

function sampleFields(data) {
  const sampleId = textInput("lf-si", "smp_id", 40, data.sample_id);
  const rock = textInput("lf-sr", "smp_rock", 40, data.rock);
  return `<div class="f" data-for="sample">`
    + `${labelledControl("lf-si", "log.form.sample_id", sampleId)}\n`
    + `      ${labelledControl("lf-sr", "log.form.rock", rock)}</div>`;
}

function equipmentFields(data) {
  const item = textInput("lf-ei", "eq_item", 40, data.item);
  const state = selectControl("lf-es", "eq_state", "log.eq", ENUMS.eq, data.state);
  return `<div class="f" data-for="equipment">`
    + `${labelledControl("lf-ei", "log.form.item", item)}\n`
    + `      ${labelledControl("lf-es", "log.form.state", state)}</div>`;
}

function titleAndNoteFields(init) {
  const title = `<input id="lf-title" name="title" maxlength="60" autocomplete="off" `
    + `value="${esc(init.title)}">`;
  const note = `<textarea id="lf-note" name="note" maxlength="500" rows="3">`
    + `${esc(init.note)}</textarea>`;
  return `<div class="f">${labelledControl("lf-title", "log.form.title.label", title)}\n`
    + `      ${labelledControl("lf-note", "log.form.note", note)}</div>`;
}

function photoField() {
  const picker = `<label class="log-btn photo-btn">`
    + `<input class="sr" type="file" accept="image/*" capture="environment" name="photo">`
    + `${i18nSpan("log.photo.add")}</label>`;
  return `<div class="f">${picker}\n`
    + `      <span class="photo-out"></span>`
    + `<p class="muted">${i18nSpan("log.photo.hint")}</p></div>`;
}

function reportHtml(init) {
  const section = init.section ?? "hazard";
  const data = init.data ?? {};
  const severity = init.severity ?? 2;
  const profiles = init.profiles ?? PROFILE_IDS;
  const titleKey = init.supersedes ? "log.form.correct" : "log.form.title";

  return `<form class="log-form" novalidate>
    <h2 class="log-h" data-i18n="${titleKey}">${esc(t(titleKey))}</h2>
    ${sectionFieldset(section)}
    ${severityFieldset(severity)}
    ${whereFieldset()}
    ${radiusField(init.radius_m ?? 40)}
    ${profilesFieldset((profileId) => profiles.includes(profileId), ` ${SEVERITY_FIELDS}`)}
    ${faultFields(data)}
    ${environmentFields(data)}
    ${hazardFields(data)}
    ${deviationFields(data)}
    ${sampleFields(data)}
    ${equipmentFields(data)}
    ${titleAndNoteFields(init)}
    ${photoField()}
    <p class="log-err" role="alert" data-err></p>
    ${formFooter("log.form.submit")}
  </form>`;
}

function severityHintKey(section, severity) {
  if (section === "env_change") return severity >= 2 ? "log.sev.hint.env" : "log.sev.hint.1";
  return `log.sev.hint.${severity}`;
}

function deviationPath(selectedCell) {
  const cells = [state.plan?.at?.cell, selectedCell];
  return cells.filter((cell, i) => Number.isInteger(cell) && cells.indexOf(cell) === i);
}

function readReportInput(form, { selectedCell, photo, supersedes }) {
  const value = (name) => form.elements[name]?.value ?? "";
  const section = value("section");
  const offset = value("fault_off");
  return {
    section,
    severity: Number(value("severity")),
    cell: selectedCell,
    radius_m: Number(value("radius")),
    profiles: new FormData(form).getAll("profiles"),
    title: value("title").trim() || tEn(`log.sec.${section}`),
    note: value("note"),
    photo,
    supersedes,
    data: {
      kind: section === "fault" ? value("fault_kind") : value("haz_kind"),
      offset_m: offset === "" ? undefined : Number(offset),
      what: value("env_what"),
      reason: value("dev_reason"),
      path: section === "route_deviation" ? deviationPath(selectedCell) : [],
      sample_id: value("smp_id"),
      rock: value("smp_rock"),
      item: value("eq_item"),
      state: value("eq_state"),
    },
  };
}

function openReport(init = {}) {
  if (!dialog || !state.data) return;
  dialog.innerHTML = reportHtml(init);
  const form = dialog.querySelector("form");
  const errorEl = form.querySelector("[data-err]");
  const photoOut = form.querySelector(".photo-out");
  let selectedCell = Number.isInteger(init.cell) ? init.cell : hereCell();
  let photo = null;

  const sync = () => {
    const section = form.elements.section.value;
    const severity = Number(form.elements.severity.value);
    for (const el of form.querySelectorAll("[data-for]")) {
      el.hidden = !el.dataset.for.split(" ").includes(section);
    }
    form.querySelector("[data-sev-hint]").textContent = t(severityHintKey(section, severity));
    form.querySelector("[data-loc]").textContent = cellText(selectedCell);
    form.querySelector("[data-radius]").textContent = `${form.elements.radius.value}\u00a0m`;
  };

  const addPhoto = async (file) => {
    photoOut.textContent = t("log.photo.busy");
    try {
      photo = await shrinkPhoto(file);
    } catch {
      photo = null;
    }
    if (!photo) {
      photoOut.textContent = t("log.err.photo");
      return;
    }
    const image = `<img class="log-photo" src="${esc(photo)}" alt="${esc(t("log.photo.alt"))}">`;
    const removeButton = `<button type="button" class="log-btn" data-form="nophoto">`
      + `${esc(t("log.photo.remove"))}</button>`;
    photoOut.innerHTML = `${image} ${removeButton}`;
  };

  const pickLocation = async () => {
    picking = true;
    dialog.close();
    const cell = await ctx.map?.pickCell?.("log.pick.cell");
    picking = false;
    dialog.showModal();
    if (Number.isInteger(cell) && cell >= 0) selectedCell = cell;
    sync();
  };

  form.addEventListener("input", sync);
  form.addEventListener("change", async (event) => {
    sync();
    if (event.target.name !== "photo" || !event.target.files?.[0]) return;
    await addPhoto(event.target.files[0]);
  });
  form.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-form]");
    if (!button) return;
    const action = button.dataset.form;
    if (action === "cancel") {
      dialog.close();
    } else if (action === "here") {
      selectedCell = hereCell();
      sync();
    } else if (action === "nophoto") {
      photo = null;
      form.elements.photo.value = "";
      photoOut.textContent = "";
    } else if (action === "pick") {
      await pickLocation();
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = readReportInput(form, {
      selectedCell,
      photo,
      supersedes: init.supersedes,
    });
    let entry;
    try {
      entry = makeEntry(input, { id: nextId(), me: me(), clock: missionClock() });
    } catch (error) {
      const key = `log.err.${error.message}`;
      errorEl.textContent = t(has(key) ? key : "log.err.generic");
      return;
    }
    submit({ t: "log.append", entry });
    dialog.close();
    const queued = state.net?.pending;
    toast(queued ? t("log.sent.queued", { n: queued }) : t("log.sent"), "safe");
  });

  sync();
  apply(dialog);
  dialog.showModal();
}

function zoneFormHtml() {
  const reasonInput = `<input id="lz-reason" name="reason" maxlength="80" `
    + `autocomplete="off" autofocus>`;
  const stickyLabel = `<label class="log-seg"><input type="checkbox" name="sticky">`
    + `<span>${i18nSpan("log.lock.sticky.label")}</span></label>`;
  return `<form class="log-form" novalidate><h2 class="log-h">${i18nSpan("log.lock.zone")}</h2>
    <div class="f">${labelledControl("lz-reason", "log.lock.reason", reasonInput)}
      ${stickyLabel}</div>
    ${profilesFieldset(() => true)}
    <p class="muted">${i18nSpan("log.lock.hint")}</p>
    ${formFooter("log.lock.draw")}</form>`;
}

function openZone() {
  if (!dialog || !state.data) return;
  dialog.innerHTML = zoneFormHtml();
  const form = dialog.querySelector("form");

  form.addEventListener("click", (event) => {
    if (event.target.closest('[data-form="cancel"]')) dialog.close();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fields = new FormData(form);
    const reason = String(fields.get("reason") || "").trim().slice(0, 80)
      || tEn("log.lock.reason.default");
    const profiles = fields.getAll("profiles");
    const sticky = !!fields.get("sticky");

    picking = true;
    dialog.close();
    const polygon = await ctx.map?.pickPolygon?.("log.pick.zone");
    picking = false;
    if (!polygon || polygon.length < 3) return;

    const shape = thinPoly(polygon);
    const cells = [...cellsInPolygon(shape)];
    if (!cells.length || cells.length > ZONE_MAX_CELLS) {
      return toast(t("log.lock.badsize"), "warning");
    }
    submit({
      t: "lock.request",
      target: zoneTarget(me().deviceId, Date.now()),
      kind: "zone",
      cells,
      poly: shape,
      profiles: profiles.length ? profiles : PROFILE_IDS,
      reason,
      sticky,
      ttlMs: LOCK_TTL_MS,
    });
    toast(t("log.lock.sent"), "neutral");
  });

  apply(dialog);
  dialog.showModal();
}

function requestRouteLock() {
  const route = state.plan?.route;
  if (!route?.length) {
    toast(t("log.lock.noroute"), "warning");
    return;
  }
  submit({
    t: "lock.request",
    target: `route:${me().deviceId}`,
    kind: "route",
    cells: [...route],
    profiles: PROFILE_IDS,
    reason: tEn("log.lock.kind.route"),
    sticky: false,
    ttlMs: LOCK_TTL_MS,
  });
}

function releaseLock(target) {
  const lock = lockOf(target);
  if (lock) submit({ t: "lock.release", target: lock.target, fence: lock.fence });
}

function onAction(event) {
  const button = event.target.closest("[data-act]");
  if (!button || button.disabled) return;
  const action = button.dataset.act;
  const id = button.dataset.id;

  switch (action) {
    case "new":
      openReport();
      break;
    case "filter":
      sectionFilter = button.dataset.sec || null;
      visibleCount = PAGE_SIZE;
      render();
      break;
    case "more":
      visibleCount += PAGE_SIZE;
      render();
      break;
    case "photo":
      openPhotos.add(id);
      render();
      break;
    case "show":
      flyTo(state.doc.log[id]?.cell);
      break;
    case "confirm":
      submit({ t: "log.status", ref: id, status: "confirmed" });
      break;
    case "resolve":
      submit({ t: "log.status", ref: id, status: "resolved" });
      break;
    case "correct": {
      const entry = state.doc.log[id];
      if (entry) {
        openReport({ ...entry, supersedes: entry.id, data: { ...entry.data, photo: undefined } });
      }
      break;
    }
    case "lock-zone":
      openZone();
      break;
    case "lock-route":
      requestRouteLock();
      break;
    case "release":
      releaseLock(button.dataset.target);
      break;
    case "take":
      submit({
        t: "lock.request",
        target: `equip:${id}`,
        kind: "equipment",
        profiles: PROFILE_IDS,
        reason: "equipment",
        sticky: false,
        ttlMs: LOCK_TTL_MS,
      });
      break;
    case "rr-dismiss":
      dismissedReroute = shownReroute;
      renderReroute();
      break;
    case "rr-show":
      flyTo(rerouteCell());
      break;
  }
}

function paneHtml() {
  const newButton = `<button type="button" class="log-btn log-btn-main log-new" data-act="new">`
    + `+ ${i18nSpan("log.new")}</button>`;
  const filterLabel = esc(t("log.filter.label"));
  const filterGroup = `<div class="log-filter" role="group" data-i18n-aria="log.filter.label" `
    + `aria-label="${filterLabel}"></div>`;
  const emptyText = `<p class="log-empty muted" data-i18n="log.empty">${esc(t("log.empty"))}</p>`;
  return `<p class="log-head">${newButton}</p>
    ${filterGroup}
    <ul id="log-list" class="log-list"></ul><p class="log-more"></p>${emptyText}`
    + `<section class="log-locks"></section>`;
}

function refresh() {
  const doc = state.doc;
  const currentMe = state.ui.me;
  const changed = doc.log !== seen.log
    || doc.locks !== seen.locks
    || doc.assets !== seen.assets
    || currentMe !== seen.me;
  if (!changed) return;

  const logChanged = doc.log !== seen.log || doc.locks !== seen.locks || currentMe !== seen.me;
  Object.assign(seen, { log: doc.log, locks: doc.locks, assets: doc.assets, me: currentMe });
  render();
  if (logChanged) drawMap();
}

export async function init(context) {
  ctx = context;
  pane = $("pane-log");
  dialog = $("log-dialog");
  pane.innerHTML = paneHtml();
  pane.addEventListener("click", onAction);
  $("reroute-slot").addEventListener("click", onAction);
  document.addEventListener("click", (event) => {
    if (event.target.closest?.("[data-log-new]")) openReport();
  });
  on("log:new", () => openReport());
  on("map:report", () => openReport());
  dialog.addEventListener("close", () => {
    if (!picking && !dialog.open) dialog.replaceChildren();
  });
  on("doc", refresh);
  on("ui", refresh);
  on("plan", renderReroute);
  on("lang", () => {
    apply(pane);
    render();
    drawMap();
    shownReroute = null;
    renderReroute();
    if (dialog.open) apply(dialog);
  });
  refresh();
  renderReroute();
}
