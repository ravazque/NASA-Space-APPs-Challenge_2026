import { state, set, on } from "./store.js";
import { t, apply, setLang, has, pick, num } from "./i18n.js";
import { $, esc, tag, TAGS } from "./ui.js";

const TABS = ["plan", "env", "log"];
const VIEW_TABS = { plan: ["plan"], status: ["env", "log"] };
const VIEW_KEY = "ariadne.view";
const NARROW_QUERY = "(max-width: 899px)";
const CONTROLS_SELECTOR =
  "#pane-plan input, #pane-plan button, #spe, #layer, #show-traverse, #reset-goal";
const PAGES = { destino: "dest", validacion: "dest", datos: "data" };
const OVERFLOW_POLL_MS = 1000;
const OVERFLOW_SLACK_PX = 2;

const viewOf = () => (state.ui.view === "status" ? "status" : "plan");
const tabsOf = () => VIEW_TABS[viewOf()];

export function setControls(enabled) {
  for (const control of document.querySelectorAll(CONTROLS_SELECTOR)) {
    control.disabled = !enabled;
  }
}

function showTab(tab, focus) {
  const tabs = tabsOf();
  const view = viewOf();
  if (!tabs.includes(tab)) tab = tabs[0];
  document.body.dataset.view = view;
  for (const button of document.querySelectorAll("[data-view]:not(body)")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  }
  $("tabs").hidden = tabs.length < 2;
  for (const button of document.querySelectorAll("#tabs [role=tab]")) {
    const selected = button.dataset.tab === tab;
    button.hidden = !tabs.includes(button.dataset.tab);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  }
  for (const name of TABS) {
    $(`pane-${name}`).hidden = name !== tab;
  }
}

function setView(view) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {}
  set("ui", { view, tab: VIEW_TABS[view][0] });
}

function savedView() {
  try {
    return localStorage.getItem(VIEW_KEY) === "status" ? "status" : "plan";
  } catch {
    return "plan";
  }
}

function formatDuration(minutes) {
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (total < 60) return t("dur.m", { m: total });
  if (rest === 0) return t("dur.h", { h: hours });
  return t("dur.hm", { h: hours, m: rest });
}

function remainingMeters(plan) {
  if (!plan.route?.length) return null;
  const index = plan.route.indexOf(plan.at?.cell);
  if (index >= 0) return plan.tl.lengthM - plan.tl.cumM[index];
  return plan.evaS >= plan.tl.tArr ? 0 : plan.tl.lengthM;
}

function destinationText(plan) {
  const meters = remainingMeters(plan);
  if (meters == null) return "—";
  if (meters < 1) return t("guide.arrived");
  const minutes = meters / plan.tl.v / 60;
  return t("guide.left", { km: num(meters / 1000, 2), d: formatDuration(minutes) });
}

function safeReturnText(plan) {
  if (plan.safe === "ok") {
    const minutes = Math.max(0, plan.turn.turnS - plan.evaS) / 60;
    return t("guide.turn", { d: formatDuration(minutes) });
  }
  if (plan.homeMin == null) return "—";
  return t("guide.home", { d: formatDuration(plan.homeMin) });
}

function safeTone(plan) {
  if (!plan.safe || plan.safe === "pending") return "pending";
  return plan.safe === "ok" ? "safe" : "danger";
}

function renderGuide() {
  if (!state.ui.guide) return;
  const plan = state.plan;
  $("gb-dest").textContent = destinationText(plan);
  $("gb-safe-box").dataset.tone = safeTone(plan);
  $("gb-safe-k").textContent = $("safe-title").textContent;
  $("gb-safe").textContent = safeReturnText(plan);
}

let guideActive = false;

function applyGuide() {
  const on = !!state.ui.guide;
  if (on === guideActive) {
    renderGuide();
    return;
  }
  guideActive = on;
  document.body.toggleAttribute("data-guide", on);
  $("guide-bar").hidden = !on;
  if (on) {
    if (!state.ui.follow) set("ui", { follow: true });
    document.documentElement.requestFullscreen?.().catch(() => {});
    renderGuide();
    $("guide-exit").focus();
  } else if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
  renderAlert();
}

const exitGuide = () => set("ui", { guide: false });
const hasOpenDialog = () => !!document.querySelector("dialog[open]");

function initGuide() {
  $("guide-exit").addEventListener("click", exitGuide);
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && state.ui.guide) exitGuide();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.ui.guide && !hasOpenDialog()) exitGuide();
  });
  on("ui", applyGuide);
  on("plan", renderGuide);
  on("lang", renderGuide);
}

function creditLink(url, text) {
  const isWebUrl = /^https?:/.test(url ?? "");
  return isWebUrl ? `<a href="${esc(url)}">${esc(text)}</a>` : esc(text);
}

function creditItems(credits) {
  if (!credits) return null;
  return Array.isArray(credits) ? credits : credits.items;
}

function creditRow(item) {
  const key = `cr.${item.id}`;
  const topic = has(key) ? t(key) : item.id;
  const files = item.files?.length
    ? `<br><span class="data-files">${esc(t("data.files"))}: `
      + `${item.files.map((file) => `<code>${esc(file)}</code>`).join(", ")}</span>`
    : "";
  const doi = item.doi
    ? `<br><a href="https://doi.org/${esc(item.doi)}">doi:${esc(item.doi)}</a>`
    : "";
  return `<tr><th scope="row">${esc(topic)}</th><td>${esc(pick(item, "what"))}${files}</td>`
    + `<td>${creditLink(item.url, item.credit)}${doi}</td></tr>`;
}

function creditRows(items, meda) {
  const rows = (items ?? []).map(creditRow);
  if (items && meda && !items.some((item) => item.id === "meda")) {
    rows.push(`<tr><th scope="row">MEDA</th><td></td><td>${esc(meda.credit)}</td></tr>`);
  }
  return rows;
}

function creditsTable(items, rows) {
  if (!items) return `<p>${esc(t("foot.fallback"))}</p>`;
  const heads = ["topic", "what", "source"]
    .map((name) => `<th scope="col">${esc(t(`data.col.${name}`))}</th>`)
    .join("");
  return `<div class="data-scroll"><table class="data-table"><thead><tr>${heads}</tr></thead>`
    + `<tbody>${rows.join("")}</tbody></table></div>`;
}

function tagLegend() {
  return TAGS.map((name) => {
    const meaning = t(`core.tag.${name}`).replace(/^[^:]+:\s*/, "");
    return `<li>${tag(name)}<span>${esc(meaning)}</span></li>`;
  }).join("");
}

function renderData() {
  const { credits, meda } = state.data ?? {};
  const items = creditItems(credits);
  const rows = creditRows(items, meda);
  const notes = ["foot.photos", "foot.font", "foot.nominal", "foot.disclaimer"]
    .map((key) => esc(t(key)))
    .join(" ");
  $("datos-body").innerHTML = `<p class="data-lead">${esc(t("data.intro"))}</p>`
    + `<h3>${esc(t("data.tags"))}</h3><ul class="data-tags">${tagLegend()}</ul>`
    + `<h3>${esc(t("data.sources"))}</h3>${creditsTable(items, rows)}`
    + `<h3>${esc(t("data.notes"))}</h3><p>${notes}</p>`;
}

function renderFooter() {
  $("credits").textContent = t("foot.disclaimer");
  renderData();
}

function showPage() {
  const page = PAGES[location.hash.slice(1)];
  if (!page) {
    delete document.body.dataset.page;
    return;
  }
  if (state.ui.guide) exitGuide();
  document.body.dataset.page = page;
  requestAnimationFrame(() => scrollTo(0, 0));
}

export function showCoreError(file) {
  $("why").hidden = true;
  $("status").hidden = true;
  $("map-error").hidden = false;
  $("err-body").textContent = t("err.core", { file });
  $("err-body").dataset.file = file;
  document.querySelector("main").setAttribute("aria-busy", "false");
  console.error(`ARIADNE: core data failed to load (${file})`);
}

const isNarrow = () => matchMedia(NARROW_QUERY).matches || !!state.ui.guide;

function safeAlert() {
  const el = $("safe");
  if (el.getAttribute("role") !== "alert") return null;
  return {
    el,
    tone: "danger",
    title: $("safe-title").textContent,
    text: $("safe-detail").textContent,
  };
}

function rerouteAlert() {
  const el = $("reroute-slot").firstElementChild;
  if (!el) return null;
  return {
    el,
    tone: el.dataset.tone,
    title: el.querySelector(".band").textContent,
    text: el.querySelector(".log-rr-text")?.textContent ?? "",
  };
}

function hazardAlert() {
  const el = $("hazard-slot").firstElementChild;
  if (!el) return null;
  const details = [...el.querySelectorAll(".detail")]
    .map((detail) => detail.textContent.trim().replace(/[.\s]+$/, ""))
    .filter(Boolean);
  return {
    el,
    tone: el.dataset.tone,
    title: el.querySelector(".band").textContent,
    text: details.join(". "),
  };
}

const ALERTS = [
  ["safe", safeAlert],
  ["reroute", rerouteAlert],
  ["hazard", hazardAlert],
];

let shownAlert = null;
let alertKey = "";
let alertEl = null;

function activeAlerts() {
  if (!isNarrow()) return [];
  const found = [];
  for (const [id, read] of ALERTS) {
    const alert = read();
    if (alert) found.push({ id, ...alert });
  }
  return found;
}

function renderAlert() {
  const bar = $("alert-bar");
  const found = activeAlerts();
  const alert = found.find((item) => item.tone === "danger") ?? found[0];
  shownAlert = alert?.el ?? null;
  if (!alert) {
    bar.hidden = true;
    alertKey = "";
    alertEl = null;
    return;
  }
  bar.hidden = false;
  bar.dataset.tone = alert.tone;
  $("alert-sig").textContent = alert.title;
  $("alert-line").textContent = alert.text;
  $("alert-show").textContent = t("log.show");
  const key = `${alert.id}|${alert.tone}|${alert.title}`;
  if (key !== alertKey || alert.el !== alertEl) {
    alertKey = key;
    alertEl = alert.el;
    $("alert-sr").textContent = `${alert.title}. ${alert.text}`;
  }
}

function initAlertBar() {
  $("alert-show").addEventListener("click", () => {
    if (!shownAlert) return;
    if (state.ui.guide) exitGuide();
    shownAlert.scrollIntoView({ block: "start" });
    shownAlert.tabIndex = -1;
    shownAlert.focus({ preventScroll: true });
  });

  let frame = 0;
  const renderSoon = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(renderAlert);
  };
  const observer = new MutationObserver(renderSoon);
  for (const id of ["safe", "reroute-slot", "hazard-slot"]) {
    observer.observe($(id), {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["role", "data-tone"],
    });
  }
  matchMedia(NARROW_QUERY).addEventListener("change", renderSoon);
  on("lang", renderSoon);
  renderAlert();
}

function tabIndexForKey(key, current, count) {
  const last = count - 1;
  const targets = {
    ArrowRight: (current + 1) % count,
    ArrowLeft: (current + last) % count,
    Home: 0,
    End: last,
  };
  return targets[key];
}

function onTabKeydown(event) {
  const tabs = tabsOf();
  const current = tabs.indexOf(event.currentTarget.dataset.tab);
  const target = tabIndexForKey(event.key, current, tabs.length);
  if (target == null || current < 0) return;
  event.preventDefault();
  set("ui", { tab: tabs[target] });
  showTab(tabs[target], true);
}

function onUiChange(ui) {
  const opensOtherView = TABS.includes(ui.tab) && !tabsOf().includes(ui.tab);
  if (opensOtherView) {
    set("ui", { view: viewOf() === "plan" ? "status" : "plan" });
    return;
  }
  showTab(ui.tab);
}

function initTabs() {
  for (const button of document.querySelectorAll("#tabs [role=tab]")) {
    button.addEventListener("click", () => set("ui", { tab: button.dataset.tab }));
    button.addEventListener("keydown", onTabKeydown);
  }
  for (const button of document.querySelectorAll("[data-view]")) {
    button.addEventListener("click", () => setView(button.dataset.view));
  }
  on("ui", onUiChange);
  state.ui.view = savedView();
  state.ui.tab = VIEW_TABS[state.ui.view][0];
  showTab(state.ui.tab);
}

function setExpanded(expanded) {
  const button = $("pane-expand");
  document.body.toggleAttribute("data-expand", expanded);
  button.setAttribute("aria-pressed", String(expanded));
  button.firstElementChild.textContent = t(expanded ? "core.collapse" : "core.expand");
  if (expanded) document.querySelector(".side-col").scrollTop = 0;
}

const isExpanded = () => document.body.hasAttribute("data-expand");

function paneScrolls() {
  const pane = TABS.map((name) => $(`pane-${name}`)).find((item) => !item.hidden);
  return !!pane && pane.scrollHeight > pane.clientHeight + OVERFLOW_SLACK_PX;
}

function initExpand() {
  const button = $("pane-expand");
  button.addEventListener("click", () => setExpanded(!isExpanded()));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isExpanded() && !hasOpenDialog()) setExpanded(false);
  });
  on("lang", () => setExpanded(isExpanded()));

  const checkOverflow = () => {
    if (isExpanded()) return;
    button.hidden = !paneScrolls();
  };
  setInterval(checkOverflow, OVERFLOW_POLL_MS);
  addEventListener("resize", checkOverflow);
  on("ui", () => requestAnimationFrame(checkOverflow));
  checkOverflow();
}

function showToast({ text, tone = "neutral" }) {
  const toast = document.createElement("p");
  toast.className = "toast";
  toast.dataset.tone = tone;
  toast.textContent = text;
  $("toast").append(toast);
  const lifetimeMs = tone === "danger" ? 10000 : 6000;
  setTimeout(() => toast.remove(), lifetimeMs);
}

function refreshCoreError() {
  if ($("map-error").hidden) return;
  $("err-body").textContent = t("err.core", { file: $("err-body").dataset.file ?? "" });
}

export function initShell() {
  apply();
  for (const button of document.querySelectorAll("[data-lang]")) {
    button.addEventListener("click", () => setLang(button.dataset.lang));
  }
  initTabs();
  addEventListener("hashchange", showPage);
  showPage();
  initExpand();
  initGuide();
  on("toast", showToast);
  renderFooter();
  initAlertBar();
  on("lang", () => {
    renderFooter();
    refreshCoreError();
  });
}

export { renderFooter };
