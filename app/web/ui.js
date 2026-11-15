import { emit } from "./store.js";
import { t } from "./i18n.js";

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

export function $(selector, root = document) {
  const isPlainId = /^[\w-]+$/.test(selector);
  return isPlainId ? document.getElementById(selector) : root.querySelector(selector);
}

export function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => HTML_ESCAPES[char]);
}

export function h(tagName, className, html) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (html != null) element.innerHTML = html;
  return element;
}

export const TAGS = ["MEASURED", "DERIVED", "MODEL", "SIMULATED", "REPORTED"];

export function tag(name) {
  if (!TAGS.includes(name)) return "";
  const title = esc(t(`core.tag.${name}`));
  const word = esc(t(`core.tagw.${name}`));
  return `<span class="tag tag-${name.toLowerCase()}" data-tag="${name}" title="${title}" `
    + `data-i18n-title="core.tag.${name}">${word}</span>`;
}

export function ico(id) {
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">`
    + `<use href="#${id}"/></svg>`;
}

export function toast(text, tone = "neutral") {
  emit("toast", { text, tone });
}
