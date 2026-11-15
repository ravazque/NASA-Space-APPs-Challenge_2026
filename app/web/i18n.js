import { emit } from "./store.js";

export const DICT = { en: {}, es: {} };

export function register(dict) {
  for (const code of Object.keys(DICT)) {
    Object.assign(DICT[code], dict?.[code]);
  }
}

const STORAGE_KEY = "ariadne.lang";
const LANGS = ["en", "es"];

function initialLang() {
  const fromUrl = new URLSearchParams(globalThis.location?.search ?? "").get("lang");
  if (LANGS.includes(fromUrl)) {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, fromUrl);
    } catch {}
    return fromUrl;
  }
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (LANGS.includes(saved)) return saved;
  } catch {}
  return "en";
}

let lang = initialLang();

export const getLang = () => lang;

export const has = (key) => key in DICT[lang] || key in DICT.en;

const UNITS = "km|m|MJ|min|ms|s|h|m\\/s|%|°C|µGy(?:\\/[a-zñí]+)?";
const NBSP_BEFORE_UNIT = new RegExp(`(\\d) (?=(?:${UNITS})(?![\\p{L}\\d]))`, "gu");

export function t(key, vars = {}) {
  const text = DICT[lang][key] ?? DICT.en[key] ?? key;
  return text
    .replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? "")
    .replace(NBSP_BEFORE_UNIT, "$1\u00a0");
}

export function shown(text) {
  const isTranslatable = typeof text === "string" && has(`txt.${text}`);
  return isTranslatable ? t(`txt.${text}`) : text;
}

export const tEn = (key) => DICT.en[key] ?? key;

export function num(n, decimals = 0) {
  const formatted = Number(n).toLocaleString(lang, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return formatted.replace(/^-/, "−");
}

const DEFAULT_DATE_FORMAT = { day: "numeric", month: "short", year: "numeric" };

export function date(iso, format = DEFAULT_DATE_FORMAT) {
  return new Date(iso).toLocaleDateString(lang, { ...format, timeZone: "UTC" });
}

export function pick(obj, base) {
  return obj?.[`${base}_${lang}`]
    ?? obj?.[`${base}_en`]
    ?? obj?.[`${base}_es`]
    ?? obj?.[base]
    ?? "";
}

export function apply(root = document) {
  document.documentElement.lang = lang;
  document.title = t("doc.title");
  document.querySelector('meta[name="description"]')?.setAttribute("content", t("doc.description"));
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll("[data-i18n-aria]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAria));
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of root.querySelectorAll("[data-tag]")) {
    el.textContent = t(`core.tagw.${el.dataset.tag}`);
  }
  for (const button of root.querySelectorAll("[data-lang]")) {
    button.setAttribute("aria-pressed", String(button.dataset.lang === lang));
  }
}

export function setLang(newLang) {
  if (!LANGS.includes(newLang)) return;
  try {
    const url = new URL(location.href);
    url.searchParams.set("lang", newLang);
    history.replaceState(null, "", url);
  } catch {}
  if (newLang === lang) return;
  lang = newLang;
  try {
    localStorage.setItem(STORAGE_KEY, newLang);
  } catch {}
  apply();
  emit("lang", newLang);
}
