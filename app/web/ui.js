import { emit } from "./store.js";
import { t } from "./i18n.js";

export const $ = (s, root = document) => (/^[\w-]+$/.test(s) ? document.getElementById(s) : root.querySelector(s));
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

export const TAGS = ["MEASURED", "DERIVED", "MODEL", "SIMULATED", "REPORTED"];
export const tag = (name) => TAGS.includes(name)
  ? `<span class="tag tag-${name.toLowerCase()}" data-tag="${name}" title="${esc(t(`core.tag.${name}`))}" data-i18n-title="core.tag.${name}">${name}</span>`
  : "";

export const toast = (text, tone = "neutral") => emit("toast", { text, tone });
