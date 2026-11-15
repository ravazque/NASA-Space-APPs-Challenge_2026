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
  on("lang", () => { renderFooter(); if (!$("map-error").hidden) $("err-body").textContent = t("err.core", { file: $("err-body").dataset.file ?? "" }); });
}

export { renderFooter };
