// First-run onboarding — contextual coach-marks that guide the player through the
// core loop on the real UI (plant → collect → kitchen/stove → shop → register →
// bag → upgrade), replacing the old passive slide carousel.
//
// A single translucent overlay spotlights one live DOM element at a time with a
// short instruction. Auto-advancing steps complete when the game state shows the
// action was done (e.g. a bed becomes busy); informational steps advance on a
// button. The overlay is pointer-events:none so the highlighted control stays
// fully tappable — only the "next" button re-enables pointer events.
//
// Progress is stored in localStorage (client-only FTUE), independent of the
// server-authoritative game state; finishing marks the tutorial done server-side.

import { state } from "./game.js";
import * as game from "./game.js";
import { data } from "./data.js";
import * as tg from "./telegram.js";

const STORE_KEY = "gsc_coach_step";

let started = false;
let finished = false;
let idx = 0;
let active = "garden";          // last screen the UI told us about
const signals = new Set();      // one-shot events (served, bag) that steps wait on
let root = null;
let lastSig = "";               // guards against rebuilding the marks every tick
let baseline = 0;               // metric snapshot when the current step began

// ── helpers to find live anchor elements ─────────────────────────────────────
function cellEl(status) { return document.querySelector(`#screen .cell.cell-${status}`); }
function builtCellEl() { return document.querySelector("#screen .cell:not(.cell-locked)"); }
function tabEl(name) { return document.querySelector(`.tab[data-screen="${name}"]`); }

// Metrics for action steps. A step with a `metric` completes when the metric rises
// ABOVE the value captured when the step became current — so it counts an action
// the player does now, not pre-existing state. This keeps a replay (on an advanced
// account, garden already full) walking through every step instead of skipping.
function plantedBedCount() { return state.garden.filter((c) => c.built && (c.item || c.stock > 0)).length; }
function resourceQtyInInventory() {
  return Object.keys(state.inventory).reduce((n, id) => (data.resourceById[id] ? n + state.inventory[id] : n), 0);
}
function stockedShelfCount() { return state.shop.filter((c) => c.built && c.stock > 0).length; }

// Can the player actually perform this step's action right now? If not (e.g. a
// replay on a full garden with no free bed), the step auto-skips instead of
// dead-ending the tutorial.
function hasIdleGardenBed() { return state.garden.some((c) => c.built && !c.item && c.stock <= 0); }
function hasCropToCollect() { return state.garden.some((c) => c.built && (c.item || c.stock > 0)); }
function canStockAShelf() {
  return state.shop.some((c) => c.built && !c.item && c.stock <= 0)
    && Object.keys(state.inventory).some((id) => state.inventory[id] > 0);
}

// ── the guided sequence ──────────────────────────────────────────────────────
const STEPS = [
  { // 0 — plant
    text: "Тапни грядку и посади первый овощ 🌱",
    screen: "garden",
    anchor: () => cellEl("idle"),
    metric: plantedBedCount,
    canAct: hasIdleGardenBed,
  },
  { // 1 — collect
    text: "Овощ зреет. Когда будет готов ✓ — тапни грядку ещё раз, урожай уйдёт на склад.",
    screen: "garden",
    anchor: () => cellEl("ready") || cellEl("busy"),
    metric: resourceQtyInInventory,
    canAct: hasCropToCollect,
  },
  { // 2 — go to kitchen
    text: "Отлично! Теперь загляни на Кухню 🍳",
    anchor: () => tabEl("kitchen"),
    done: () => active === "kitchen",
  },
  { // 3 — need a stove (info)
    text: "Чтобы готовить блюда, нужна плита — построй её за монеты. Пока денег мало? Продавай овощи в Лавке и накопи на первую плиту.",
    screen: "kitchen",
    anchor: () => cellEl("locked") || builtCellEl(),
    manual: true,
  },
  { // 4 — go to shop
    text: "Пойдём в Лавку 🏪 — здесь покупатели берут твой товар.",
    anchor: () => tabEl("shop"),
    done: () => active === "shop",
  },
  { // 5 — stock a shelf
    text: "Тапни полку и выложи на неё овощи на продажу.",
    screen: "shop",
    anchor: () => cellEl("idle"),
    metric: stockedShelfCount,
    canAct: canStockAShelf,
  },
  { // 6 — collect payment
    text: "Покупатель встал в очередь. Тапни кассу 🧾, чтобы забрать деньги.",
    screen: "shop",
    anchor: () => document.getElementById("register-anchor"),
    done: () => signals.has("served"),
  },
  { // 7 — open the bag
    text: "Загляни на склад 🎒 — тут лежат все твои овощи и блюда.",
    anchor: () => document.getElementById("bag-btn"),
    done: () => signals.has("bag"),
  },
  { // 8 — upgrades (info, final)
    text: "Грядку, плиту и полку можно улучшать ⬆ — это открывает предметы выше уровнем. Для улучшения нужен твой уровень игрока. Удачи! 🎉",
    anchor: () => document.querySelector("#screen .lvl-chip") || builtCellEl(),
    manual: true,
    last: true,
  },
];

// ── lifecycle ────────────────────────────────────────────────────────────────
export function start() {
  if (started) return;
  started = true;
  finished = false;
  idx = clampStep(readStep());
  captureBaseline();
  ensureRoot();
  refresh();
}

// Replay the onboarding from scratch (used by the "пройти обучение заново" button).
export function restart() {
  started = false;
  finished = false;
  idx = 0;
  signals.clear();
  lastSig = "";
  writeStep(0);
  start();
}

export function onScreen(name) { active = name; refresh(); }
export function signal(name) { signals.add(name); refresh(); }
export function reposition() { if (started && !finished) paint(); }

// Called after every render() so anchors are re-read from fresh DOM.
export function refresh() {
  if (!started || finished) return;
  // Advance while the current step is satisfied. A `metric` step needs a rise
  // above its captured baseline (a fresh action), never pre-existing state.
  let guard = 0;
  while (idx < STEPS.length && guard++ < STEPS.length) {
    if (!stepComplete(STEPS[idx])) break;
    advanceTo(idx + 1);
  }
  if (idx >= STEPS.length) { finish(); return; }
  paint();
}

function stepComplete(step) {
  if (step.manual) return false;              // advances via its button
  if (step.metric) {
    if (step.canAct && !step.canAct()) return true; // action impossible now → don't dead-end
    return step.metric() > baseline;
  }
  if (step.done) return step.done();          // navigation/signal steps
  return false;
}

function advanceTo(n) { idx = n; writeStep(idx); captureBaseline(); }
// Snapshot the current step's metric so completion counts only actions from here on.
function captureBaseline() { const s = STEPS[idx]; baseline = s && s.metric ? s.metric() : 0; }

function finish() {
  finished = true;
  writeStep(STEPS.length);
  if (root) { root.replaceChildren(); root.classList.remove("active"); }
  if (game.isNewPlayer()) game.completeTutorial();
}

// ── rendering ────────────────────────────────────────────────────────────────
function ensureRoot() {
  root = document.getElementById("coach-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "coach-root";
    document.body.appendChild(root);
  }
}

function paint() {
  if (!root) ensureRoot();
  const step = STEPS[idx];
  if (!step) return;
  const el = step.anchor && step.anchor();
  // Anchor not on screen yet (e.g. waiting for the player to switch tabs): hide
  // the marks but keep the coach alive so the next render can place them.
  if (!el) { root.replaceChildren(); root.classList.remove("active"); lastSig = ""; return; }

  const r = el.getBoundingClientRect();
  // Skip the rebuild (which would restart the bubble's fade every tick) unless the
  // step or the anchor's position actually changed.
  const sig = `${idx}:${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
  if (sig === lastSig && root.classList.contains("active")) return;
  lastSig = sig;
  const pad = 6;
  const ring = document.createElement("div");
  ring.className = "coach-ring";
  ring.style.left = `${r.left - pad}px`;
  ring.style.top = `${r.top - pad}px`;
  ring.style.width = `${r.width + pad * 2}px`;
  ring.style.height = `${r.height + pad * 2}px`;

  const bubble = document.createElement("div");
  bubble.className = "coach-bubble";
  // Place below the anchor when it's in the top ~55% of the viewport, else above.
  const below = r.top + r.height / 2 < window.innerHeight * 0.55;
  bubble.classList.add(below ? "coach-below" : "coach-above");
  bubble.style.top = below ? `${r.bottom + 12}px` : "";
  bubble.style.bottom = below ? "" : `${window.innerHeight - r.top + 12}px`;

  const p = document.createElement("p");
  p.className = "coach-text";
  p.textContent = step.text;
  bubble.appendChild(p);

  if (step.manual) {
    const btn = document.createElement("button");
    btn.className = "coach-btn";
    btn.textContent = step.last ? "Играть 🎮" : "Понятно";
    btn.onclick = () => { tg.haptic("light"); advanceTo(idx + 1); refresh(); };
    bubble.appendChild(btn);
  } else {
    const hint = document.createElement("span");
    hint.className = "coach-progress";
    hint.textContent = `${idx + 1} / ${STEPS.length}`;
    bubble.appendChild(hint);
  }

  root.replaceChildren(ring, bubble);
  root.classList.add("active");
}

// ── persistence (client-only) ────────────────────────────────────────────────
function readStep() { try { return parseInt(localStorage.getItem(STORE_KEY) || "0", 10) || 0; } catch (_) { return 0; } }
function writeStep(n) { try { localStorage.setItem(STORE_KEY, String(n)); } catch (_) {} }
function clampStep(n) { return Math.max(0, Math.min(STEPS.length, n | 0)); }
