// Pictures instead of emoji, for a game that has its own art (profile.art).
//
// The UI is built from strings everywhere: index.html, ui.js templates, the
// locale files, toasts, task labels. Emoji sit inside all of them, often in
// the middle of a translated sentence. Rewriting every call site to emit <img>
// would touch hundreds of lines that Grow Sell depends on, so instead this
// module watches the page and swaps known emoji in TEXT NODES for pictures as
// they appear. Grow Sell has no art, so for it start() is never called and
// nothing here runs.
//
// Three kinds of glyph are swapped:
//   - UI emoji (🪙, 💎, 🎒…) → the game's version of that icon, by meaning;
//   - item glyphs: MineSell items carry a private-use code point as their
//     `icon` (tools/minesell/build.py), registered here from the gamedata;
//   - customer glyphs: private-use code points handed to shopfloor.js.
// A picture that fails to load is replaced by text for good: the original emoji,
// or for a private-use glyph a generic fallback emoji, so a missing file shows
// as an emoji rather than as a broken image or a tofu box.
//
// Pictures that are not glyphs — cell artwork by level, modal banners — are
// looked up through cellArt() / headerArt(); screen backgrounds are plain CSS
// in the game's theme file.

import { profile } from "./profile.js";

const BASE = profile.art;
export const enabled = !!BASE;

// Emoji → picture id. Meaning, not look: 🌱 is "the first screen's tab", which
// in MineSell is the mine. Telegram Stars (⭐) are never swapped — that star is
// the payment brand. Small glyphs that read fine as text (✓ ✕ → ● ○) are left.
const UI = {
  "🪙": "ui_coin", "💎": "ui_gem",
  "🌱": "ui_tab_mine", "🍳": "ui_tab_forge", "🏪": "ui_tab_shop",
  "🎒": "ui_warehouse", "⚙": "ui_settings", "🏆": "ui_leaderboard", "📅": "ui_daily",
  "🎁": "ui_chest", "📺": "ui_ad", "🔒": "ui_lock", "⚡": "ui_speedup",
  "⬆": "ui_upgrade", "⏳": "ui_timer", "⏱": "ui_timer", "💰": "ui_moneybag",
  "🛒": "ui_cart", "🔥": "ui_streak", "🎉": "ui_celebrate", "✨": "ui_sparkle",
  "✏": "ui_rename", "🗑": "ui_trash", "🎓": "ui_tutorial", "📜": "ui_docs",
  "💬": "ui_support", "📢": "ui_news", "🌐": "ui_language",
  "🥇": "ui_medal_1", "🥈": "ui_medal_2", "🥉": "ui_medal_3",
  "🛎": "ui_bell", "💤": "ui_sleep", "🧾": "ui_receipt",
};

// What to show for a UI emoji while its picture does not exist (not generated
// yet, or failed to load). Only where the Grow Sell emoji would read wrong in
// this game — a sprout on the mine tab, a frying pan on the forge. Not in UI's
// keys, so swapping to them can never loop.
const STAND_IN = { "🌱": "⛏️", "🍳": "⚒️" };

// Customers, in the order of art/minesell/ui.json.
const CUSTOMERS = ["cust_dwarf", "cust_knight", "cust_merchant", "cust_wizard", "cust_adventurer",
  "cust_farmer", "cust_noble", "cust_sailor", "cust_elf", "cust_granny", "cust_boy", "cust_bard"];
const FACE_GLYPH = 0xE100;

const PUA = /[-]/;
const glyphs = new Map();   // private-use glyph → { src, fallback }
const failed = new Set();   // srcs that did not load: never asked for again

for (let i = 0; i < CUSTOMERS.length; i++) {
  glyphs.set(String.fromCharCode(FACE_GLYPH + i), { src: CUSTOMERS[i] + ".png", fallback: "🧑" });
}

// Items: their `icon` is a private-use glyph in MineSell's gamedata. Called once
// the gamedata is loaded. Resources fall back to a rock, products to tools.
export function registerItems(data) {
  if (!enabled) return;
  for (const [list, fallback] of [[data.resources, "🪨"], [data.products, "⚒️"]]) {
    for (const def of list) {
      if (def.icon && PUA.test(def.icon)) glyphs.set(def.icon, { src: def.id + ".png", fallback });
    }
  }
}

// The customer glyphs shopfloor.js should draw, or its own emoji when this game
// has no art.
export function faces(defaults) {
  return enabled ? CUSTOMERS.map((_, i) => String.fromCharCode(FACE_GLYPH + i)) : defaults;
}

const SCREEN_ART = { garden: "mine", kitchen: "forge", shop: "shop" };
const STAGE_FROM = [1, 5, 10, 15, 20, 25];   // cell level where stage n+1 starts

// Cell artwork: stage by level (0 = not built yet). The exact level stays on
// the level chip; the picture only has to show that the place grew.
export function cellArt(screen, level) {
  if (!enabled || !SCREEN_ART[screen]) return null;
  let stage = 0;
  if (level > 0) {
    stage = 1;
    for (let i = 0; i < STAGE_FROM.length; i++) if (level >= STAGE_FROM[i]) stage = i + 1;
  }
  // Absolute: the picture travels through a CSS custom property, and a relative
  // url() there resolves against the theme stylesheet, not against this page.
  const src = url(`cell_${SCREEN_ART[screen]}_${stage}.png`);
  return probe(src && new URL(src, document.baseURI).href);
}

// Banner over a modal ("warehouse", "settings", "leaderboard", "daily", "gems",
// "coins", "upgrade", "levelup", "offline").
export function headerArt(key) {
  return enabled && key ? url(`hdr_${key}.jpg`) : null;
}

function url(file) {
  const src = BASE + file;
  return failed.has(src) || failed.has(abs(src)) ? null : src;
}

function abs(src) {
  try { return new URL(src, document.baseURI).href; } catch (_) { return src; }
}

// CSS backgrounds have no onerror, and the grid is rebuilt on every tick, so a
// missing cell picture would be asked for again and again. Probe each one once
// with an Image and remember a miss like any other failed picture.
const probed = new Set();
function probe(src) {
  if (!src || probed.has(src) || typeof Image === "undefined") return src;
  probed.add(src);
  const img = new Image();
  img.onerror = () => failed.add(src);
  img.src = src;
  return src;
}

// ── swapping glyphs in the page ─────────────────────────────────────────────

const UI_KEYS = Object.keys(UI).sort((a, b) => b.length - a.length);
const RE = new RegExp(`(?:${UI_KEYS.join("|")})\\uFE0F?|[\\uE000-\\uF8FF]`, "gu");
const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "OPTION", "TITLE"]);

function resolve(match) {
  const key = match.replace(/️/g, "");
  const g = glyphs.get(key);
  if (g) return { src: url(g.src), text: g.fallback };
  if (PUA.test(key)) return { src: null, text: "" };   // unknown private glyph: drop it
  return { src: UI[key] ? url(UI[key] + ".png") : null, text: STAND_IN[key] || match };
}

function picture(src, text) {
  const img = document.createElement("img");
  img.className = "art-ic";
  img.src = src;
  img.alt = text;
  img.draggable = false;
  img.onerror = () => { failed.add(src); img.replaceWith(document.createTextNode(text)); };
  return img;
}

function decorateText(node) {
  const text = node.nodeValue;
  if (!text) return;
  const parent = node.parentNode;
  if (!parent || SKIP.has(parent.nodeName) || (parent.closest && parent.closest("[data-noart]"))) return;
  RE.lastIndex = 0;
  const parts = [];
  let last = 0, changed = false, m;
  while ((m = RE.exec(text))) {
    const r = resolve(m[0]);
    // A node only changes if it gains a picture or loses a private glyph.
    // Leaving everything else alone is what keeps this from looping on its own
    // mutations (a failed picture turns back into exactly the emoji it was).
    if (!r.src && !PUA.test(m[0]) && r.text === m[0]) continue;
    changed = true;
    parts.push(text.slice(last, m.index));
    parts.push(r.src ? picture(r.src, r.text) : r.text);
    last = m.index + m[0].length;
  }
  if (!changed) return;
  parts.push(text.slice(last));
  const frag = document.createDocumentFragment();
  for (const p of parts) if (p) frag.append(p);
  parent.replaceChild(frag, node);
}

function decorate(root) {
  if (root.nodeType === Node.TEXT_NODE) { decorateText(root); return; }
  if (root.nodeType !== Node.ELEMENT_NODE || SKIP.has(root.nodeName)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(decorateText);
}

// Swap what is on the page now and everything added later.
export function start() {
  if (!enabled) return;
  decorate(document.body);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") decorateText(r.target);
      else r.addedNodes.forEach(decorate);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}
