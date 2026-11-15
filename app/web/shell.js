import { state, set, on } from "./store.js";
import { t, apply, setLang, has, pick } from "./i18n.js";
import { $, esc } from "./ui.js";

const TABS = ["plan", "env", "log"];
const controls = () => document.querySelectorAll("#pane-plan input, #pane-plan button, #layer, #show-traverse, #reset-goal");
export const setControls = (enabled) => { for (const c of controls()) c.disabled = !enabled; };

function showTab(tab, focus) {
  if (!TABS.includes(tab)) tab = "plan";
  for (const b of document.querySelectorAll("#tabs [role=tab]")) {
    const on = b.dataset.tab === tab;
    b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  }
  for (const n of TABS) $(`pane-${n}`).hidden = n !== tab;
}

function renderFooter() {
  const { credits, meda } = state.data ?? {};
  const items = credits ? (Array.isArray(credits) ? credits : credits.items) : null;
  const link = (u, txt) => (/^https?:/.test(u ?? "") ? `<a href="${esc(u)}">${esc(txt)}</a>` : esc(txt));
  const data = items ? items.map((i) => `${esc(has(`cr.${i.id}`) ? t(`cr.${i.id}`) : pick(i, "what"))}: ${link(i.url, i.credit)}`) : [esc(t("foot.fallback"))];
  if (items && meda && !items.some((i) => i.id === "meda")) data.push(esc(meda.credit));
  $("credits").innerHTML = `<p>${esc(t("foot.data"))}: ${data.join(" · ")}</p><p>${["foot.photos", "foot.font", "foot.nominal", "foot.disclaimer"].map((x) => esc(t(x))).join(" ")}</p>`;
}

export function showCoreError(file) {
  $("why").hidden = true; $("status").hidden = true; $("map-error").hidden = false;
  $("err-body").textContent = t("err.core", { file }); $("err-body").dataset.file = file;
  document.querySelector("main").setAttribute("aria-busy", "false");
  console.error(`ARIADNE: core data failed to load (${file})`);
}

const narrow = () => matchMedia("(max-width: 899px)").matches;
const ALERTS = [
  ["safe", () => { const el = $("safe"); return el.getAttribute("role") === "alert" ? { el, tone: "danger", sig: $("safe-title").textContent, line: $("safe-detail").textContent } : null; }],
  ["reroute", () => { const el = $("reroute-slot").firstElementChild; return el && { el, tone: el.dataset.tone, sig: el.querySelector(".band").textContent, line: el.querySelector(".log-rr-text")?.textContent ?? "" }; }],
  ["hazard", () => { const el = $("hazard-slot").firstElementChild; return el && { el, tone: el.dataset.tone, sig: el.querySelector(".band").textContent, line: [...el.querySelectorAll(".detail")].map((d) => d.textContent.trim().replace(/[.\s]+$/, "")).filter(Boolean).join(". ") }; }],
];
let shownAlert = null, alertKey = "", alertEl = null;
function renderAlert() {
  const bar = $("alert-bar"), found = narrow() ? ALERTS.map(([id, f]) => { const a = f(); return a && { id, ...a }; }).filter(Boolean) : [];
  const a = found.find((x) => x.tone === "danger") ?? found[0];
  shownAlert = a?.el ?? null;
  if (!a) { bar.hidden = true; alertKey = ""; alertEl = null; return; }
  bar.hidden = false; bar.dataset.tone = a.tone;
  $("alert-sig").textContent = a.sig; $("alert-line").textContent = a.line; $("alert-show").textContent = t("log.show");
  const key = `${a.id}|${a.tone}|${a.sig}`;
  if (key !== alertKey || a.el !== alertEl) { alertKey = key; alertEl = a.el; $("alert-sr").textContent = `${a.sig}. ${a.line}`; }
}
function initAlertBar() {
  $("alert-show").addEventListener("click", () => {
    if (!shownAlert) return;
    if (shownAlert.id === "safe") set("ui", { tab: "plan" });
    shownAlert.scrollIntoView({ block: "start" }); shownAlert.tabIndex = -1; shownAlert.focus({ preventScroll: true });
  });
  let raf = 0;
  const later = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderAlert); };
  const mo = new MutationObserver(later);
  for (const id of ["safe", "reroute-slot", "hazard-slot"]) mo.observe($(id), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["role", "data-tone"] });
  matchMedia("(max-width: 899px)").addEventListener("change", later);
  on("lang", later);
  renderAlert();
}

export function initShell() {
  apply();
  for (const b of document.querySelectorAll("[data-lang]")) b.addEventListener("click", () => setLang(b.dataset.lang));
  for (const b of document.querySelectorAll("#tabs [role=tab]")) {
    b.addEventListener("click", () => set("ui", { tab: b.dataset.tab }));
    b.addEventListener("keydown", (e) => {
      const i = TABS.indexOf(b.dataset.tab), j = { ArrowRight: (i + 1) % 3, ArrowLeft: (i + 2) % 3, Home: 0, End: 2 }[e.key];
      if (j == null) return;
      e.preventDefault(); set("ui", { tab: TABS[j] }); showTab(TABS[j], true);
    });
  }
  on("ui", (ui) => showTab(ui.tab));
  showTab(state.ui.tab);
  on("toast", ({ text, tone = "neutral" }) => {
    const p = document.createElement("p");
    p.className = "toast"; p.dataset.tone = tone; p.textContent = text;
    $("toast").append(p);
    setTimeout(() => p.remove(), tone === "danger" ? 10000 : 6000);
  });
  renderFooter();
  initAlertBar();
  on("lang", () => { renderFooter(); if (!$("map-error").hidden) $("err-body").textContent = t("err.core", { file: $("err-body").dataset.file ?? "" }); });
}

export { renderFooter };
