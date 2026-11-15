import { emit } from "./store.js";

export const DICT = { en: {}, es: {} };
export const register = (dict) => { for (const l of Object.keys(DICT)) Object.assign(DICT[l], dict?.[l]); };

const KEY = "ariadne.lang", LANGS = ["en", "es"];
let lang = (() => {
  const q = new URLSearchParams(globalThis.location?.search ?? "").get("lang");
  if (LANGS.includes(q)) { try { globalThis.localStorage?.setItem(KEY, q); } catch {} return q; }
  try { const s = globalThis.localStorage?.getItem(KEY); if (LANGS.includes(s)) return s; } catch {}
  return "en";
})();

export const getLang = () => lang;
export const has = (key) => key in DICT[lang] || key in DICT.en;
const UNIT = /(\d) (?=(?:km|m|MJ|min|ms|s|h|m\/s|%|°C|µGy(?:\/[a-zñí]+)?)(?![\p{L}\d]))/gu;
export const t = (key, v = {}) => (DICT[lang][key] ?? DICT.en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "").replace(UNIT, "$1\u00a0");
export const shown = (s) => (typeof s === "string" && has(`txt.${s}`) ? t(`txt.${s}`) : s);
export const tEn = (key) => DICT.en[key] ?? key;
export const num = (n, d = 0) => Number(n).toLocaleString(lang, { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/^-/, "−");
export const date = (iso, o = { day: "numeric", month: "short", year: "numeric" }) => new Date(iso).toLocaleDateString(lang, { ...o, timeZone: "UTC" });
export const pick = (obj, base) => obj?.[`${base}_${lang}`] ?? obj?.[`${base}_en`] ?? obj?.[`${base}_es`] ?? obj?.[base] ?? "";

export function apply(root = document) {
  document.documentElement.lang = lang;
  document.title = t("doc.title");
  document.querySelector('meta[name="description"]')?.setAttribute("content", t("doc.description"));
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll("[data-tag]")) el.textContent = t(`core.tagw.${el.dataset.tag}`);
  for (const b of root.querySelectorAll("[data-lang]")) b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
}

export function setLang(l) {
  if (!LANGS.includes(l)) return;
  try { const u = new URL(location.href); u.searchParams.set("lang", l); history.replaceState(null, "", u); } catch {}
  if (l === lang) return;
  lang = l;
  try { localStorage.setItem(KEY, l); } catch {}
  apply(); emit("lang", l);
}
