// Game state + rules — a faithful web port of the Godot game's cell model
// (scripts/cells/*, game_manager.gd, player_save.gd). 12 cells per screen;
// build/upgrade with coins; level-gated planting/cooking/stocking; customers
// buy from shop shelves. Wall-clock timestamps drive offline progress.

import { data } from "./data.js";
import * as econ from "./economy.js";
import * as tg from "./platform.js";
import { t, itemName } from "./i18n.js";
import * as ads from "./ads.js";
import * as backend from "./backend.js";

const N = 12; // cells per screen (4×3), like the original

function newCell(built = false) {
  // item: assigned resource/product id; startedAt: production start (ms, 0=idle);
  // stock: ready-to-collect qty (garden/kitchen) or units on shelf (shop)
  return { built, level: 1, item: "", startedAt: 0, stock: 0 };
}

export const state = {
  coins: 0,
  gems: 0,            // premium currency
  boostOfflineX2: false, // permanent: ×2 offline earnings
  autoRegister: false,   // permanent: customers pay without tapping
  xp: 0,
  level: 1,
  garden: Array.from({ length: N }, (_, i) => newCell(i === 0)),
  kitchen: Array.from({ length: N }, () => newCell(false)),
  shop: Array.from({ length: N }, (_, i) => newCell(i === 0)),
  inventory: {}, // { itemId: qty }
  queue: [],     // customers waiting at the register: [{ item, price }]
  adTimes: [],   // ms timestamps of recent rewarded-ad views (hourly cap)
  adBonusAt: 0,  // ms of the last free-coins ad (per-placement cooldown)
  daily: { day: -1, tasks: [], streak: 0, streakDay: -1, streakFloor: 3, chestDay: -1, chestCount: 0, chestLastAt: 0 },
  lastSeen: Date.now(),
  tutorialDone: false,
};

// transient (not saved): last offline earnings summary to surface once
export let offlineReport = null;

// Phase 4 profile (leaderboard name + one-time intro), owned by the server and
// mirrored here from action responses. `loaded` guards the intro until we know.
// displayName is set only for a player-chosen name; a generated one comes as
// nameRole + nameNum and is rendered per-language by i18n.playerName().
export const profile = {
  displayName: null, nameRole: null, nameNum: null,
  nameCustom: false, nameSeen: false, loaded: false,
};
function applyProfile(p) { if (p) Object.assign(profile, p, { loaded: true }); }
// Update the local mirror after a rename / intro-ack (server already persisted it).
export function setLocalName(name, seen = true) {
  if (name) { profile.displayName = name; profile.nameCustom = true; }
  if (seen) profile.nameSeen = true;
}

let onChange = () => {};
export function subscribe(fn) { onChange = fn; }

// Во время переигрывания (см. replayPending) действия применяются повторно к уже
// принятому серверному состоянию. Побочные эффекты при этом не нужны: очередь не
// должна пополняться заново, телефон не должен отбить два десятка вибраций, а
// модалка левелапа не должна выскочить на каждом шаге. Всё это делается один раз
// после переигрывания, в reconcile.
let replaying = false;
function buzz(kind) { if (!replaying) tg.haptic(kind); }
function changed() { if (replaying) return; save(); onChange(); watchLevel(); }

export function cellsOf(screen) { return state[screen]; }

// ── Level-up watch ───────────────────────────────────────────────────────────
// Fires once each time the player's level rises, whether the increase came from a
// local optimistic gainXp or from a server reconcile — deduped by watchedLevel.
let onLevelUp = () => {};
let watchedLevel = 1;
export function subscribeLevelUp(fn) { onLevelUp = fn; }
function resetLevelWatch() { watchedLevel = state.level; }
function watchLevel() {
  if (state.level > watchedLevel) {
    const to = state.level;
    watchedLevel = to;
    onLevelUp(to);
  }
}

// ── Server-authoritative sync (Phase 2, behind backend.SERVER_AUTH) ──────────
// The client mutates locally for a snappy UI (optimistic prediction), then the
// server is the authority: adopt whatever canonical state it returns. Because
// both run the same economy rules, the correction is usually invisible.
// Что переигрывается поверх серверного состояния. Типов, которых здесь нет, это
// не касается: `touch` ничего не меняет, покупки и do-all подтверждаются сразу.
// Их локальный эффект временно откатится и вернётся со следующей сверкой, когда
// сервер их применит.
const REPLAY = {
  build:          (a) => build(a.screen, a.i),
  upgrade:        (a) => upgrade(a.screen, a.i),
  plant:          (a) => plant(a.i, a.cropId),
  collectGarden:  (a) => collectGarden(a.i),
  cook:           (a) => cook(a.i, a.recipeId),
  collectKitchen: (a) => collectKitchen(a.i),
  stockShelf:     (a) => stockShelf(a.i, a.itemId),
  serve:          () => collectPayment(),
  skipProduction: (a) => skipProduction(a.screen, a.i),
};

// Переиграть неподтверждённые действия. Безопасно в обе стороны: если сервер их
// уже применил, принятое состояние это отражает и повторный вызов упрётся в
// собственную проверку (грядка уже пуста, полка уже занята) и вернёт false. Если
// не применил — эффект вернётся на экран. Именно это и позволяет сверяться в
// любой момент, а не только когда очередь пуста.
function replayPending() {
  const pend = backend.pendingActions();
  if (!pend.length) return;
  replaying = true;
  try {
    for (const a of pend) {
      const fn = REPLAY[a.type];
      if (fn) fn(a.args || {});
    }
  } finally {
    replaying = false;
  }
}

function reconcile(serverState, report, prof) {
  applyProfile(prof);
  if (!serverState) return;
  migrate(serverState);
  Object.assign(state, serverState);
  if (report) offlineReport = report;
  replayPending();
  save();
  onChange();
  watchLevel();
}

// Record a locally-applied mutation for the server. Buffered, not sent one by
// one: the player has already seen the result on screen, so nothing here is
// waiting on a reply, and a burst of taps costs one request instead of dozens
// (see the batching notes in backend.js). No-op unless server-auth is on.
//
// Nothing reconciles here any more. The reply to a batch arrives while the
// player is still tapping, and adopting it would put state that predates those
// taps back on screen. The 10s poll reconciles instead, and only when there is
// nothing outstanding.
function afterAction(type, args) {
  if (replaying) return;                 // переигрывание — не ставим в очередь заново
  if (!backend.serverAuth()) return;
  backend.enqueue(type, args);
}

// Poll the server so it advances production/customers and we reconcile, even
// when the player is idle (replaces the /api/sync push cadence in server-auth).
let pollTimer = null;
let lastTouchAt = 0;
async function touchSync() {
  lastTouchAt = Date.now();
  const r = await backend.action("touch", {});
  // Тапы, накопившиеся пока запрос был в полёте, в возвращённом состоянии не
  // учтены — но reconcile переигрывает их поверх, поэтому пропускать сверку
  // больше не нужно. Раньше здесь стояла проверка hasPending(), и при активной
  // игре сверка не случалась почти никогда.
  if (r) reconcile(r.state, r.offlineReport, r.profile);
}
// Сервер отверг действие, которое мы уже показали применённым. Значит наше
// состояние разошлось с трезвым, и до сверки каждое следующее действие будет
// отклоняться по той же причине. Сверяемся немедленно: очередь только что
// подтвердили, так что touchSync почти всегда сверится тут же, а не через опрос.
// Тихо и без тоста — расхождение редкое, а всплывающее сообщение про сеть игрок
// прочитает как поломку игры.
//
// Через pokeSync, а не напрямую: причины из RESYNC (собрать нечего, клетка
// занята) — это ещё и обычные гонки, они могут прилетать пачками, и сверка на
// каждую превратилась бы в поток запросов. Полутора секунд достаточно, чтобы
// откат выглядел мгновенным, и достаточно, чтобы не долбить сервер.
backend.setDivergedHandler(() => { pokeSync(1500); });

function startServerPoll() {
  if (pollTimer || !backend.serverAuth()) return;
  pollTimer = setInterval(touchSync, 10000);
}
function stopServerPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// On-demand reconcile, throttled — used while the shop screen is open so newly
// spawned customers show up promptly instead of waiting on the 10s poll.
export function pokeSync(minGapMs = 3000) {
  if (!backend.serverAuth()) return;
  if (Date.now() - lastTouchAt < minGapMs) return;
  touchSync();
}

// Called when the app comes back to the foreground. iOS suspends the WKWebView
// while backgrounded, which freezes both timers (the 10s server poll and the UI
// ticker), so without this the player stares at a stale screen until the poll
// happens to fire — and never sees the welcome-back summary, because that was
// only ever produced at cold start.
//
// Same two paths as load(): the server settles the absence under server-auth,
// otherwise we settle locally. Resolves once state is current; the caller then
// renders and shows the offline report if one appeared.
export async function onResume() {
  if (backend.serverAuth()) {
    await touchSync();   // unthrottled on purpose — this is a real wake-up
    return;
  }
  settleOffline();
  rolloverDaily(Date.now());
  changed();
}

// A paid do-all runs server-side inside the Stars payment webhook. The webhook
// can land a moment after the openInvoice "paid" callback, so pull the canonical
// state a few times until the result shows up (each touch also re-renders).
export async function reconcilePaidDoAll() {
  if (!backend.serverAuth()) return;
  for (let i = 0; i < 5; i++) {
    await touchSync();
    await new Promise((r) => setTimeout(r, 1200));
  }
}

// ── Persistence ──────────────────────────────────────────────────────────────

// Boot. Resolves as soon as there is something worth drawing, and hands back a
// `settled` promise for the moment the server has had its say.
//
// The split is the whole point. This used to await the network before the first
// render, and under server-auth it ignored the local save entirely — so every
// launch showed the empty HUD shell (0 coins, level 1) until the round trip
// finished. On a phone that was about twelve seconds of a game that looks wiped.
//
// A returning player has their own save on disk, one frame away. We draw that
// immediately and let `touch` correct it a moment later; the correction is
// normally invisible, and anything the player taps meanwhile is replayed on top
// by reconcile() rather than lost. Only a player with NO local save has to wait,
// and there we genuinely cannot proceed: without the server we cannot tell a
// brand-new player from a reinstall, and guessing wrong either replays the
// tutorial over a real account or hides the game behind onboarding.
export async function load() {
  const saved = await tg.loadState();

  if (backend.serverAuth()) {
    if (saved && typeof saved === "object") {
      migrate(saved);
      Object.assign(state, saved);
      resetLevelWatch();
      startServerPoll();
      // Not awaited: it reconciles through the normal path, so pending taps are
      // replayed and the level-up watch fires if the server says we grew. The
      // catch is attached here rather than at the await, so a rejection that
      // beats the caller to it is never an unhandled one.
      return { settled: touchSync().catch(() => {}) };
    }
    const r = await backend.action("touch", {});
    if (r && r.state) {
      migrate(r.state);
      Object.assign(state, r.state);
      offlineReport = r.offlineReport || null;
      applyProfile(r.profile);
      resetLevelWatch();
      startServerPoll();
      return { settled: Promise.resolve() };
    }
  }

  // Legacy (Phase 1): the backend stores the client save; adopt what it returns
  // (referral / purchase gems folded in once, entitlements enforced). No-op /
  // falls back to local when the URL is empty or we're outside Telegram.
  const remote = await backend.sync(saved || null);
  let local = saved;
  if (remote && remote.save && typeof remote.save === "object") local = remote.save;

  if (local && typeof local === "object") {
    migrate(local);
    Object.assign(state, local);
  } else {
    state.gems = (data.economy.gems && data.economy.gems.start) || 0; // starter gems
  }
  settleOffline();
  rolloverDaily(Date.now()); // local/legacy mode owns the daily rollover (no-op under server-auth)
  resetLevelWatch();
  return { settled: Promise.resolve() };
}

function migrate(s) {
  // Backfill any missing structure (older saves / partial objects).
  for (const scr of ["garden", "kitchen", "shop"]) {
    if (!Array.isArray(s[scr])) {
      const openFirst = scr !== "kitchen";
      s[scr] = Array.from({ length: N }, (_, i) => newCell(openFirst && i === 0));
    } else {
      while (s[scr].length < N) s[scr].push(newCell(false));
      s[scr] = s[scr].map((c) => Object.assign(newCell(false), c));
    }
  }
  if (!s.inventory) s.inventory = {};
  if (!Array.isArray(s.queue)) s.queue = [];
  if (!Array.isArray(s.adTimes)) s.adTimes = [];
  if (typeof s.adBonusAt !== "number") s.adBonusAt = 0;
  if (typeof s.coins !== "number") s.coins = 0;
  if (typeof s.gems !== "number") s.gems = 0;
  s.boostOfflineX2 = !!s.boostOfflineX2;
  s.autoRegister = !!s.autoRegister;
  ensureDaily(s);
}

function save() {
  if (deleted) return; // account is gone; nothing this page still holds may be written back
  state.lastSeen = Date.now();
  tg.saveState(state);
  backend.queuePush(() => state); // throttled background push to the authoritative store
}

// Apply time passed while away: production finishes via timestamps already;
// customers who queued (or would have) are auto-served for the elapsed time.
// Зеркало серверного самосева (backend/src/sim.js wildHarvest) для локального
// режима — под SERVER_AUTH считает сервер, а клиент только рисует его отчёт.
// Правила те же: только построенные грядки, только сырьё, ноль XP, окно из
// конфига, культура берётся из верхних тиров ИМЕННО этой грядки.
function wildHarvest(elapsed) {
  const cfg = data.economy.offline;
  if (!cfg) return null;
  if (state.level < cfg.min_player_level) return null;
  const hours = Math.min(elapsed / 3600, cfg.window_hours);
  const per = Math.floor(cfg.units_per_cell_per_hour * hours);
  if (per <= 0) return null;

  const got = {};
  let total = 0;
  for (const cell of state.garden) {
    if (!cell.built) continue;
    const pool = data.resources.filter((r) =>
      r.unlock_level <= cell.level && r.unlock_level > cell.level - 1 - cfg.tier_spread);
    if (!pool.length) continue;
    const n = Math.min(per, cfg.max_units - total);
    if (n <= 0) break;
    const crop = pool[Math.floor(Math.random() * pool.length)];
    got[crop.id] = (got[crop.id] || 0) + n;
    addInventory(crop.id, n);
    total += n;
  }
  if (!total) return null;
  return {
    hours: Math.round(hours * 10) / 10,
    items: Object.entries(got).map(([id, qty]) => ({ id, qty })),
  };
}

function settleOffline() {
  const now = Date.now();
  const elapsed = Math.max(0, (now - (state.lastSeen || now)) / 1000);
  offlineReport = null;
  // Quick reopen: leave the waiting queue intact so the player taps the register.
  if (elapsed < 30) return;

  const wild = wildHarvest(elapsed);
  const interval = econ.npcSpawnInterval(state.shop);
  let budget = Math.floor(elapsed / interval);
  let earned = 0, sold = 0, queued = 0;

  if (state.autoRegister) {
    // Auto-register perk: the register serves everyone while you're away.
    const factor = state.boostOfflineX2 ? 2 : 1;
    while (state.queue.length) {
      const c = state.queue.shift();
      const g = c.price * factor;
      earned += g; state.coins += g;
      gainXp(econ.xpReward("npc_sale", econ.xpTier(c.item))); sold++;
    }
    while (budget-- > 0) {
      const t = takeFromShelf();
      if (!t) break; // shelves empty
      const g = t.price * factor;
      earned += g; state.coins += g;
      gainXp(econ.xpReward("npc_sale", econ.xpTier(t.item))); sold++;
    }
    if (sold > 0 || wild) offlineReport = { earned, sold, x2: factor === 2, wild };
  } else {
    // Default: customers who arrived while away only LINE UP (up to MAX_QUEUE)
    // — collecting their money at the register is the player's job.
    while (budget-- > 0 && state.queue.length < MAX_QUEUE) {
      const t = takeFromShelf();
      if (!t) break;
      state.queue.push(t); queued++;
    }
    if (queued > 0 || wild) offlineReport = { queued, wild };
  }
  state.lastSeen = now;
  // Persist immediately: shelves were decremented and the queue changed —
  // losing this on an early exit would lose the taken stock.
  if (sold > 0 || queued > 0 || wild) save();
}

// ── Build / upgrade (shared by all screens) ──────────────────────────────────

export function build(screen, i) {
  const cell = state[screen][i];
  if (!cell || cell.built) return false;
  const cost = econ.buildCost(i);
  if (state.coins < cost) return false;
  state.coins -= cost;
  cell.built = true;
  cell.level = 1;
  bumpDaily("build", { screen, amount: 1 });
  buzz("success");
  changed();
  afterAction("build", { screen, i });
  return true;
}

export function upgrade(screen, i) {
  const cell = state[screen][i];
  if (!cell || !cell.built) return false;
  if (state.level < cell.level + 1) return false; // need player level
  const cost = econ.upgradeCost(cell.level);
  if (state.coins < cost) return false;
  state.coins -= cost;
  cell.level += 1;
  gainXp(econ.xpReward("upgrade_cell", cell.level));
  bumpDaily("upgrade", { screen, amount: 1 });
  buzz("success");
  changed();
  afterAction("upgrade", { screen, i });
  return true;
}

export function canUpgrade(cell) {
  return cell.built && state.level >= cell.level + 1;
}

// ── Production timing (garden + kitchen) ─────────────────────────────────────

export function productionDuration(screen, cell) {
  if (!cell.item) return 0;
  if (screen === "garden") {
    const r = data.resourceById[cell.item];
    return r ? Math.max(1, econ.productionTime(r.gather_time_sec, cell.level)) : 0;
  }
  const recipe = econ.recipeForProduct(cell.item);
  return recipe ? Math.max(1, econ.productionTime(recipe.time_sec, cell.level)) : 0;
}

export function progress(screen, cell) {
  if (cell.stock > 0) return 1;
  if (!cell.startedAt) return 0;
  const dur = productionDuration(screen, cell);
  return Math.min(1, (Date.now() - cell.startedAt) / 1000 / dur);
}

// Move finished production into stock (called lazily before reads/actions).
function settleCell(screen, cell) {
  if (cell.startedAt && cell.stock === 0 && progress(screen, cell) >= 1) {
    if (screen === "garden") {
      const r = data.resourceById[cell.item];
      cell.stock = r ? r.base_yield : 1;
    } else {
      const recipe = econ.recipeForProduct(cell.item);
      cell.stock = recipe ? recipe.output_qty : 1;
    }
    cell.startedAt = 0;
  }
}

export function cellStatus(screen, cell) {
  if (!cell.built) return "locked";
  settleCell(screen, cell);
  if (cell.stock > 0) return "ready";     // (shop: "stocked")
  if (cell.startedAt) return "busy";      // growing / cooking
  return "idle";
}

// ── Garden ───────────────────────────────────────────────────────────────────

export function availableSeeds(cell) {
  // Highest-level seeds first (the newest/best the bed can grow are on top).
  return econ.resourcesForLevel(cell.level).sort((a, b) => b.unlock_level - a.unlock_level);
}

export function plant(i, cropId) {
  const cell = state.garden[i];
  if (!cell.built || cell.item || cell.stock) return false;
  const r = data.resourceById[cropId];
  if (!r || r.unlock_level > cell.level) return false;
  cell.item = cropId;
  cell.startedAt = Date.now();
  cell.stock = 0;
  bumpDaily("plant", { item: cropId, amount: 1 });
  buzz("light");
  changed();
  afterAction("plant", { i, cropId });
  return true;
}

export function collectGarden(i) {
  const cell = state.garden[i];
  settleCell("garden", cell);
  if (cell.stock <= 0) return false;
  const item = cell.item, qty = cell.stock;
  addInventory(item, qty);
  gainXp(econ.xpReward("collect_resource", econ.xpTier(item)));
  resetCell(cell);
  bumpDaily("collectGarden", { item, amount: qty });
  buzz("success");
  changed();
  afterAction("collectGarden", { i });
  return true;
}

// ── Kitchen ──────────────────────────────────────────────────────────────────

export function availableRecipes(cell) {
  // Highest-level dishes first (the newest/best the stove can cook are on top).
  return econ.recipesForLevel(cell.level).sort((a, b) => b.unlock_level - a.unlock_level);
}

export function hasInputs(recipe) {
  return Object.entries(recipe.inputs).every(([id, q]) => (state.inventory[id] || 0) >= q);
}

export function cook(i, recipeId) {
  const cell = state.kitchen[i];
  const recipe = data.recipes.find((r) => r.id === recipeId);
  if (!cell.built || cell.item || cell.stock || !recipe) return false;
  if (recipe.unlock_level > cell.level || !hasInputs(recipe)) return false;
  for (const [id, q] of Object.entries(recipe.inputs)) removeInventory(id, q);
  cell.item = recipe.output;
  cell.startedAt = Date.now();
  cell.stock = 0;
  buzz("light");
  changed();
  afterAction("cook", { i, recipeId });
  return true;
}

export function collectKitchen(i) {
  const cell = state.kitchen[i];
  settleCell("kitchen", cell);
  if (cell.stock <= 0) return false;
  const item = cell.item, qty = cell.stock;
  addInventory(item, qty);
  gainXp(econ.xpReward("cook_product", econ.xpTier(item)));
  resetCell(cell);
  bumpDaily("collectKitchen", { item, amount: qty });
  buzz("success");
  changed();
  afterAction("collectKitchen", { i });
  return true;
}

// ── Shop ─────────────────────────────────────────────────────────────────────

export const MAX_STOCK = 5;

// Sort key shared by the shelf-stocking and inventory lists: dishes (cooked
// products) first, then raw veg; within each group, higher unlock level first.
// `id` → def looked up via itemDef.
function dishThenLevelDesc(aId, bId) {
  const aDish = data.productById[aId] ? 0 : 1;
  const bDish = data.productById[bId] ? 0 : 1;
  if (aDish !== bDish) return aDish - bDish;
  const aLvl = (econ.itemDef(aId) || {}).unlock_level || 0;
  const bLvl = (econ.itemDef(bId) || {}).unlock_level || 0;
  return bLvl - aLvl;
}

// Items you may place on a shelf: anything in inventory that's unlocked for the
// shelf level. Dishes first (by level desc), then veg (by level desc).
export function stockableItems(cell) {
  // A shelf holds one kind at a time, so a partly-sold one only offers a top-up
  // of what is already on it.
  const ids = Object.keys(state.inventory)
    .filter((id) => state.inventory[id] > 0)
    .filter((id) => cell.stock <= 0 || id === cell.item);
  return ids
    .map((id) => {
      const def = econ.itemDef(id);
      return { id, qty: state.inventory[id], unlock: def ? def.unlock_level : 1 };
    })
    .filter((it) => it.unlock <= cell.level)
    .sort((a, b) => dishThenLevelDesc(a.id, b.id));
}

// The shelf level a price should be quoted at: the best built shelf that can
// actually hold this item. The shop modal quotes sellPrice at the shelf tapped,
// so quoting base price (level 1) anywhere else shows two different numbers for
// one item under the same label — a dish is worth base * (1 + 0.15*(level-1)),
// and at shelf level 7 that is nearly double. Falls back to 1 when no built
// shelf is high enough, which is honest: the player cannot sell it yet.
export function priceShelfLevel(itemId) {
  const def = econ.itemDef(itemId);
  if (!def) return 1;
  let best = 0;
  for (const c of state.shop) {
    if (c.built && c.level >= def.unlock_level && c.level > best) best = c.level;
  }
  return best || 1;
}

// Mirrors sim.stockShelf: fills an empty shelf, or tops up one already holding
// the same item. See the note there for why topping up matters.
export function stockShelf(i, itemId) {
  const cell = state.shop[i];
  if (!cell.built) return false;
  if (cell.stock > 0 && cell.item !== itemId) return false; // one kind per shelf
  const room = MAX_STOCK - cell.stock;
  if (room <= 0) return false;
  const def = econ.itemDef(itemId);
  if (!def || def.unlock_level > cell.level) return false;
  const n = Math.min(state.inventory[itemId] || 0, room);
  if (n <= 0) return false;
  removeInventory(itemId, n);
  cell.item = itemId;
  cell.stock += n;
  cell.startedAt = 0;
  bumpDaily("stockShelf", { item: itemId, amount: 1 });
  buzz("medium");
  changed();
  afterAction("stockShelf", { i, itemId });
  return true;
}

export const MAX_QUEUE = 5;

export function queueFull() { return state.queue.length >= MAX_QUEUE; }
export function queueTotal() { return state.queue.reduce((s, c) => s + c.price, 0); }
export function queueLength() { return state.queue.length; }
export function shopHasStock() { return state.shop.some((c) => c.built && c.stock > 0); }

// Indices of shelves that currently hold stock (for the animation to target).
export function stockedShelfIndices() {
  const out = [];
  state.shop.forEach((c, i) => { if (c.built && c.stock > 0 && c.item) out.push(i); });
  return out;
}

// The shelf a customer buying `item` should walk to: prefer one still stocked
// with that exact item, so the walk-in animation matches what they carry (avoids
// the "walks to the wrong shelf" glitch). Returns an index or -1.
export function shelfIndexForItem(item) {
  if (!item) return -1;
  const idx = state.shop.findIndex((c) => c.built && c.item === item && c.stock > 0);
  return idx;
}

// A customer takes one unit from shelf `i` and joins the register queue.
// Returns { item, price } or null if the shelf emptied or the queue is full.
export function pickFromCell(i) {
  if (state.queue.length >= MAX_QUEUE) return null;
  const c = state.shop[i];
  if (!c || !c.built || c.stock <= 0 || !c.item) return null;
  const item = c.item;
  const price = Math.round(econ.sellPrice(item, c.level));
  c.stock -= 1;
  if (c.stock <= 0) c.item = "";
  // `from` + `at` match the shape the server produces (sim.takeFromShelf), so
  // the floor animation reads the same fields in either mode.
  const entry = { item, price, from: i, at: Date.now() };
  state.queue.push(entry);
  changed();
  return entry;
}

// Background spawn (used off the shop screen so customers still arrive): a
// customer takes from a random stocked shelf and joins the queue. Returns bool.
export function autoSpawn() {
  const idx = stockedShelfIndices();
  if (idx.length === 0) return false;
  return pickFromCell(idx[Math.floor(Math.random() * idx.length)]) !== null;
}

// Used by the offline settle (no animation) — takes from a random stocked shelf.
function takeFromShelf() {
  const idx = stockedShelfIndices();
  if (idx.length === 0) return null;
  const from = idx[Math.floor(Math.random() * idx.length)];
  const c = state.shop[from];
  const item = c.item;
  const price = Math.round(econ.sellPrice(item, c.level));
  c.stock -= 1;
  if (c.stock <= 0) c.item = "";
  return { item, price, from, at: Date.now() };
}

// Player taps the register → serve the front customer. Returns coins earned.
export function collectPayment() {
  if (state.queue.length === 0) return 0;
  const c = state.queue.shift();
  state.coins += c.price;
  gainXp(econ.xpReward("npc_sale", econ.xpTier(c.item)));
  bumpDaily("serve", { item: c.item, amount: 1 });
  buzz("success");
  changed();
  afterAction("serve", {});
  return c.price;
}

// ── Inventory / XP ───────────────────────────────────────────────────────────

export function addInventory(id, qty) {
  state.inventory[id] = (state.inventory[id] || 0) + qty;
}
export function removeInventory(id, qty) {
  const have = state.inventory[id] || 0;
  const left = have - qty;
  if (left > 0) state.inventory[id] = left;
  else delete state.inventory[id];
}
export function inventoryList() {
  // Dishes first (by level desc), then seeds/veg (by level desc).
  return Object.keys(state.inventory)
    .filter((id) => state.inventory[id] > 0)
    .map((id) => ({ id, qty: state.inventory[id], def: econ.itemDef(id) }))
    .sort((a, b) => dishThenLevelDesc(a.id, b.id));
}

function resetCell(cell) {
  cell.item = "";
  cell.startedAt = 0;
  cell.stock = 0;
}

export function gainXp(amount) {
  state.xp += amount;
  let need = econ.xpForNextLevel(state.level);
  while (need > 0 && state.xp >= need) {
    state.xp -= need;
    state.level += 1;
    state.gems += (data.economy.gems && data.economy.gems.per_level) || 0; // gems reward
    buzz("success");
    need = econ.xpForNextLevel(state.level);
  }
}

// ── Gems: premium currency + sinks ───────────────────────────────────────────

export function gems() { return state.gems; }
export function premiumCosts() { return data.economy.premium; }
export function hasOfflineX2() { return !!state.boostOfflineX2; }
export function hasAutoRegister() { return !!state.autoRegister; }

// Gem cost to instantly finish a growing/cooking cell (by remaining time).
export function gemSkipCost(screen, cell) {
  if (!cell.startedAt || cell.stock > 0) return 0;
  const dur = productionDuration(screen, cell);
  const remain = Math.max(0, dur - (Date.now() - cell.startedAt) / 1000);
  const per = (data.economy.gems && data.economy.gems.skip_seconds_per_gem) || 45;
  return Math.max(1, Math.ceil(remain / per));
}

export function skipProduction(screen, i) {
  const cell = state[screen][i];
  const cost = gemSkipCost(screen, cell);
  if (cost <= 0 || state.gems < cost) return false;
  state.gems -= cost;
  if (screen === "garden") {
    const r = data.resourceById[cell.item]; cell.stock = r ? r.base_yield : 1;
  } else {
    const rec = econ.recipeForProduct(cell.item); cell.stock = rec ? rec.output_qty : 1;
  }
  cell.startedAt = 0;
  buzz("success");
  changed();
  afterAction("skipProduction", { screen, i });
  return true;
}

export function buyOfflineX2() {
  const c = premiumCosts().offline_x2_cost;
  if (state.boostOfflineX2 || state.gems < c) return false;
  state.gems -= c; state.boostOfflineX2 = true;
  buzz("success"); changed();
  afterAction("buyOfflineX2", {});
  return true;
}

export function buyAutoRegister() {
  const c = premiumCosts().auto_register_cost;
  if (state.autoRegister || state.gems < c) return false;
  state.gems -= c; state.autoRegister = true;
  buzz("success"); changed();
  afterAction("buyAutoRegister", {});
  return true;
}

// ── Rewarded ads (Phase B) ───────────────────────────────────────────────────
// Player-initiated only. A shared hourly cap keeps ads non-spammy; the coin
// bonus additionally has its own cooldown.
//
// Granting rule, shared by all four placements below: a completed view earns the
// reward, and so does being unable to show an ad at all — the player did nothing
// wrong when there is no fill. Only an actual skip earns nothing. See ads.js.
//
// Why handing out free rewards on "unavailable" is safe: every one of these
// still goes through the server's recordAd(), so they consume the same cap of 8
// per hour. However often ads fail, nobody can collect more than a player who
// dutifully watches every video.
function earned(status) { return status === ads.REWARDED || status === ads.UNAVAILABLE; }

function adsConfig() { return data.economy.ads || {}; }

// Prune ad timestamps older than an hour and return how many remain.
function recentAdCount() {
  const cutoff = Date.now() - 3600 * 1000;
  state.adTimes = (state.adTimes || []).filter((t) => t > cutoff);
  return state.adTimes.length;
}
export function adsLeftThisHour() {
  const cap = adsConfig().max_per_hour || 8;
  return Math.max(0, cap - recentAdCount());
}
function recordAd() {
  recentAdCount(); // prune first
  state.adTimes.push(Date.now());
}

// Free-coins ad (shop screen). Amount scales with player level.
export function coinBonusAmount() {
  const a = adsConfig();
  return Math.round((a.coin_bonus_base || 50) + (a.coin_bonus_per_level || 25) * (state.level - 1));
}
export function coinBonusCooldownLeft() {
  const cd = (adsConfig().cooldown_sec || 180) * 1000;
  return Math.max(0, Math.ceil(((state.adBonusAt || 0) + cd - Date.now()) / 1000));
}
export function coinBonusReady() {
  return coinBonusCooldownLeft() === 0 && adsLeftThisHour() > 0;
}

// Watch an ad → free coins. Returns coins earned (0 if not shown/skipped).
export async function watchCoinBonus() {
  if (!coinBonusReady()) return 0;
  const status = await ads.showRewarded("coins");
  if (!earned(status)) return 0;
  if (backend.serverAuth()) {
    const r = await backend.action("adCoins", { adStatus: status });
    if (!r || !r.result || !r.result.ok) return 0;
    reconcile(r.state, r.offlineReport); buzz("success");
    return r.result.earned || 0;
  }
  const amt = coinBonusAmount();
  state.coins += amt;
  state.adBonusAt = Date.now();
  recordAd();
  buzz("success");
  changed();
  return amt;
}

// The ad-to-skip-production and ad-to-double-offline placements were removed:
// the production wait is under a minute (a video costs more time than it saves),
// and the offline payout only exists for auto-register owners after a long
// absence. The server still accepts adSkip/adDouble so a client cached from
// before this change doesn't break; nothing calls them any more.

// ── Daily tasks + weekly streak (Phase D) ────────────────────────────────────
// Client mirror of backend/src/sim.js. Under server-auth the server owns the
// daily state (generation, counting, rewards) and the client just reflects it +
// claims via actions; in legacy/no-backend mode the client runs it all locally.

function dailyCfg() { return (data.economy && data.economy.daily) || null; }

function dayIndex(now) {
  const cfg = dailyCfg();
  const off = ((cfg && cfg.reset_hour_utc) || 0) * 3600e3;
  return Math.floor((now - off) / 86400000);
}

function seededRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function maxBuiltLevel(cells) {
  let m = 0;
  for (const c of cells) if (c.built) m = Math.max(m, c.level);
  return m;
}
function unlockedCrops() {
  const lvl = maxBuiltLevel(state.garden);
  return lvl ? econ.resourcesForLevel(lvl) : [];
}
function unlockedDishes() {
  const lvl = maxBuiltLevel(state.kitchen);
  if (!lvl) return [];
  return econ.recipesForLevel(lvl).map((r) => data.productById[r.output]).filter(Boolean);
}
function upgradableScreens() {
  return ["garden", "kitchen", "shop"].filter((s) => state[s].some((c) => c.built));
}
function instantiateTask(tpl, rng) {
  const t = { id: tpl.id, type: tpl.type, goal: tpl.goal, reward: tpl.reward, progress: 0, claimed: false };
  if (tpl.pick === "crop") {
    const a = unlockedCrops(); if (!a.length) return null;
    t.item = a[Math.floor(rng() * a.length)].id;
  } else if (tpl.pick === "dish") {
    const a = unlockedDishes(); if (!a.length) return null;
    t.item = a[Math.floor(rng() * a.length)].id;
  } else if (tpl.pick === "screen") {
    const a = upgradableScreens(); if (!a.length) return null;
    t.screen = a[Math.floor(rng() * a.length)];
  }
  return t;
}
function genDailyTasks(day) {
  const cfg = dailyCfg();
  if (!cfg || !Array.isArray(cfg.task_pool)) return [];
  const rng = seededRng((day * 2654435761) ^ 0x9e3779b9);
  const tasks = [];
  for (let tier = 1; tier <= 3; tier++) {
    const pool = shuffled(cfg.task_pool.filter((t) => t.tier === tier), rng);
    let inst = null;
    for (const tpl of pool) { inst = instantiateTask(tpl, rng); if (inst) break; }
    if (inst) tasks.push(inst);
  }
  return tasks;
}
function ensureDaily(s) {
  const d = s.daily && typeof s.daily === "object" ? s.daily : (s.daily = {});
  if (!Array.isArray(d.tasks)) d.tasks = [];
  if (typeof d.day !== "number") d.day = -1;
  if (typeof d.streak !== "number") d.streak = 0;
  if (typeof d.streakDay !== "number") d.streakDay = -1;
  if (typeof d.streakFloor !== "number") d.streakFloor = 3;
  if (typeof d.chestDay !== "number") d.chestDay = -1;
  if (typeof d.chestCount !== "number") d.chestCount = 0;
  if (typeof d.chestLastAt !== "number") d.chestLastAt = 0;
  if (typeof d.superDay !== "number") d.superDay = -1;
}
function countDone(d) { return (d.tasks || []).filter((t) => (t.progress || 0) >= t.goal).length; }
// Sequential unlock: task N opens only once tasks 0..N-1 are completed.
function taskUnlockedAt(d, idx) {
  const tasks = (d && d.tasks) || [];
  for (let j = 0; j < idx; j++) if ((tasks[j].progress || 0) < tasks[j].goal) return false;
  return true;
}
export function dailyTaskUnlocked(idx) { return taskUnlockedAt(state.daily, idx); }
function regularChest(cfg, streak) {
  const dr = cfg.day_rewards || [];
  if (!dr.length) return null;
  const s = Math.max(1, streak || 0);
  return dr[Math.min(dr.length - 1, (s - 1) % 7)];
}

// Local rollover — a no-op under server-auth (the server is the authority and its
// state is adopted via reconcile). Only legacy/no-backend mode generates locally.
function rolloverDaily(now) {
  if (backend.serverAuth()) return;
  const cfg = dailyCfg();
  if (!cfg) return;
  const d = state.daily;
  const today = dayIndex(now);
  if (d.day === today) return;
  if (d.day >= 0 && d.streakDay === d.day && d.streak % 7 !== 0) {
    d.streakFloor = Math.min(d.streakFloor, countDone(d));
  }
  d.day = today;
  d.tasks = genDailyTasks(today);
  d.chestCount = 0;
  d.chestLastAt = 0;
}

// Optimistic progress bump for a snappy UI. Under server-auth the reconcile after
// the same action is the authority; the values match so there's no visible jump.
function bumpDaily(type, { item, screen, amount = 1 } = {}) {
  const d = state.daily;
  if (!d || !Array.isArray(d.tasks)) return;
  const unlocked = d.tasks.map((_, i) => taskUnlockedAt(d, i)); // snapshot (see sim.js)
  d.tasks.forEach((t, i) => {
    if (!unlocked[i]) return;
    if (t.type !== type) return;
    if (t.item && t.item !== item) return;
    if (t.screen && t.screen !== screen) return;
    t.progress = Math.min(t.goal, (t.progress || 0) + amount);
  });
  maybeAdvanceStreak();
}

// Streak is task-driven: completing >=1 task advances it once per day (no ad).
function maybeAdvanceStreak() {
  const d = state.daily;
  const today = d.day;
  if (d.streakDay === today) return;
  const cfg = dailyCfg();
  if (countDone(d) < ((cfg && cfg.streak_required_tasks) || 1)) return;
  d.streak = (d.streakDay === today - 1) ? (d.streak || 0) + 1 : 1;
  d.streakDay = today;
  if (d.streak % 7 === 1) d.streakFloor = 3;
}

function dailyCoins(r, level) { return Math.round((r.coins_base || 0) + (r.coins_per_level || 0) * (level - 1)); }
function grantDishesLocal(n) {
  const dishes = unlockedDishes();
  if (dishes.length) {
    const best = dishes.slice().sort((a, b) => (b.base_price || 0) - (a.base_price || 0))[0];
    addInventory(best.id, n); return best.id;
  }
  const crops = unlockedCrops();
  if (crops.length) {
    const best = crops.slice().sort((a, b) => (b.base_sell_price || 0) - (a.base_sell_price || 0))[0];
    addInventory(best.id, n); return best.id;
  }
  return null;
}
// XP scales with level (xp_pct * XP-to-next-level) so rewards stay proportional.
function dailyXp(r, level) {
  if (r.xp_pct) return Math.round(r.xp_pct * econ.xpForNextLevel(level));
  return r.xp || 0;
}
// Returns a summary of what was granted, so the UI can show the exact contents.
function grantDailyRewardLocal(r) {
  if (!r) return null;
  const coins = dailyCoins(r, state.level);
  const xp = dailyXp(r, state.level);
  state.coins += coins;
  if (xp) gainXp(xp);
  if (r.gems) state.gems += r.gems;
  let dishItem = null;
  if (r.dishes) dishItem = grantDishesLocal(r.dishes);
  return { coins, xp, gems: r.gems || 0, dishes: r.dishes || 0, dishItem };
}

// ── Read helpers for the UI ──
export function dailyTasks() { return (state.daily && state.daily.tasks) || []; }
export function dailyTaskDone(t) { return (t.progress || 0) >= t.goal; }
export function dailyStreak() { return (state.daily && state.daily.streak) || 0; }
export function dailyStreakFloor() { return (state.daily && state.daily.streakFloor) != null ? state.daily.streakFloor : 3; }
export function dailyChestCount() { return (state.daily && state.daily.chestCount) || 0; }
export function dailyDoneCount() { return countDone(state.daily); }
// Seconds until the next (repeat) chest is off cooldown; 0 for the first of the day.
export function dailyChestCooldownLeft() {
  const cfg = dailyCfg(); if (!cfg) return 0;
  const d = state.daily;
  if ((d.chestCount || 0) === 0) return 0;
  const cd = (cfg.chest_cooldown_sec || 600) * 1000;
  return Math.max(0, Math.ceil(((d.chestLastAt || 0) + cd - Date.now()) / 1000));
}
// Was the streak already advanced today? (task-driven, no ad needed)
export function dailyStreakDoneToday() {
  return !!state.daily && state.daily.streakDay === dayIndex(Date.now());
}
// Can a chest be claimed right now? Task-independent: just needs an ad view left
// this hour (and the 10-min cooldown for repeats).
export function dailyChestReady() {
  const cfg = dailyCfg(); if (!cfg) return false;
  if (adsLeftThisHour() <= 0) return false;
  if (dailyChestCount() === 0) return true;
  return dailyChestCooldownLeft() === 0;
}
// Is the weekly super sitting in the chest right now? (7th streak day, not taken.)
export function dailyChestIsSuper() {
  const d = state.daily;
  return (d.streak || 0) > 0 && d.streak % 7 === 0 && d.superDay !== dayIndex(Date.now());
}
export function dailyTaskLabel(task) {
  const def = task.item ? econ.itemDef(task.item) : null;
  const scr = task.screen ? t("what_" + task.screen) : "";
  switch (task.type) {
    case "collectGarden": return def ? t("task_collect_garden", { icon: def.icon, name: itemName(def), n: task.goal }) : t("task_collect_garden_any", { n: task.goal });
    case "plant":         return def ? t("task_plant", { icon: def.icon, name: itemName(def), n: task.goal }) : t("task_plant_any", { n: task.goal });
    case "collectKitchen":return def ? t("task_cook", { icon: def.icon, name: itemName(def), n: task.goal }) : t("task_cook_any", { n: task.goal });
    case "serve":         return def ? t("task_serve", { icon: def.icon, name: itemName(def), n: task.goal }) : t("task_serve_any", { n: task.goal });
    case "stockShelf":    return t("task_stock", { n: task.goal });
    case "upgrade":       return t("task_upgrade", { what: scr || t("task_cell") });
    case "build":         return t("task_build", { what: scr || t("task_cell") });
    default:              return t("task_default", { n: task.goal });
  }
}
// Red-dot signal: a completed-but-unclaimed task reward, or the weekly super
// waiting in the chest. (Plain ad-chests are always available, so they don't nag.)
export function dailyHasUnclaimed() {
  const done = dailyTasks().some((t) => dailyTaskDone(t) && !t.claimed);
  return done || dailyChestIsSuper();
}

// ── Claim actions ──
// Returns { reward } on success, or { error: "network" | "refused" }.
//
// It used to return null for both, and the UI turned that into nothing at all:
// no toast, no message, just a rebuilt row with the same claim button. From the
// player's side the button was simply dead, which is exactly the shape of the
// "dailies won't collect" report — and the two causes need different answers.
//
// "refused" also reconciles now. The server saying no means it does not agree
// the task is done, so leaving our own optimistic progress on screen keeps
// offering a reward that will be refused again on the next tap. Adopting its
// state either restores the claim button honestly or shows the real progress.
export async function claimDailyTask(id) {
  rolloverDaily(Date.now());
  if (backend.serverAuth()) {
    const r = await backend.action("claimDailyTask", { taskId: id });
    if (!r) return { error: "network" };
    if (!r.result || !r.result.ok) {
      reconcile(r.state, r.offlineReport, r.profile);
      return { error: "refused" };
    }
    reconcile(r.state, r.offlineReport, r.profile); buzz("success");
    return { reward: r.result.reward || null };
  }
  const t = dailyTasks().find((x) => x.id === id);
  if (!t || t.claimed || !dailyTaskDone(t)) return { error: "refused" };
  t.claimed = true;
  const reward = grantDailyRewardLocal(t.reward);
  t.granted = reward;
  buzz("success"); changed();
  return { reward };
}

// Claim a daily chest — gated by a rewarded ad (block 39476). Plays the ad first;
// on a completed view the chest opens. The first chest of the day advances the
// streak (needs >=1 task); later ones are unlocked by a 10-min cooldown and give a
// regular chest. Returns the chest result, or { error } — see claimDailyTask for
// why a refusal is reported and reconciled instead of silently doing nothing.
// "skipped" is its own case: the player closed the ad early, which is a choice,
// not a failure, and saying "something went wrong" about it would be a lie.
export async function claimDailyChest() {
  rolloverDaily(Date.now());
  if (!dailyChestReady()) return { error: "refused" }; // eligibility before spending an ad view
  // Unlike the others this one also guards the streak, so a missing ad must
  // never be what breaks it.
  const status = await ads.showRewarded("daily_chest");
  if (!earned(status)) return { error: "skipped" };

  if (backend.serverAuth()) {
    // adStatus is analytics only (see backend/src/analytics.js): it separates a
    // real view from a reward granted because no ad could be shown. The reward
    // itself does not depend on it — the server decides that on its own.
    const r = await backend.action("claimDailyChest", { adStatus: status });
    if (!r) return { error: "network" };
    if (!r.result || !r.result.ok) {
      reconcile(r.state, r.offlineReport, r.profile);
      return { error: "refused" };
    }
    reconcile(r.state, r.offlineReport, r.profile); buzz("success");
    return r.result;
  }
  // Local mirror of sim.claimDailyChest (task-independent; super on day 7).
  const cfg = dailyCfg(); if (!cfg) return { error: "refused" };
  const d = state.daily; const now = Date.now(); const today = dayIndex(now);
  const count = d.chestCount || 0;
  recordAd();
  let superTier = 0, reward;
  const isSuperDay = (d.streak || 0) > 0 && d.streak % 7 === 0;
  if (isSuperDay && d.superDay !== today) {
    const done = countDone(d);
    superTier = Math.max(1, Math.min(3, Math.min(d.streakFloor, done)));
    const sr = cfg.super_rewards || []; reward = sr[Math.min(sr.length - 1, superTier - 1)];
    d.superDay = today;
  } else {
    reward = regularChest(cfg, d.streak);
  }
  const granted = grantDailyRewardLocal(reward);
  d.chestCount = count + 1; d.chestLastAt = now;
  d.chestGranted = granted; d.chestSuperTier = superTier;
  buzz("success"); changed();
  return { ok: true, superTier, streak: d.streak, count: d.chestCount, reward: granted };
}

// What the chest gave today (for showing contents after it's claimed), or null.
export function dailyChestGranted() { return (state.daily && state.daily.chestGranted) || null; }
export function dailyChestSuperTier() { return (state.daily && state.daily.chestSuperTier) || 0; }

// ── "Do everything" helpers (one-tap, star-gated in the UI) ──────────────────

// Collect every ready bed, then plant the best available seed on every idle one.
export function doAllGarden() {
  let collected = 0, planted = 0;
  state.garden.forEach((c) => {
    if (!c.built) return;
    settleCell("garden", c);
    if (c.stock > 0) {
      addInventory(c.item, c.stock);
      gainXp(econ.xpReward("collect_resource", econ.xpTier(c.item)));
      resetCell(c); collected++;
    }
  });
  state.garden.forEach((c) => {
    if (!c.built || c.item || c.stock) return;
    const seeds = econ.resourcesForLevel(c.level);
    if (!seeds.length) return;
    const best = seeds.reduce((a, b) => (b.base_sell_price > a.base_sell_price ? b : a));
    c.item = best.id; c.startedAt = Date.now(); planted++;
  });
  if (collected || planted) { changed(); buzz("success"); afterAction("doAllGarden", {}); }
  return { collected, planted };
}

// Collect every ready stove, then cook the priciest affordable recipe on idle ones.
export function doAllKitchen() {
  let collected = 0, cooked = 0;
  state.kitchen.forEach((c) => {
    if (!c.built) return;
    settleCell("kitchen", c);
    if (c.stock > 0) {
      addInventory(c.item, c.stock);
      gainXp(econ.xpReward("cook_product", econ.xpTier(c.item)));
      resetCell(c); collected++;
    }
  });
  state.kitchen.forEach((c) => {
    if (!c.built || c.item || c.stock) return;
    const recipes = econ.recipesForLevel(c.level).filter((r) => hasInputs(r));
    if (!recipes.length) return;
    const best = recipes.reduce((a, b) =>
      (data.productById[b.output].base_price > data.productById[a.output].base_price ? b : a));
    for (const [id, q] of Object.entries(best.inputs)) removeInventory(id, q);
    c.item = best.output; c.startedAt = Date.now(); cooked++;
  });
  if (collected || cooked) { changed(); buzz("success"); afterAction("doAllKitchen", {}); }
  return { collected, cooked };
}

// Stock every empty shelf with the most valuable eligible item you own, then
// clear the whole register queue (do-all is the paid one-tap convenience).
export function doAllShop() {
  let stocked = 0;
  state.shop.forEach((c) => {
    if (!c.built || c.item || c.stock) return;
    const items = Object.keys(state.inventory)
      .filter((id) => state.inventory[id] > 0)
      .map((id) => ({ id, def: econ.itemDef(id) }))
      .filter((o) => o.def && o.def.unlock_level <= c.level);
    if (!items.length) return;
    const best = items.reduce((a, b) =>
      (econ.sellPrice(b.id, c.level) > econ.sellPrice(a.id, c.level) ? b : a));
    const n = Math.min(state.inventory[best.id], MAX_STOCK);
    removeInventory(best.id, n);
    c.item = best.id; c.stock = n; stocked++;
  });
  // Serve everyone waiting at the register in one go.
  let served = 0, earned = 0;
  while (state.queue.length) {
    const c = state.queue.shift();
    state.coins += c.price;
    earned += c.price;
    gainXp(econ.xpReward("npc_sale", econ.xpTier(c.item)));
    served++;
  }
  if (stocked || served) { changed(); buzz("success"); afterAction("doAllShop", {}); }
  return { stocked, served, earned };
}

export function clearOfflineReport() { offlineReport = null; }

export function isNewPlayer() { return !state.tutorialDone; }
export function completeTutorial() { state.tutorialDone = true; save(); afterAction("completeTutorial", {}); }
// Clear the tutorial flag so the onboarding coach can be replayed. Persisted
// server-side too (afterAction) — otherwise the next reconcile would restore it.
export function resetTutorial() { state.tutorialDone = false; changed(); afterAction("resetTutorial", {}); }

// Wipe the player's account everywhere. Clearing local storage alone used to be
// a no-op under server-auth: the reload re-authenticated with the same
// credential and pulled the very same state back. So the server account goes
// first, and we only clear locally if that actually succeeded.
//
// It used to end in location.reload(), and that was the same mistake one step
// later: the fresh page authenticates with the very same credential, and the
// server creates a brand-new account for it within a second — leaderboard row,
// new generated name and all. So a delete now ENDS the session instead: no
// reload, no timers, no network. The caller closes the app (Telegram) or leaves
// a dead-end screen (iOS/web); the account comes back only when the player
// chooses to open the game again, and then it is genuinely a new one.
//
// Returns false when the server was reachable-but-refused (or offline), so the
// UI can say so instead of pretending the reset happened.
let deleted = false;
export async function resetProgress() {
  if (backend.enabled() && !(await backend.deleteAccount())) return false;
  deleted = true;
  backend.markDeleted(); // no request may re-create what we just deleted
  stopServerPoll();
  tg.clearState();
  return true;
}
