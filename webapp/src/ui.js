// Rendering + interaction. Plain DOM, no framework. Three screens share a 12-cell
// grid; selection/upgrade use modal overlays. A ticker updates progress bars and
// drives customer purchases in the shop.

import { data } from "./data.js";
import * as econ from "./economy.js";
import { state } from "./game.js";
import * as game from "./game.js";
import * as shopfloor from "./shopfloor.js";
import * as backend from "./backend.js";
import * as stars from "./stars.js";
import * as tgApi from "./telegram.js";
import * as coach from "./coach.js";

let active = "garden";

const SCREENS = {
  garden: { note: "Сажай культуры. Уровень грядки открывает новые семена." },
  kitchen: { note: "Готовь блюда из собранных ингредиентов." },
  shop: { note: "Выкладывай товар на полки — покупатели купят его." },
};

export function setScreen(name) {
  if (active === "shop" && name !== "shop") shopfloor.leave();
  active = name;
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("is-active", t.dataset.screen === name));
  coach.onScreen(name);
  render();
  if (name === "shop") shopfloor.enter();
}

export function render() {
  renderHud();
  const el = document.getElementById("screen");
  el.classList.toggle("shop-mode", active === "shop"); // fixed floor, no scroll
  const frag = document.createDocumentFragment();
  frag.appendChild(screenHead(active));
  if (active === "shop") frag.appendChild(shopScreen());
  else frag.appendChild(grid(active));
  el.replaceChildren(frag);
  coach.refresh(); // re-place onboarding marks against the freshly built DOM
}

function renderHud() {
  document.getElementById("coins").textContent = fmt(state.coins);
  document.getElementById("gems").textContent = game.gems();
  document.getElementById("level").textContent = state.level;
  const need = econ.xpForNextLevel(state.level);
  const xpText = document.getElementById("xp-text");
  const fill = document.getElementById("xp-fill");
  if (need > 0) {
    xpText.textContent = `${Math.floor(state.xp)} / ${need} XP`;
    fill.style.width = `${Math.min(100, (state.xp / need) * 100)}%`;
  } else {
    xpText.textContent = "MAX"; fill.style.width = "100%";
  }
  const dot = document.getElementById("daily-dot");
  if (dot) dot.hidden = !game.dailyHasUnclaimed();
}

// ── Screen header: hint + one-tap "do all" (star-gated) ──────────────────────

const DO_ALL_LABEL = { garden: "Собрать и посадить", kitchen: "Собрать и готовить", shop: "Рассчитать и выложить" };

function screenHead(screen) {
  const head = div("screen-head");
  const note = document.createElement("p");
  note.className = "screen-note";
  note.textContent = SCREENS[screen].note;
  head.appendChild(note);

  const btn = document.createElement("button");
  btn.className = "doall-btn";
  btn.innerHTML = `<span class="da-lbl">✨ ${DO_ALL_LABEL[screen]}</span>` +
    `<span class="da-star">⭐${stars.starCost("do_all")}</span>`;
  // Straight to the Stars purchase — Telegram's native payment sheet is the
  // confirmation, so no extra custom confirm/undo gate is needed.
  btn.onclick = () => stars.purchase("do_all", () => onDoAllPaid(screen), { screen });
  head.appendChild(btn);
  return head;
}

// Called after a confirmed Stars payment for do-all.
function onDoAllPaid(screen) {
  if (backend.serverAuth()) {
    // Server-authoritative: the payment webhook already ran the do-all on the
    // canonical state (it's not triggerable from the client). Just pull it.
    toast("Оплачено ✨");
    game.reconcilePaidDoAll();
    return;
  }
  // Legacy / dev (no backend): run the do-all locally.
  let parts = [];
  if (screen === "garden") { const r = game.doAllGarden(); parts = [[r.collected, "собрано"], [r.planted, "посажено"]]; }
  else if (screen === "kitchen") { const r = game.doAllKitchen(); parts = [[r.collected, "собрано"], [r.cooked, "готовится"]]; }
  else {
    const r = game.doAllShop();
    parts = [[r.stocked, "выложено"], [r.served, "обслужено"]];
    shopfloor.syncToQueue(); // animate the served customers out of the floor
  }
  const msg = parts.filter(([n]) => n > 0).map(([n, w]) => `${w} ${n}`).join(", ");
  toast(msg || "Нечего делать");
}

// ── Grid + cells ─────────────────────────────────────────────────────────────

function grid(screen) {
  const g = div("grid grid-" + screen); // themed cell backgrounds per screen
  state[screen].forEach((cell, i) => g.appendChild(cellEl(screen, cell, i)));
  return g;
}

function cellEl(screen, cell, i) {
  const status = game.cellStatus(screen, cell);
  const el = div("cell cell-" + status);

  if (status === "locked") {
    const cost = econ.buildCost(i);
    const afford = state.coins >= cost;
    el.classList.toggle("cant", !afford);
    el.innerHTML = `<span class="lock-ic">🔒</span>
      <span class="lock-build">Построить</span>
      <span class="lock-cost">${fmt(Math.round(cost))} 🪙</span>`;
    // Confirm before building so a stray tap can't spend coins by accident.
    el.onclick = () => {
      if (state.coins < cost) { bump(el); return; }
      const what = { garden: "грядку", kitchen: "плиту", shop: "лавку" }[screen];
      tgApi.confirmDialog(`Построить ${what} за ${fmt(Math.round(cost))} 🪙?`, () => {
        if (game.build(screen, i)) render();
      });
    };
    return el;
  }

  // level chip (tap to upgrade) for built cells
  const chip = div("lvl-chip");
  chip.textContent = "Ур." + cell.level;
  if (game.canUpgrade(cell)) chip.classList.add("upgradable");
  chip.onclick = (e) => { e.stopPropagation(); upgradeModal(screen, i); };
  el.appendChild(chip);

  if (screen === "shop") fillShopCell(el, cell, i, status);
  else fillProdCell(el, screen, cell, i, status);
  return el;
}

// garden + kitchen cell body
function fillProdCell(el, screen, cell, i, status) {
  const body = div("cell-body");
  if (status === "idle") {
    const ic = screen === "garden" ? "🌱" : "🍳";
    body.innerHTML = `<span class="cell-plus">＋</span>
      <span class="cell-action">${screen === "garden" ? "Посадить" : "Готовить"}</span>`;
    el.onclick = () => (screen === "garden" ? seedModal(i) : recipeModal(i));
  } else if (status === "busy") {
    const def = econ.itemDef(cell.item);
    const p = Math.floor(game.progress(screen, cell) * 100);
    body.innerHTML = `<span class="cell-ic">${def.icon}</span>
      <span class="cell-name">${def.name}</span>
      <div class="cell-bar"><div class="cell-fill" style="width:${p}%"></div></div>`;
    const skip = document.createElement("button");
    skip.className = "skip-btn";
    skip.innerHTML = `⚡<span class="skip-cost">💎${game.gemSkipCost(screen, cell)}</span>`;
    skip.onclick = (e) => {
      e.stopPropagation();
      if (game.skipProduction(screen, i)) { render(); return; }
      // Not enough gems — offer to finish it by watching an ad instead.
      if (game.adsLeftThisHour() <= 0) { toast("Не хватает 💎"); return; }
      tgApi.confirmDialog("Не хватает 💎. Посмотреть рекламу и ускорить?", async () => {
        if (await game.watchToSkip(screen, i)) render();
      });
    };
    el.appendChild(skip);
  } else { // ready
    const def = econ.itemDef(cell.item);
    el.classList.add("cell-ready");
    body.innerHTML = `<span class="cell-ic">${def.icon}</span>
      <span class="cell-collect">✓ Забрать ×${cell.stock}</span>`;
    el.onclick = () => {
      const ok = screen === "garden" ? game.collectGarden(i) : game.collectKitchen(i);
      if (ok) render();
    };
  }
  el.appendChild(body);
}

// The shop is a "floor": a compact shelf grid up top and a counter (entrance +
// cash register) at the bottom. Animated customers (shopfloor.js) walk over it
// in the #floor overlay, so this only builds the static, tappable structure.
function shopScreen() {
  const wrap = div("shop-screen");
  wrap.appendChild(adBonusBar());
  wrap.appendChild(grid("shop"));
  wrap.appendChild(counter());
  return wrap;
}

// Rewarded-ad freebie: watch a short ad for coins. Greys out on cooldown / when
// the hourly cap is hit; the ticker refreshes it while the shop is open.
function adBonusBar() {
  const btn = document.createElement("button");
  btn.id = "ad-bonus-btn";
  paintAdBonus(btn);
  return btn;
}

function paintAdBonus(btn) {
  const ready = game.coinBonusReady();
  btn.className = "ad-bonus" + (ready ? "" : " ad-bonus-off");
  btn.disabled = !ready;
  if (ready) {
    btn.innerHTML = `<span class="ad-ic">📺</span>
      <span class="ad-txt">Смотреть рекламу</span>
      <span class="ad-reward">+${fmt(game.coinBonusAmount())} 🪙</span>`;
    btn.onclick = async () => {
      btn.disabled = true;
      const amt = await game.watchCoinBonus();
      if (amt > 0) toast(`+${fmt(amt)} 🪙`);
      render();
    };
  } else if (game.adsLeftThisHour() <= 0) {
    btn.innerHTML = `<span class="ad-ic">📺</span>
      <span class="ad-txt">Лимит рекламы на час</span>
      <span class="ad-reward">⏳</span>`;
  } else {
    btn.innerHTML = `<span class="ad-ic">📺</span>
      <span class="ad-txt">Бонус за рекламу</span>
      <span class="ad-reward">через ${fmtTime(game.coinBonusCooldownLeft())}</span>`;
  }
}

function counter() {
  const c = div("counter");

  const door = div("door");
  door.innerHTML = `<span class="door-ic">🚪</span><span class="door-lbl">вход</span>`;
  c.appendChild(door);

  const n = game.queueLength();
  const reg = document.createElement("button");
  reg.className = "register" + (n > 0 ? " has-queue" : "");
  reg.id = "register-anchor";
  reg.innerHTML = n > 0
    ? `<span class="reg-ic">🧾</span><span class="reg-amt">+${fmt(game.queueTotal())} 🪙</span><span class="reg-cnt">${n}/${game.MAX_QUEUE}</span>`
    : `<span class="reg-ic">🛒</span><span class="reg-lbl">Касса</span>`;
  reg.onclick = () => { const g = shopfloor.serveFront(); if (g > 0) { toast(`+${g} 🪙`); coach.signal("served"); } };
  c.appendChild(reg);
  return c;
}

function fillShopCell(el, cell, i, status) {
  const body = div("cell-body");
  if (status === "idle") {
    body.innerHTML = `<span class="cell-plus">＋</span><span class="cell-action">Выложить</span>`;
    el.onclick = () => shelfModal(i);
  } else { // stocked — no tap action (can't overwrite a full shelf)
    const def = econ.itemDef(cell.item);
    el.classList.add("cell-stocked");
    body.innerHTML = `<span class="cell-ic">${def.icon}</span>
      <span class="cell-name">${def.name}</span>
      <span class="shelf-qty">${"●".repeat(cell.stock)}${"○".repeat(game.MAX_STOCK - cell.stock)}</span>`;
  }
  el.appendChild(body);
}

// ── Modals ───────────────────────────────────────────────────────────────────

function modal(title, rows) {
  const root = document.getElementById("modal-root");
  const back = div("modal-back");
  const sheet = div("modal-sheet");
  const head = div("modal-head");
  head.innerHTML = `<span>${title}</span>`;
  const x = document.createElement("button");
  x.className = "modal-x"; x.textContent = "✕";
  x.onclick = close;
  head.appendChild(x);
  sheet.appendChild(head);
  const list = div("modal-list");
  rows.forEach((r) => list.appendChild(r));
  sheet.appendChild(list);
  back.appendChild(sheet);
  back.onclick = (e) => { if (e.target === back) close(); };
  root.replaceChildren(back);
  function close() { root.replaceChildren(); }
  return close;
}

function optionRow({ icon, name, sub, actionText, enabled, onAction, lockText }) {
  const row = div("opt" + (enabled ? "" : " opt-off"));
  row.innerHTML = `<span class="opt-ic">${icon}</span>
    <span class="opt-main"><span class="opt-name">${name}</span><span class="opt-sub">${sub}</span></span>`;
  const right = document.createElement(enabled ? "button" : "span");
  right.className = enabled ? "opt-btn" : "opt-lock";
  right.textContent = enabled ? actionText : lockText;
  if (enabled) right.onclick = onAction;
  row.appendChild(right);
  return row;
}

// Small "Ур.N" pill appended to an item's name in the pick modals so the level
// (which now drives the sort order) is visible.
function lvlBadge(n) { return ` <span class="opt-lvl">Ур.${n}</span>`; }

function seedModal(i) {
  const cell = state.garden[i];
  const seeds = game.availableSeeds(cell);
  if (seeds.length === 1) { if (game.plant(i, seeds[0].id)) render(); return; }
  const rows = seeds.map((r) => optionRow({
    icon: r.icon, name: r.name + lvlBadge(r.unlock_level),
    sub: `⏱ ${fmtTime(econ.productionTime(r.gather_time_sec, cell.level))} · ×${r.base_yield} · 💰${Math.round(r.base_sell_price)}`,
    actionText: "Посадить", enabled: true,
    onAction: () => { game.plant(i, r.id); closeModal(); render(); },
  }));
  closeModal = modal("🌱 Что посадить (Ур." + cell.level + ")", rows);
}

function recipeModal(i) {
  const cell = state.kitchen[i];
  const recipes = game.availableRecipes(cell);
  const rows = recipes.map((r) => {
    const out = data.productById[r.output];
    const has = game.hasInputs(r);
    // Per-ingredient chip: have/need, green when enough, red when short. Missing
    // ones also show the garden level where that ingredient unlocks (🔒 if the
    // player can't grow it yet).
    const chips = Object.entries(r.inputs).map(([id, q]) => {
      const res = data.resourceById[id];
      const have = state.inventory[id] || 0;
      const ok = have >= q;
      const locked = state.level < res.unlock_level;
      const note = ok ? "" : locked ? ` · 🔒Ур.${res.unlock_level}` : ` · Ур.${res.unlock_level}`;
      return `<span class="ing ${ok ? "ing-ok" : "ing-miss"}">${res.icon} ${have}/${q}${note}</span>`;
    }).join("");
    return optionRow({
      icon: out.icon, name: out.name + lvlBadge(out.unlock_level),
      sub: `<span class="ing-list">${chips}</span><span class="ing-time">⏱ ${fmtTime(econ.productionTime(r.time_sec, cell.level))}</span>`,
      actionText: "Готовить", enabled: has, lockText: "нет\nингр.",
      onAction: () => { game.cook(i, r.id); closeModal(); render(); },
    });
  });
  closeModal = modal("🍳 Что приготовить (Ур." + cell.level + ")", rows.length ? rows : [emptyRow("Нет рецептов")]);
}

function shelfModal(i) {
  const cell = state.shop[i];
  const items = game.stockableItems(cell);
  const rows = items.map((it) => {
    const def = it.def || econ.itemDef(it.id);
    return optionRow({
      icon: def.icon, name: def.name + lvlBadge(def.unlock_level),
      sub: `×${it.qty} на складе · 💰 ${Math.round(econ.sellPrice(it.id, cell.level))}/шт`,
      actionText: "Выложить", enabled: true,
      onAction: () => { game.stockShelf(i, it.id); closeModal(); render(); },
    });
  });
  closeModal = modal("🛒 Полка (Ур." + cell.level + ")",
    rows.length ? rows : [emptyRow("Нет подходящих товаров на складе")]);
}

function upgradeModal(screen, i) {
  const cell = state[screen][i];
  const cost = econ.upgradeCost(cell.level);
  const needLevel = cell.level + 1;
  const rows = [];
  const info = div("upgrade-info");
  info.innerHTML = `<p>Уровень <b>${cell.level}</b> → <b>${needLevel}</b></p>
    <p class="hint">Выше уровень — дороже продажа, быстрее производство.</p>`;
  rows.push(info);

  // Concretely: what new content this exact upgrade unlocks on this cell.
  const unlocks = econ.unlocksAtLevel(screen, needLevel);
  const label = { garden: "🌱 Откроются семена:", kitchen: "🍳 Откроются блюда:",
    shop: "🛒 Можно будет продавать:" }[screen];
  const unlockBox = div("unlock-box");
  if (unlocks.length) {
    const chips = unlocks
      .map((u) => `<span class="unlock-chip">${u.icon} ${u.name}</span>`).join("");
    unlockBox.innerHTML = `<p class="unlock-label">${label}</p>
      <div class="unlock-list">${chips}</div>`;
  } else {
    unlockBox.innerHTML = `<p class="unlock-label hint">На этом уровне нового ассортимента нет — растёт цена и скорость.</p>`;
  }
  rows.push(unlockBox);
  const canLevel = state.level >= needLevel;
  const canPay = state.coins >= cost;
  const btn = document.createElement("button");
  btn.className = "big-btn";
  if (!canLevel) { btn.disabled = true; btn.textContent = `Нужен уровень игрока ${needLevel}`; }
  else if (!canPay) { btn.disabled = true; btn.textContent = `Не хватает: ${fmt(Math.round(cost))} 🪙`; }
  else { btn.textContent = `Улучшить · ${fmt(Math.round(cost))} 🪙`;
    btn.onclick = () => { game.upgrade(screen, i); closeModal(); render(); }; }
  rows.push(btn);
  closeModal = modal("⬆ Улучшить ячейку", rows);
}

function inventoryModal() {
  const items = game.inventoryList();
  const rows = items.length
    ? items.map((it) => optionRow({
        icon: it.def.icon, name: it.def.name,
        sub: `Ур.${it.def.unlock_level} · 💰 ${Math.round(econ.sellPrice(it.id, 1))}/шт`,
        actionText: "×" + it.qty, enabled: false, lockText: "×" + it.qty,
      }))
    : [emptyRow("Склад пуст. Собери урожай и приготовь блюда.")];
  closeModal = modal("🎒 Склад", rows);
}

function gemStoreModal() {
  const costs = game.premiumCosts();
  const bal = div("gem-balance");
  bal.innerHTML = `<span class="gem-big">💎 ${game.gems()}</span>
    <span class="hint">Гемы — за уровни (скоро: реклама, задания, ⭐)</span>`;
  const rows = [
    bal,
    premiumRow("🧾", "Авто-касса", "Покупатели платят сами — даже пока тебя нет",
      costs.auto_register_cost, game.hasAutoRegister(), () => { if (game.buyAutoRegister()) gemStoreModal(); }),
    premiumRow("⏩", "×2 к офлайн-доходу", "Авто-касса зарабатывает вдвое больше, пока тебя нет",
      costs.offline_x2_cost, game.hasOfflineX2(), () => { if (game.buyOfflineX2()) gemStoreModal(); }),
    hintRow("Ускорить рост/готовку можно за 💎 прямо на грядке ⚡"),
    replayTutorialRow(),
    resetRow(),
  ];
  closeModal = modal("💎 Магазин", rows);
}

// Replay the onboarding coach from step 1 (kept next to reset so testers/curious
// players can revisit the how-to-play). Jumps to the garden where step 1 begins.
function replayTutorialRow() {
  const btn = document.createElement("button");
  btn.className = "ad-double-btn";
  btn.textContent = "🎓 Пройти обучение заново";
  btn.onclick = () => {
    game.resetTutorial();
    closeModal();
    setScreen("garden");
    coach.restart();
  };
  return btn;
}

function resetRow() {
  const btn = document.createElement("button");
  btn.className = "danger-btn";
  btn.textContent = "🗑 Сбросить весь прогресс";
  btn.onclick = () => tgApi.confirmDialog(
    "Точно сбросить ВЕСЬ прогресс? Это нельзя отменить.",
    () => game.resetProgress());
  return btn;
}

function premiumRow(icon, name, sub, cost, owned, onBuy) {
  const row = div("opt");
  row.innerHTML = `<span class="opt-ic">${icon}</span>
    <span class="opt-main"><span class="opt-name">${name}</span><span class="opt-sub">${sub}</span></span>`;
  const btn = document.createElement("button");
  if (owned) { btn.className = "opt-lock"; btn.textContent = "куплено ✓"; }
  else {
    btn.className = "opt-btn";
    btn.textContent = `💎${cost}`;
    if (game.gems() < cost) { btn.disabled = true; btn.style.opacity = ".5"; }
    else btn.onclick = onBuy;
  }
  row.appendChild(btn);
  return row;
}

function hintRow(text) { const d = div("opt opt-empty"); d.textContent = text; return d; }

export function initGems() {
  document.getElementById("gems-btn").addEventListener("click", gemStoreModal);
}

// ── Phase 4: leaderboard + display name ──────────────────────────────────────

export function initBoard() {
  const btn = document.getElementById("board-btn");
  if (btn) btn.addEventListener("click", leaderboardModal);
}

async function leaderboardModal() {
  // Loading placeholder while we fetch.
  const loading = div("opt opt-empty");
  loading.textContent = "Загрузка рейтинга…";
  closeModal = modal("🏆 Рейтинг", [loading]);

  const data = await backend.leaderboard(50);
  if (!data) { loading.textContent = "Рейтинг недоступен офлайн"; return; }

  const rows = [];
  // Your own standing + a rename entry.
  const me = data.me || {};
  const meRow = div("board-me");
  meRow.innerHTML = `<span class="board-me-rank">#${me.rank || "—"}</span>
    <span class="board-me-name">${escapeHtml(me.name || "Игрок")}</span>
    <span class="board-me-stat">Ур.${me.level || 1} · ${fmt(me.coins || 0)} 🪙</span>`;
  const rename = document.createElement("button");
  rename.className = "board-rename";
  rename.textContent = "✏️ Сменить имя";
  rename.onclick = () => renameModal();
  meRow.appendChild(rename);
  rows.push(meRow);

  const top = data.top || [];
  if (!top.length) rows.push(emptyRow("Пока никого нет — будь первым!"));
  top.forEach((r) => {
    const row = div("board-row" + (r.me ? " board-row-me" : ""));
    const medal = r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : "";
    row.innerHTML = `<span class="board-rank">${medal || r.rank}</span>
      <span class="board-name">${escapeHtml(r.name)}</span>
      <span class="board-lvl">Ур.${r.level}</span>
      <span class="board-coins">${fmt(r.coins)} 🪙</span>`;
    rows.push(row);
  });
  // Re-render the sheet with the loaded data.
  closeModal = modal("🏆 Рейтинг", rows);
}

// One-time intro shown after the player is assigned a generated name. Offers to
// keep it or rename. Both paths acknowledge server-side so it won't show again.
export function showNameIntro() {
  const name = game.profile.displayName || "Игрок";
  const info = div("upgrade-info");
  info.innerHTML = `<p style="font-size:40px;text-align:center;margin:0">🏆</p>
    <p style="text-align:center;font-size:15px;margin:8px 0 2px">Появился рейтинг игроков!</p>
    <p style="text-align:center;color:var(--tg-hint);font-size:13px;margin:2px 0">Тебе досталось имя:</p>
    <p style="text-align:center;font-size:22px;font-weight:800;margin:4px 0">${escapeHtml(name)}</p>
    <p style="text-align:center;color:var(--tg-hint);font-size:12px;margin:2px 0">Его увидят другие игроки. Можно оставить или сменить.</p>`;
  const keep = document.createElement("button");
  keep.className = "big-btn";
  keep.textContent = "Оставить";
  keep.onclick = () => { backend.setName(""); game.setLocalName(null, true); closeModal(); };
  const change = document.createElement("button");
  change.className = "ad-double-btn";
  change.textContent = "✏️ Сменить имя";
  change.onclick = () => renameModal();
  closeModal = modal("Новое: рейтинг", [info, change, keep]);
}

function renameModal() {
  const info = div("upgrade-info");
  info.innerHTML = `<p style="text-align:center;color:var(--tg-hint);font-size:13px;margin:2px 0 8px">Введи новое имя (до 24 символов)</p>`;
  const input = document.createElement("input");
  input.className = "name-input";
  input.type = "text";
  input.maxLength = 24;
  input.value = game.profile.displayName || "";
  input.placeholder = "Имя в рейтинге";
  info.appendChild(input);

  const save = document.createElement("button");
  save.className = "big-btn";
  save.textContent = "Сохранить";
  save.onclick = async () => {
    const name = input.value.trim();
    if (!name) { toast("Пустое имя"); return; }
    save.disabled = true;
    const res = await backend.setName(name);
    if (res && res.ok) {
      game.setLocalName(res.displayName || name, true);
      toast("Имя изменено");
      closeModal();
    } else {
      save.disabled = false;
      toast("Не удалось изменить");
    }
  };
  closeModal = modal("✏️ Смена имени", [info, save]);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function emptyRow(text) { const d = div("opt opt-empty"); d.textContent = text; return d; }
let closeModal = () => {};

// ── Phase D: daily tasks + weekly streak ─────────────────────────────────────

export function initDaily() {
  const btn = document.getElementById("daily-btn");
  if (btn) btn.addEventListener("click", () => dailyModal());
}

// Auto-open once per session when there's a chest to claim (called from main.js
// after the offline / name-intro modals so only one shows at a time).
let dailyAutoShown = false;
export function maybeShowDaily() {
  if (dailyAutoShown) return;
  dailyAutoShown = true;
  // Nag only for actionable rewards: an unclaimed completed task, or the weekly
  // super waiting in the chest. Plain ad-chests are always available, so they
  // shouldn't pop the modal every session.
  if (game.dailyHasUnclaimed()) dailyModal();
}

// "+220 🪙  +25 XP  +2 🍲" from a granted-reward summary.
function dailyRewardStr(s) {
  if (!s) return "Награда получена ✨";
  const parts = [];
  if (s.coins) parts.push(`+${fmt(s.coins)} 🪙`);
  if (s.xp) parts.push(`+${s.xp} XP`);
  if (s.gems) parts.push(`+${s.gems} 💎`);
  if (s.dishes && s.dishItem) { const d = econ.itemDef(s.dishItem); parts.push(`+${s.dishes} ${d ? d.icon : "🍽"}`); }
  return parts.join("  ") || "Награда получена ✨";
}

function streakCalendar() {
  const streak = game.dailyStreak();
  const doneToday = game.dailyStreakDoneToday(); // streak already advanced today (via tasks)
  const weekDone = streak > 0 && streak % 7 === 0 ? 7 : streak % 7; // chips filled this cycle
  const currentIdx = doneToday ? -1 : weekDone;                     // next chip to fill
  const chestReady = !doneToday;                                    // highlight today's target

  const wrap = div("daily-streak-wrap");
  const label = div("daily-streak-label");
  const floor = game.dailyStreakFloor();
  const quality = "●".repeat(Math.max(0, Math.min(3, floor))) + "○".repeat(3 - Math.max(0, Math.min(3, floor)));
  label.innerHTML = `<span class="daily-fire">🔥 Стрик: <b>${streak}</b> ${streak === 1 ? "день" : "дн."}</span>` +
    `<span class="daily-quality" title="Качество стрика — влияет на приз 7-го дня">приз 7-го дня: ${quality}</span>`;
  wrap.appendChild(label);

  const row = div("daily-streak");
  for (let i = 0; i < 7; i++) {
    const chip = div("daily-day");
    if (i === 6) chip.classList.add("daily-day-super");
    if (i < weekDone) { chip.classList.add("daily-day-done"); chip.textContent = "✓"; }
    else if (i === currentIdx && chestReady) { chip.classList.add("daily-day-current"); chip.textContent = i === 6 ? "💎" : i + 1; }
    else chip.textContent = i === 6 ? "💎" : i + 1;
    row.appendChild(chip);
  }
  wrap.appendChild(row);
  return wrap;
}

function dailyTaskRow(t, i) {
  // Sequential chain: a task stays locked until every earlier one is completed.
  if (i > 0 && !game.dailyTaskUnlocked(i)) {
    const row = div("daily-task daily-task-locked");
    const main = div("daily-task-main");
    main.innerHTML = `<span class="daily-task-lbl">🔒 Задание ${i + 1}</span>
      <span class="daily-task-prog">Откроется после предыдущего задания</span>`;
    row.appendChild(main);
    const lock = document.createElement("span");
    lock.className = "daily-claim"; lock.textContent = "🔒";
    row.appendChild(lock);
    return row;
  }
  const done = game.dailyTaskDone(t);
  const row = div("daily-task" + (t.claimed ? " daily-task-claimed" : done ? " daily-task-done" : ""));
  const main = div("daily-task-main");
  if (t.claimed) {
    // Already claimed: show exactly WHAT was received on the row (persisted), so a
    // missed toast doesn't matter. Reward is never shown before claiming.
    main.innerHTML = `<span class="daily-task-lbl">${game.dailyTaskLabel(t)}</span>
      <span class="daily-got">Получено: ${dailyRewardStr(t.granted)}</span>`;
  } else {
    const pct = Math.min(100, Math.round(((t.progress || 0) / t.goal) * 100));
    main.innerHTML = `<span class="daily-task-lbl">${game.dailyTaskLabel(t)}</span>
      <div class="daily-bar"><div class="daily-fill" style="width:${pct}%"></div></div>
      <span class="daily-task-prog">${Math.min(t.progress || 0, t.goal)} / ${t.goal}</span>`;
  }
  row.appendChild(main);

  const btn = document.createElement("button");
  if (t.claimed) { btn.className = "daily-claim claimed"; btn.textContent = "✓"; btn.disabled = true; }
  else if (done) {
    btn.className = "daily-claim ready"; btn.textContent = "Забрать";
    btn.onclick = async () => {
      btn.disabled = true;
      const r = await game.claimDailyTask(t.id);
      if (r) toast(dailyRewardStr(r), 2500);
      dailyModal(); // rebuild — the row now shows the received reward
    };
  } else { btn.className = "daily-claim"; btn.textContent = `${Math.min(t.progress || 0, t.goal)}/${t.goal}`; btn.disabled = true; }
  row.appendChild(btn);
  return row;
}

function dailyModal() {
  const rows = [streakCalendar()];
  const tasks = game.dailyTasks();
  if (!tasks.length) rows.push(emptyRow("Задания появятся совсем скоро."));
  tasks.forEach((t, i) => rows.push(dailyTaskRow(t, i)));

  if (game.dailyChestIsSuper()) {
    rows.push(hintRow("🎁 Сегодня супер-приз! Выполни все 3 задания перед тем как смотреть рекламу — от этого зависит его размер."));
  }

  // Status: how many chests you've opened today ("Сундук не получен" → "Получено N…").
  const count = game.dailyChestCount();
  const status = div("daily-chest-status");
  status.textContent = chestCountText(count);
  rows.push(status);

  // Contents of the last chest opened today (persisted).
  if (count > 0 && game.dailyChestGranted()) {
    const tier = game.dailyChestSuperTier();
    const got = div("daily-chest-got");
    got.innerHTML = `<span class="daily-got">🎁 ${tier ? `Супер-приз ${"★".repeat(tier)}: ` : ""}${dailyRewardStr(game.dailyChestGranted())}</span>`;
    rows.push(got);
  }

  const chest = document.createElement("button");
  chest.id = "daily-chest-btn";
  paintDailyChest(chest);
  rows.push(chest);

  closeModal = modal("📅 Задания дня", rows);
}

let claimingChest = false;

// Paint the chest button for the current state (called on build + every ticker
// tick so the cooldown counts down and the button re-enables live).
function paintDailyChest(btn) {
  if (claimingChest) {
    btn.className = "big-btn daily-chest"; btn.disabled = true; btn.onclick = null;
    btn.textContent = "📺 Реклама…"; return;
  }
  const count = game.dailyChestCount();
  const isSuper = game.dailyChestIsSuper();
  btn.className = "big-btn daily-chest" + (isSuper ? " daily-chest-super" : "");
  if (game.dailyChestReady()) {
    btn.disabled = false;
    btn.textContent = count === 0
      ? (isSuper ? "📺 Смотреть рекламу — СУПЕР-приз" : "📺 Смотреть рекламу и открыть сундук")
      : "📺 Получить ещё сундук";
    btn.onclick = onClaimChest;
  } else {
    btn.disabled = true; btn.onclick = null;
    if (game.adsLeftThisHour() <= 0) btn.textContent = "Лимит рекламы на час ⏳";
    else btn.textContent = `Ещё сундук через ${fmtClock(game.dailyChestCooldownLeft())}`;
  }
}

async function onClaimChest() {
  if (claimingChest) return;
  claimingChest = true;
  const btn = document.getElementById("daily-chest-btn");
  if (btn) paintDailyChest(btn);
  const r = await game.claimDailyChest(); // plays the rewarded ad, then claims
  claimingChest = false;
  if (r) {
    const body = dailyRewardStr(r.reward);
    toast(r.superTier ? `🎁 Супер-приз ${"★".repeat(r.superTier)}: ${body}` : `🎁 Получен сундук: ${body}`, 2800);
  }
  dailyModal(); // rebuild — updates the "Получено N" status + reward line
}

function chestCountText(n) {
  if (n === 0) return "Сундук не получен";
  if (n === 1) return "Получен 1 сундук";
  return `Получено ${n} ${pluralChest(n)}`;
}
function pluralChest(n) {
  const d = n % 10, dd = n % 100;
  if (d === 1 && dd !== 11) return "сундук";
  if (d >= 2 && d <= 4 && !(dd >= 12 && dd <= 14)) return "сундука";
  return "сундуков";
}
function fmtClock(s) { const m = Math.floor(s / 60), ss = s % 60; return `${m}:${String(ss).padStart(2, "0")}`; }

// ── Tickers ──────────────────────────────────────────────────────────────────

let nextSpawnAt = 0;
let nextAutoServeAt = 0;

export function startTicker() {
  nextSpawnAt = Date.now() + econ.npcSpawnInterval(state.shop) * 1000;
  setInterval(() => {
    if (backend.serverAuth()) {
      // Server-authoritative: the server is the sole spawner/auto-server (via
      // advance()); the client reflects the reconciled state.queue with full
      // walk-in animation, plus decorative browsers when the queue is full or
      // shelves are empty (they never touch the economy).
      if (active === "shop") {
        game.pokeSync(); // reconcile more often while watching so customers arrive promptly
        shopfloor.syncToQueue();
        if (Date.now() >= nextSpawnAt) {
          if (game.queueFull() || !game.shopHasStock()) shopfloor.spawnBrowser();
          nextSpawnAt = Date.now() + econ.npcSpawnInterval(state.shop) * 1000;
        }
      }
    } else {
      // Legacy: customers arrive on their interval regardless of the active
      // screen. On the shop screen they always walk in — with empty shelves (or
      // a full queue) they browse (❓) and leave. Elsewhere they queue logically.
      if (Date.now() >= nextSpawnAt) {
        if (active === "shop") shopfloor.spawnAnimated();
        else if (!game.queueFull() && game.shopHasStock()) game.autoSpawn();
        nextSpawnAt = Date.now() + econ.npcSpawnInterval(state.shop) * 1000;
      }
      // Auto-register (gem perk): serve the queue without tapping.
      if (game.hasAutoRegister() && game.queueLength() > 0 && Date.now() >= nextAutoServeAt) {
        const g = active === "shop" ? shopfloor.serveFront() : game.collectPayment();
        if (g > 0 && active === "shop") toast(`+${g} 🪙`);
        nextAutoServeAt = Date.now() + 1200;
      }
    }
    if (active === "garden" || active === "kitchen") updateBusyBars(active);
    if (active === "shop") updateAdBonus();
    const chestBtn = document.getElementById("daily-chest-btn");
    if (chestBtn) paintDailyChest(chestBtn); // live cooldown countdown / re-enable
    coach.reposition(); // keep onboarding marks glued to their moving anchors
  }, 500);
}

// Keep the shop's ad-bonus button in sync (cooldown counts down; flips to the
// active state when ready) without rebuilding the animated floor each tick.
function updateAdBonus() {
  const btn = document.getElementById("ad-bonus-btn");
  if (btn) paintAdBonus(btn);
}

function updateBusyBars(screen) {
  document.querySelectorAll(".cell-busy").forEach((el) => {
    const i = [...el.parentNode.children].indexOf(el);
    const cell = state[screen][i];
    if (!cell || !cell.startedAt) return;
    if (game.progress(screen, cell) >= 1) { render(); return; }
    const fill = el.querySelector(".cell-fill");
    if (fill) fill.style.width = `${Math.floor(game.progress(screen, cell) * 100)}%`;
  });
}

// ── Toasts / offline ─────────────────────────────────────────────────────────

export function toast(text, ms = 1500) {
  const root = document.getElementById("toasts");
  const t = div("toast"); t.textContent = text;
  root.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// Celebrate a level-up. Player level gates cell upgrades: reaching level N lets
// you upgrade cells to level N, which is what actually unlocks new content — so
// the copy frames it that way rather than claiming the items are already unlocked.
export function showLevelUp(level) {
  const unlocks = [...econ.unlocksAtLevel("garden", level), ...econ.unlocksAtLevel("kitchen", level)];
  const info = div("upgrade-info");
  let html = `<p style="font-size:44px;text-align:center;margin:0">🎉</p>
    <p style="text-align:center;font-size:22px;font-weight:800;margin:4px 0">Уровень ${level}!</p>
    <p style="text-align:center;color:var(--tg-hint);font-size:13px;margin:2px 0">Теперь можно улучшать клетки до ур. ${level}.</p>`;
  if (unlocks.length) {
    html += `<p style="text-align:center;color:var(--tg-hint);font-size:13px;margin:6px 0 2px">Апгрейд до ур. ${level} откроет:</p>
      <div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center">${
        unlocks.map((u) => `<span class="unlock-chip">${u.icon} ${u.name}</span>`).join("")}</div>`;
  }
  info.innerHTML = html;
  const btn = document.createElement("button");
  btn.className = "big-btn"; btn.textContent = "Класс!";
  btn.onclick = () => closeModal();
  closeModal = modal("Новый уровень", [info, btn]);
}

export function showOfflineReport() {
  if (!game.offlineReport) return;
  const { earned, sold, queued, x2 } = game.offlineReport;
  game.clearOfflineReport();
  const info = div("upgrade-info");
  let btnText = "Отлично!";
  let onOk = () => closeModal();
  if (queued) {
    // Default mode: customers lined up while away — the player collects.
    info.innerHTML = `<p style="font-size:40px;text-align:center">🧾🛎️</p>
      <p style="text-align:center">Пока тебя не было, <b>${queued}</b> покупател${queued === 1 ? "ь встал" : (queued < 5 ? "я встали" : "ей встали")} в очередь у кассы.</p>
      <p style="text-align:center;color:var(--tg-hint);font-size:13px">Загляни в Лавку и собери оплату!</p>`;
    btnText = "В Лавку 🏪";
    onOk = () => { closeModal(); setScreen("shop"); };
  } else {
    info.innerHTML = `<p style="font-size:40px;text-align:center">🛒💤</p>
      <p style="text-align:center">Пока тебя не было, авто-касса обслужила <b>${sold}</b> покупател${sold === 1 ? "я" : "ей"}.</p>
      <p style="text-align:center;font-size:24px;font-weight:800;color:var(--gold)">+${fmt(earned)} 🪙${x2 ? " <span style='font-size:13px;color:var(--tg-hint)'>×2 буст</span>" : ""}</p>`;
  }
  const rows = [info];
  // Rewarded ad: double the offline auto-register payout.
  if (earned > 0 && game.adsLeftThisHour() > 0) {
    const dbl = document.createElement("button");
    dbl.className = "ad-double-btn";
    dbl.innerHTML = `📺 Удвоить награду <b>+${fmt(earned)} 🪙</b>`;
    dbl.onclick = async () => {
      dbl.disabled = true;
      if (await game.watchToDouble(earned)) { toast(`+${fmt(earned)} 🪙`); dbl.remove(); }
      else dbl.disabled = false;
    };
    rows.push(dbl);
  }
  const btn = document.createElement("button");
  btn.className = "big-btn"; btn.textContent = btnText;
  btn.onclick = onOk;
  rows.push(btn);
  closeModal = modal("С возвращением!", rows);
}

export function initBag() {
  document.getElementById("bag-btn").addEventListener("click", () => { coach.signal("bag"); inventoryModal(); });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function bump(el) { el.classList.remove("shake"); void el.offsetWidth; el.classList.add("shake"); }
function div(cls) { const d = document.createElement("div"); d.className = cls; return d; }
function fmt(n) { return Math.floor(n).toLocaleString("ru-RU"); }
function fmtTime(s) { return s < 60 ? `${Math.round(s)}с` : `${Math.round(s / 60)}м`; }
