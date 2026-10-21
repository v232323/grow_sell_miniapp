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

// Ускорение производства за уровень клетки — МУЛЬТИПЛИКАТИВНОЕ, а не линейное.
// Линейное (baseTime * (1 - bonus*(level-1))) при bonus=0.10 обращалось в ноль
// ровно на 11-м уровне и уходило в минус выше, а вызывающая сторона обрезала
// результат до Math.max(1, ...). То есть ЛЮБАЯ клетка 11-го уровня и выше
// производила что угодно за одну секунду, и все gather_time_sec / time_sec у
// контента 11-30 уровней были чистой декорацией.
//
// Степень приближается к нулю, но никогда его не пересекает: на 30-м уровне
// множитель ~0.042, то есть самая долгая культура (156 с) растёт около 6.6 с —
// быстро, но всё ещё осмысленно. Обрезание до секунды остаётся нижней границей
// здравого смысла, а не рабочим режимом.
export function productionTime(baseTime, cellLevel = 1) {
  const bonus = data.economy.bonuses.speed_per_level;
  return baseTime * Math.pow(1 - bonus, Math.max(0, cellLevel - 1));
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

// XP for one action. With `scale_by_tier` the reward is multiplied by the tier of
// the item involved (its unlock_level), so harvesting a carrot no longer levels
// you like harvesting a golden lotus. Without it, XP is flat and the fastest way
// to level is to spam the cheapest crop — which detaches progression from the
// content entirely and is why the level cap used to be reached in the same time
// no matter how the economy was tuned.
export function xpReward(kind, tier = 1) {
  const base = data.economy.xp.rewards[kind] || 0;
  if (!data.economy.xp.scale_by_tier) return base;
  return base * Math.max(1, Math.floor(tier) || 1);
}

// Tier of an item id (resource or product), for the call above.
export function xpTier(itemId) {
  const def = itemDef(itemId);
  return def ? def.unlock_level : 1;
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
