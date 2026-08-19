// Localization: one dictionary per language, plus number/time/plural formatting.
//
// Plain ES modules, no bundler and no runtime dependency — same constraint as
// the rest of the web app.
//
// Usage:
//   t("cell_build")                    → "Построить" / "Build"
//   t("build_confirm", { what, cost }) → fills {what} and {cost}
//   tp("chest_count", n)               → picks the right plural form for n
//
// Plurals go through Intl.PluralRules rather than hand-written rules: Russian
// needs one/few/many (1 сундук, 2 сундука, 5 сундуков) and English needs
// one/other, and getting that wrong is how you end up with "1 buyers".

import { ru } from "./locales/ru.js";
import { en } from "./locales/en.js";

const DICTS = { ru, en };
export const SUPPORTED = ["en", "ru"];
const FALLBACK = "en";

let locale = FALLBACK;
const listeners = new Set();

// Normalize anything host-shaped ("ru-RU", "en_US", "RU") to a supported tag.
function normalize(tag) {
  if (!tag || typeof tag !== "string") return null;
  const base = tag.toLowerCase().replace("_", "-").split("-")[0];
  return SUPPORTED.includes(base) ? base : null;
}

// Resolution order, most specific first:
//   1. the player's explicit choice (persisted in the save)
//   2. the Telegram account language
//   3. the device/browser language
//   4. English
// `saved` comes from the save file; `hostLang` from the platform driver.
export function resolveLocale(saved, hostLang) {
  const candidates = [saved, hostLang, ...(navigator.languages || []), navigator.language];
  for (const c of candidates) {
    const n = normalize(c);
    if (n) return n;
  }
  return FALLBACK;
}

export function getLocale() { return locale; }

export function setLocale(next) {
  const n = normalize(next) || FALLBACK;
  if (n === locale) return;
  locale = n;
  document.documentElement.lang = n;
  listeners.forEach((fn) => { try { fn(n); } catch (_) {} });
}

// The player's explicit choice. Kept in localStorage rather than the game save:
// the save is reconciled from the server, which knows nothing about a language
// column and would drop it. Same pattern as the coach's stored step.
const LANG_KEY = "gsc_lang";

export function savedLocale() {
  try { return localStorage.getItem(LANG_KEY); } catch (_) { return null; }
}

function persist(l) {
  try { localStorage.setItem(LANG_KEY, l); } catch (_) {}
}

// Called once at boot, before the first render — no listeners fire.
export function initLocale(hostLang) {
  locale = resolveLocale(savedLocale(), hostLang);
  document.documentElement.lang = locale;
  return locale;
}

// Explicit switch from the language picker: persists, so it wins over the
// device language from then on.
export function chooseLocale(next) {
  const n = normalize(next) || FALLBACK;
  persist(n);
  setLocale(n);
}

// Notified whenever the player switches language, so the UI can re-render.
export function onLocaleChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function lookup(key) {
  const d = DICTS[locale];
  if (d && key in d) return d[key];
  const f = DICTS[FALLBACK];
  if (f && key in f) return f[key];
  return null; // caller falls back to the key itself, so misses are visible
}

function interpolate(str, params) {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (m, name) =>
    (params[name] !== undefined ? String(params[name]) : m));
}

export function t(key, params) {
  const entry = lookup(key);
  if (entry === null) return key;
  if (typeof entry === "object") return interpolate(entry.other || key, params);
  return interpolate(entry, params);
}

// Plural form for `n`. The dictionary entry is an object keyed by CLDR
// categories ({ one, few, many, other }); {n} in the chosen form gets the count.
export function tp(key, n, params) {
  const entry = lookup(key);
  if (entry === null) return key;
  if (typeof entry !== "object") return interpolate(entry, { n, ...params });
  const cat = new Intl.PluralRules(locale).select(n);
  const form = entry[cat] || entry.other || entry.one;
  return interpolate(form, { n, ...params });
}

// ── formatting ───────────────────────────────────────────────────────────────

// Thousands separators follow the language: 1 206 in Russian, 1,206 in English.
export function fmtNum(n) {
  return Math.floor(n).toLocaleString(locale === "ru" ? "ru-RU" : "en-US");
}

// Compact duration: seconds under a minute, otherwise minutes.
export function fmtDuration(s) {
  return s < 60
    ? t("unit_sec", { n: Math.round(s) })
    : t("unit_min", { n: Math.round(s / 60) });
}

// Item names live in shared/gamedata as `name` (Russian) + `name_en`. Anything
// without a translation falls back to the Russian original rather than a blank.
export function itemName(def) {
  if (!def) return "";
  return locale === "ru" ? (def.name || def.name_en || "") : (def.name_en || def.name || "");
}

// A player's leaderboard name. A name the player typed himself is shown verbatim
// in every language; a generated one arrives from the server as a role key plus a
// number and is rendered here, so the same player reads as "Садовник 7" or
// "Gardener 7" depending on who's looking. Accepts both shapes the server sends:
// leaderboard rows ({name, role, num}) and the profile ({displayName, nameRole,
// nameNum}).
export function playerName(p) {
  if (!p) return t("player_default");
  const custom = p.name || p.displayName;
  if (custom) return custom;
  const role = p.role || p.nameRole;
  if (role) return t("name_role_" + role, { n: p.num || p.nameNum || 1 });
  return t("player_default");
}
