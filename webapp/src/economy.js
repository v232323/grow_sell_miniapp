// Economy formulas — a faithful port of the pure functions in
// scripts/autoload/economy_manager.gd. Kept in sync with the shared economy.json.

import { data } from "./data.js";

export function sellPrice(itemId, cellLevel = 1) {
  const product = data.productById[itemId];
  if (product) {
    const bonus = data.economy.bonuses.sell_price_per_level;
    return product.base_price * (1 + bonus * (cellLevel - 1));
  }
  const resource = data.resourceById[itemId];
  if (resource) return resource.base_sell_price; // raw ingredients: no level bonus
  return 0;
}

export function productionTime(baseTime, cellLevel = 1) {
  const bonus = data.economy.bonuses.speed_per_level;
  return baseTime * (1 - bonus * (cellLevel - 1));
}

export function buildCost(cellIndex) {
  const b = data.economy.build;
  return b.base_cost * Math.pow(b.cost_multiplier, cellIndex);
}

export function upgradeCost(currentLevel) {
  const u = data.economy.upgrade;
  return u.base_cost * Math.pow(u.cost_multiplier, currentLevel - 1);
}

// XP needed to advance from `level` to `level+1` (0 = already max).
export function xpForNextLevel(level) {
  const t = data.economy.xp.thresholds;
  const idx = level - 1;
  return idx >= 0 && idx < t.length ? t[idx] : 0;
}

export function xpReward(kind) {
  return data.economy.xp.rewards[kind] || 0;
}

export function resourcesForLevel(level) {
  return data.resources.filter((r) => r.unlock_level <= level);
}

export function recipesForLevel(level) {
  return data.recipes.filter((r) => r.unlock_level <= level);
}

export function productsForLevel(level) {
  return data.products.filter((p) => p.unlock_level <= level);
}

export function recipeForProduct(productId) {
  return data.recipes.find((r) => r.output === productId) || null;
}

// What a cell of `screen` unlocks the moment it reaches `level`: new seeds
// (garden), dishes (kitchen), or sellable goods (shop = raw + cooked).
export function unlocksAtLevel(screen, level) {
  if (screen === "garden") return data.resources.filter((r) => r.unlock_level === level);
  if (screen === "kitchen") return data.products.filter((p) => p.unlock_level === level);
  return [...data.resources, ...data.products].filter((it) => it.unlock_level === level);
}

// Seconds between customer purchases — faster as the shop's average shelf level
// rises. Mirrors economy_manager.get_npc_spawn_interval().
export function npcSpawnInterval(shopCells) {
  const n = data.economy.npc;
  let avg = 0, built = 0;
  for (const c of shopCells) {
    if (c.built) { avg += c.level; built++; }
  }
  if (built > 0) avg /= built;
  return Math.max(n.min_spawn_interval, n.base_spawn_interval - n.spawn_level_reduction * avg);
}

// A resource or product definition by id (for icons/names), regardless of type.
export function itemDef(id) {
  return data.resourceById[id] || data.productById[id] || null;
}
