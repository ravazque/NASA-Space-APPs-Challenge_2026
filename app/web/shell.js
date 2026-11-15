import { state, set, on } from "./store.js";
import { t, apply, setLang, has, pick } from "./i18n.js";
import { $, esc } from "./ui.js";

const TABS = ["plan", "env", "log"];
const NARROW_QUERY = "(max-width: 899px)";
const CONTROLS_SELECTOR =
  "#pane-plan input, #pane-plan button, #layer, #show-traverse, #reset-goal";

export function setControls(enabled) {
  for (const control of document.querySelectorAll(CONTROLS_SELECTOR)) {
    control.disabled = !enabled;
  }
}

function showTab(tab, focus) {
  if (!TABS.includes(tab)) tab = "plan";
  for (const button of document.querySelectorAll("#tabs [role=tab]")) {
    const selected = button.dataset.tab === tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  }
  for (const name of TABS) {
    $(`pane-${name}`).hidden = name !== tab;
  }
}

function creditLink(url, text) {
  const isWebUrl = /^https?:/.test(url ?? "");
  return isWebUrl ? `<a href="${esc(url)}">${esc(text)}</a>` : esc(text);
}

function creditItems(credits) {
  if (!credits) return null;
  return Array.isArray(credits) ? credits : credits.items;
}

function creditLine(item) {
  const key = `cr.${item.id}`;
  const what = has(key) ? t(key) : pick(item, "what");
  return `${esc(what)}: ${creditLink(item.url, item.credit)}`;
}

function renderFooter() {
  const { credits, meda } = state.data ?? {};
  const items = creditItems(credits);
  const lines = items ? items.map(creditLine) : [esc(t("foot.fallback"))];
  if (items && meda && !items.some((item) => item.id === "meda")) {
    lines.push(esc(meda.credit));
  }
  const notes = ["foot.photos", "foot.font", "foot.nominal", "foot.disclaimer"]
    .map((key) => esc(t(key)))
    .join(" ");
  $("credits").innerHTML = `<p>${esc(t("foot.data"))}: ${lines.join(" · ")}</p><p>${notes}</p>`;
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

const isNarrow = () => matchMedia(NARROW_QUERY).matches;

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
    if (shownAlert.id === "safe") set("ui", { tab: "plan" });
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

function tabIndexForKey(key, current) {
  const last = TABS.length - 1;
  const targets = {
    ArrowRight: (current + 1) % TABS.length,
    ArrowLeft: (current + last) % TABS.length,
    Home: 0,
    End: last,
  };
  return targets[key];
}

function initTabs() {
  for (const button of document.querySelectorAll("#tabs [role=tab]")) {
    button.addEventListener("click", () => set("ui", { tab: button.dataset.tab }));
    button.addEventListener("keydown", (event) => {
      const target = tabIndexForKey(event.key, TABS.indexOf(button.dataset.tab));
      if (target == null) return;
      event.preventDefault();
      set("ui", { tab: TABS[target] });
      showTab(TABS[target], true);
    });
  }
  on("ui", (ui) => showTab(ui.tab));
  showTab(state.ui.tab);
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
  on("toast", showToast);
  renderFooter();
  initAlertBar();
  on("lang", () => {
    renderFooter();
    refreshCoreError();
  });
}

export { renderFooter };
