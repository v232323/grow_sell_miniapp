// Game state + rules — a faithful web port of the Godot game's cell model
// (scripts/cells/*, game_manager.gd, player_save.gd). 12 cells per screen;
// build/upgrade with coins; level-gated planting/cooking/stocking; customers
// buy from shop shelves. Wall-clock timestamps drive offline progress.

import { data } from "./data.js";
import * as econ from "./economy.js";
import * as tg from "./telegram.js";
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
export const profile = { displayName: null, nameCustom: false, nameSeen: false, loaded: false };
function applyProfile(p) { if (p) Object.assign(profile, p, { loaded: true }); }
// Update the local mirror after a rename / intro-ack (server already persisted it).
export function setLocalName(name, seen = true) {
  if (name) { profile.displayName = name; profile.nameCustom = true; }
  if (seen) profile.nameSeen = true;
}

let onChange = () => {};
export function subscribe(fn) { onChange = fn; }
function changed() { save(); onChange(); watchLevel(); }

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
function reconcile(serverState, report, prof) {
  applyProfile(prof);
  if (!serverState) return;
  migrate(serverState);
  Object.assign(state, serverState);
  if (report) offlineReport = report;
  onChange();
  watchLevel();
}

// Send a locally-applied mutation to the server and reconcile to the result.
// No-op unless server-auth is on. Failures keep the optimistic local state.
function afterAction(type, args) {
  if (!backend.serverAuth()) return;
  backend.action(type, args).then((r) => { if (r) reconcile(r.state, r.offlineReport, r.profile); });
}

// Poll the server so it advances production/customers and we reconcile, even
// when the player is idle (replaces the /api/sync push cadence in server-auth).
let pollTimer = null;
let lastTouchAt = 0;
async function touchSync() {
  lastTouchAt = Date.now();
  const r = await backend.action("touch", {});
  if (r) reconcile(r.state, r.offlineReport, r.profile);
}
function startServerPoll() {
  if (pollTimer || !backend.serverAuth()) return;
  pollTimer = setInterval(touchSync, 10000);
}

// On-demand reconcile, throttled — used while the shop screen is open so newly
// spawned customers show up promptly instead of waiting on the 10s poll.
export function pokeSync(minGapMs = 3000) {
  if (!backend.serverAuth()) return;
  if (Date.now() - lastTouchAt < minGapMs) return;
  touchSync();
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

export async function load() {
  let saved = await tg.loadState();

  // Server-authoritative: the canonical state lives on the server. Pull it (the
  // server also runs offline settle via advance()), adopt it, and start polling.
  // If the server is unreachable, fall through to the local path so the game
  // still opens.
  if (backend.serverAuth()) {
    const r = await backend.action("touch", {});
    if (r && r.state) {
      migrate(r.state);
      Object.assign(state, r.state);
      offlineReport = r.offlineReport || null;
      applyProfile(r.profile);
      resetLevelWatch();
      startServerPoll();
      return;
    }
  }

  // Legacy (Phase 1): the backend stores the client save; adopt what it returns
  // (referral / purchase gems folded in once, entitlements enforced). No-op /
  // falls back to local when the URL is empty or we're outside Telegram.
  const remote = await backend.sync(saved || null);
  if (remote && remote.save && typeof remote.save === "object") saved = remote.save;

  if (saved && typeof saved === "object") {
    migrate(saved);
    Object.assign(state, saved);
  } else {
    state.gems = (data.economy.gems && data.economy.gems.start) || 0; // starter gems
  }
  settleOffline();
  rolloverDaily(Date.now()); // local/legacy mode owns the daily rollover (no-op under server-auth)
  resetLevelWatch();
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
  state.lastSeen = Date.now();
  tg.saveState(state);
  backend.queuePush(() => state); // throttled background push to the authoritative store
}

// Apply time passed while away: production finishes via timestamps already;
// customers who queued (or would have) are auto-served for the elapsed time.
function settleOffline() {
  const now = Date.now();
  const elapsed = Math.max(0, (now - (state.lastSeen || now)) / 1000);
  offlineReport = null;
  // Quick reopen: leave the waiting queue intact so the player taps the register.
  if (elapsed < 30) return;

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
      gainXp(econ.xpReward("npc_sale")); sold++;
    }
    while (budget-- > 0) {
      const t = takeFromShelf();
      if (!t) break; // shelves empty
      const g = t.price * factor;
      earned += g; state.coins += g;
      gainXp(econ.xpReward("npc_sale")); sold++;
    }
    if (sold > 0) offlineReport = { earned, sold, x2: factor === 2 };
  } else {
    // Default: customers who arrived while away only LINE UP (up to MAX_QUEUE)
    // — collecting their money at the register is the player's job.
    while (budget-- > 0 && state.queue.length < MAX_QUEUE) {
      const t = takeFromShelf();
      if (!t) break;
      state.queue.push(t); queued++;
    }
    if (queued > 0) offlineReport = { queued };
  }
  state.lastSeen = now;
  // Persist immediately: shelves were decremented and the queue changed —
  // losing this on an early exit would lose the taken stock.
  if (sold > 0 || queued > 0) save();
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
  tg.haptic("success");
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
  gainXp(econ.xpReward("upgrade_cell"));
  bumpDaily("upgrade", { screen, amount: 1 });
  tg.haptic("success");
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
  tg.haptic("light");
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
  gainXp(econ.xpReward("collect_resource") * qty);
  resetCell(cell);
  bumpDaily("collectGarden", { item, amount: qty });
  tg.haptic("success");
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
  tg.haptic("light");
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
  gainXp(econ.xpReward("cook_product"));
  resetCell(cell);
  bumpDaily("collectKitchen", { item, amount: qty });
  tg.haptic("success");
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
  const ids = Object.keys(state.inventory).filter((id) => state.inventory[id] > 0);
  return ids
    .map((id) => {
      const def = econ.itemDef(id);
      return { id, qty: state.inventory[id], unlock: def ? def.unlock_level : 1 };
    })
    .filter((it) => it.unlock <= cell.level)
    .sort((a, b) => dishThenLevelDesc(a.id, b.id));
}

export function stockShelf(i, itemId) {
  const cell = state.shop[i];
  if (!cell.built || cell.stock > 0) return false; // never overwrite a stocked shelf
  const def = econ.itemDef(itemId);
  if (!def || def.unlock_level > cell.level) return false;
  const n = Math.min(state.inventory[itemId] || 0, MAX_STOCK);
  if (n <= 0) return false;
  removeInventory(itemId, n);
  cell.item = itemId;
  cell.stock = n;
  cell.startedAt = 0;
  bumpDaily("stockShelf", { item: itemId, amount: 1 });
  tg.haptic("medium");
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
  state.queue.push({ item, price });
  changed();
  return { item, price };
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
  const c = state.shop[idx[Math.floor(Math.random() * idx.length)]];
  const item = c.item;
  const price = Math.round(econ.sellPrice(item, c.level));
  c.stock -= 1;
  if (c.stock <= 0) c.item = "";
  return { item, price };
}

// Player taps the register → serve the front customer. Returns coins earned.
export function collectPayment() {
  if (state.queue.length === 0) return 0;
  const c = state.queue.shift();
  state.coins += c.price;
  gainXp(econ.xpReward("npc_sale"));
  bumpDaily("serve", { item: c.item, amount: 1 });
  tg.haptic("success");
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
    tg.haptic("success");
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
  tg.haptic("success");
  changed();
  afterAction("skipProduction", { screen, i });
  return true;
}

export function buyOfflineX2() {
  const c = premiumCosts().offline_x2_cost;
  if (state.boostOfflineX2 || state.gems < c) return false;
  state.gems -= c; state.boostOfflineX2 = true;
  tg.haptic("success"); changed();
  afterAction("buyOfflineX2", {});
  return true;
}

export function buyAutoRegister() {
  const c = premiumCosts().auto_register_cost;
  if (state.autoRegister || state.gems < c) return false;
  state.gems -= c; state.autoRegister = true;
  tg.haptic("success"); changed();
  afterAction("buyAutoRegister", {});
  return true;
}

// ── Rewarded ads (Phase B) ───────────────────────────────────────────────────
// Player-initiated only. A shared hourly cap keeps ads non-spammy; the coin
// bonus additionally has its own cooldown. Rewards are granted only after
// ads.showRewarded() confirms a completed view.

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
  const ok = await ads.showRewarded("coins");
  if (!ok) return 0;
  if (backend.serverAuth()) {
    const r = await backend.action("adCoins", {});
    if (!r || !r.result || !r.result.ok) return 0;
    reconcile(r.state, r.offlineReport); tg.haptic("success");
    return r.result.earned || 0;
  }
  const amt = coinBonusAmount();
  state.coins += amt;
  state.adBonusAt = Date.now();
  recordAd();
  tg.haptic("success");
  changed();
  return amt;
}

// Watch an ad to instantly finish a growing/cooking cell (free alt to gems).
export async function watchToSkip(screen, i) {
  const cell = state[screen][i];
  if (!cell || !cell.startedAt || cell.stock > 0) return false;
  if (adsLeftThisHour() <= 0) return false;
  const ok = await ads.showRewarded("skip");
  if (!ok) return false;
  if (backend.serverAuth()) {
    const r = await backend.action("adSkip", { screen, i });
    if (!r || !r.result || !r.result.ok) return false;
    reconcile(r.state, r.offlineReport); tg.haptic("success");
    return true;
  }
  if (screen === "garden") {
    const r = data.resourceById[cell.item]; cell.stock = r ? r.base_yield : 1;
  } else {
    const rec = econ.recipeForProduct(cell.item); cell.stock = rec ? rec.output_qty : 1;
  }
  cell.startedAt = 0;
  recordAd();
  tg.haptic("success");
  changed();
  return true;
}

// Watch an ad to double an offline payout. Returns true if the bonus was added.
export async function watchToDouble(amount) {
  if (!(amount > 0) || adsLeftThisHour() <= 0) return false;
  const ok = await ads.showRewarded("offline");
  if (!ok) return false;
  if (backend.serverAuth()) {
    // Server doubles its own remembered offline payout — client `amount` is ignored.
    const r = await backend.action("adDouble", {});
    if (!r || !r.result || !r.result.ok) return false;
    reconcile(r.state, r.offlineReport); tg.haptic("success");
    return true;
  }
  state.coins += Math.round(amount); // the same amount again = ×2 total
  recordAd();
  tg.haptic("success");
  changed();
  return true;
}

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
export function dailyTaskLabel(t) {
  const def = t.item ? econ.itemDef(t.item) : null;
  const scr = { garden: "грядку", kitchen: "плиту", shop: "лавку" }[t.screen];
  switch (t.type) {
    case "collectGarden": return def ? `Собери ${def.icon} ${def.name} ×${t.goal}` : `Собери урожай ×${t.goal}`;
    case "plant":         return def ? `Посади ${def.icon} ${def.name} ×${t.goal}` : `Посади культуры ×${t.goal}`;
    case "collectKitchen":return def ? `Приготовь ${def.icon} ${def.name} ×${t.goal}` : `Приготовь блюда ×${t.goal}`;
    case "serve":         return def ? `Продай ${def.icon} ${def.name} ×${t.goal}` : `Обслужи покупателей ×${t.goal}`;
    case "stockShelf":    return `Выложи товар на полки ×${t.goal}`;
    case "upgrade":       return `Улучши ${scr || "ячейку"}`;
    case "build":         return `Построй ${scr || "ячейку"}`;
    default:              return `Задание ×${t.goal}`;
  }
}
// Red-dot signal: a completed-but-unclaimed task reward, or the weekly super
// waiting in the chest. (Plain ad-chests are always available, so they don't nag.)
export function dailyHasUnclaimed() {
  const done = dailyTasks().some((t) => dailyTaskDone(t) && !t.claimed);
  return done || dailyChestIsSuper();
}

// ── Claim actions ──
// Returns the granted-reward summary { coins, xp, gems, dishes, dishItem } or null.
export async function claimDailyTask(id) {
  rolloverDaily(Date.now());
  if (backend.serverAuth()) {
    const r = await backend.action("claimDailyTask", { taskId: id });
    if (!r || !r.result || !r.result.ok) return null;
    reconcile(r.state, r.offlineReport, r.profile); tg.haptic("success");
    return r.result.reward || null;
  }
  const t = dailyTasks().find((x) => x.id === id);
  if (!t || t.claimed || !dailyTaskDone(t)) return null;
  t.claimed = true;
  const reward = grantDailyRewardLocal(t.reward);
  t.granted = reward;
  tg.haptic("success"); changed();
  return reward;
}

// Claim a daily chest — gated by a rewarded ad (block 39476). Plays the ad first;
// on a completed view the chest opens. The first chest of the day advances the
// streak (needs >=1 task); later ones are unlocked by a 10-min cooldown and give a
// regular chest. Returns { ok, superTier, streak, count, reward } or null.
export async function claimDailyChest() {
  rolloverDaily(Date.now());
  if (!dailyChestReady()) return null; // eligibility before spending an ad view
  const ok = await ads.showRewarded("daily_chest", ads.DAILY_CHEST_BLOCK_ID);
  if (!ok) return null; // ad skipped / no fill → no chest

  if (backend.serverAuth()) {
    const r = await backend.action("claimDailyChest", {});
    if (!r || !r.result || !r.result.ok) return null;
    reconcile(r.state, r.offlineReport, r.profile); tg.haptic("success");
    return r.result;
  }
  // Local mirror of sim.claimDailyChest (task-independent; super on day 7).
  const cfg = dailyCfg(); if (!cfg) return null;
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
  tg.haptic("success"); changed();
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
      gainXp(econ.xpReward("collect_resource") * c.stock);
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
  if (collected || planted) { changed(); tg.haptic("success"); afterAction("doAllGarden", {}); }
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
      gainXp(econ.xpReward("cook_product"));
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
  if (collected || cooked) { changed(); tg.haptic("success"); afterAction("doAllKitchen", {}); }
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
    gainXp(econ.xpReward("npc_sale"));
    served++;
  }
  if (stocked || served) { changed(); tg.haptic("success"); afterAction("doAllShop", {}); }
  return { stocked, served, earned };
}

export function clearOfflineReport() { offlineReport = null; }

export function isNewPlayer() { return !state.tutorialDone; }
export function completeTutorial() { state.tutorialDone = true; save(); afterAction("completeTutorial", {}); }
// Clear the tutorial flag so the onboarding coach can be replayed. Persisted
// server-side too (afterAction) — otherwise the next reconcile would restore it.
export function resetTutorial() { state.tutorialDone = false; changed(); afterAction("resetTutorial", {}); }

// Full reset (dev/testing): wipe the save and restart from scratch.
export function resetProgress() {
  tg.clearState();
  location.reload();
}
