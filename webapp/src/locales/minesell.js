// Mine Sell's strings: only the keys that differ from the base dictionaries
// (ru.js / en.js). i18n.js looks here first when the profile is Mine Sell, then
// falls back to the base text — so anything not about the garden, the kitchen
// or vegetables is shared with Grow Sell and needs no copy here.
//
// Screen ids stay garden/kitchen/shop (see profile.js), which is why the keys
// still say "garden": in Mine Sell that screen is the mine.
//
// The emoji in these strings are deliberate: in Mine Sell art.js swaps them for
// the game's own pictures (🌱 → the mine tab icon, 🍳 → the forge tab icon),
// and they stay readable as plain emoji until those pictures exist.

export const ru = {
  app_title: "Mine Sell",
  tab_garden: "Шахта",
  tab_kitchen: "Кузница",

  doall_garden: "Забрать и копать",
  doall_kitchen: "Забрать и ковать",
  doall_planted: "в добыче",
  doall_cooked: "куётся",

  cell_plant: "Копать",
  cell_cook: "Ковать",
  what_garden: "шахту",
  what_kitchen: "горн",

  seed_title: "🌱 Что добывать (Ур.{n})",
  recipe_title: "🍳 Что выковать (Ур.{n})",
  act_plant: "Копать",
  act_cook: "Ковать",
  lock_no_ingredients: "нет\nсырья",
  empty_no_recipes: "Нет чертежей",
  recipe_prefix: "Чертёж: {name}",

  unlock_garden: "🌱 Откроется сырьё:",
  unlock_kitchen: "🍳 Откроются изделия:",

  bag_empty: "Склад пуст. Добудь руду и выкуй первые изделия.",
  gems_speed_hint: "Ускорить добычу или ковку можно за 💎 прямо в клетке ⚡",

  name_role_gardener: "Шахтёр {n}",
  name_role_cook: "Кузнец {n}",
  name_role_seller: "Торговец {n}",

  task_collect_garden: "Добудь {icon} {name} ×{n}",
  task_collect_garden_any: "Добудь сырьё ×{n}",
  task_plant: "Начни добычу {icon} {name} ×{n}",
  task_plant_any: "Начни добычу ×{n}",
  task_cook: "Выкуй {icon} {name} ×{n}",
  task_cook_any: "Выкуй изделия ×{n}",

  coach_1: "Тапни шахту и начни добывать первую руду 🌱",
  coach_2: "Руда добывается. Когда будет готово ✓ — тапни шахту ещё раз, добыча уйдёт на склад.",
  coach_3: "Отлично! Теперь загляни в Кузницу 🍳",
  coach_4: "Чтобы ковать изделия, нужен горн — построй его за монеты. Пока денег мало? Продавай руду в Лавке и накопи на первый горн.",
  coach_6: "Тапни полку и выложи на неё руду на продажу.",
  coach_8: "Загляни на склад 🎒 — тут лежит вся твоя руда и изделия.",
  coach_9: "Шахту, горн и полку можно улучшать ⬆ — это открывает предметы выше уровнем. Для улучшения нужен твой уровень игрока. Удачи! 🎉",

  wild_head: "Россыпь",
  wild_sub: "Пока тебя не было, порода в забоях осыпалась сама — руду осталось только собрать.",
  wild_window: "Шахты добывали руду {h} ч.",
};

export const en = {
  app_title: "Mine Sell",
  tab_garden: "Mine",
  tab_kitchen: "Forge",

  doall_garden: "Collect & dig",
  doall_kitchen: "Collect & forge",
  doall_planted: "digging",
  doall_cooked: "forging",

  cell_plant: "Dig",
  cell_cook: "Forge",
  what_garden: "a mine",
  what_kitchen: "a forge",

  seed_title: "🌱 What to mine (Lv.{n})",
  recipe_title: "🍳 What to forge (Lv.{n})",
  act_plant: "Dig",
  act_cook: "Forge",
  lock_no_ingredients: "no\nore",
  empty_no_recipes: "No blueprints",
  recipe_prefix: "Blueprint: {name}",

  unlock_garden: "🌱 New ore:",
  unlock_kitchen: "🍳 New items:",

  bag_empty: "The warehouse is empty. Mine some ore and forge your first items.",
  gems_speed_hint: "Speed up mining or forging for 💎 right in the cell ⚡",

  name_role_gardener: "Miner {n}",
  name_role_cook: "Smith {n}",
  name_role_seller: "Trader {n}",

  task_collect_garden: "Mine {icon} {name} ×{n}",
  task_collect_garden_any: "Mine ore ×{n}",
  task_plant: "Start mining {icon} {name} ×{n}",
  task_plant_any: "Start mining ×{n}",
  task_cook: "Forge {icon} {name} ×{n}",
  task_cook_any: "Forge items ×{n}",

  coach_1: "Tap the mine and start digging your first ore 🌱",
  coach_2: "The ore is being mined. When it's ready ✓ — tap the mine again and it goes to the warehouse.",
  coach_3: "Great! Now head to the Forge 🍳",
  coach_4: "To forge items you need a forge — build one for coins. Short on money? Sell ore in the Shop and save up for your first forge.",
  coach_6: "Tap a shelf and put some ore up for sale.",
  coach_8: "Check the warehouse 🎒 — all your ore and items are here.",
  coach_9: "Mines, forges and shelves can be upgraded ⬆ — that unlocks higher-level items. Upgrades need your player level. Good luck! 🎉",

  wild_head: "Rockfall",
  wild_sub: "While you were away, loose rock in the mines fell by itself — the ore just needs collecting.",
  wild_window: "The mines kept digging for {h} h.",
};
