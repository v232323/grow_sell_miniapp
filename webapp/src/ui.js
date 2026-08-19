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
import * as tgApi from "./platform.js";
import * as coach from "./coach.js";
import * as ads from "./ads.js";
import * as review from "./review.js";
import { t, tp, fmtNum, fmtDuration, itemName, playerName, getLocale, chooseLocale, SUPPORTED } from "./i18n.js";

let active = "garden";

// Notes and do-all labels are looked up per render (see t()), not frozen in a
// const, so switching language re-renders them.

export function setScreen(name) {
  if (active === "shop" && name !== "shop") shopfloor.leave();
  active = name;
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("is-active", t.dataset.screen === name));
  coach.onScreen(name);
  render();
  if (name === "shop") shopfloor.enter();
}

// Text that lives in index.html rather than in a render pass: tab labels and the
// HUD button tooltips. Re-applied on every language change.
export function applyChrome() {
  document.title = t("app_title");
  const setText = (sel, key) => {
    const el = document.querySelector(sel);
    if (el) el.textContent = t(key);
  };
  const setTitle = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.title = t(key);
  };
  setText('.tab[data-screen="garden"] span', "tab_garden");
  setText('.tab[data-screen="kitchen"] span', "tab_kitchen");
  setText('.tab[data-screen="shop"] span', "tab_shop");
  setTitle("coins-btn", "hud_coins");
  setTitle("gems-btn", "hud_gems");
  setTitle("daily-btn", "hud_daily");
  setTitle("board-btn", "hud_board");
  setTitle("bag-btn", "hud_bag");
  setTitle("settings-btn", "hud_settings");
  setTitle("level", "hud_level");
  // The "Lv." prefix on the level pill is drawn by CSS ::before, which can only
  // read a custom property — so hand it the translated string.
  document.documentElement.style.setProperty("--lvl-prefix", JSON.stringify(t("level_prefix")));
}

export function render() {
  renderHud();
  const el = document.getElementById("screen");
  el.classList.toggle("shop-mode", active === "shop"); // fixed floor, no scroll
  const frag = document.createDocumentFragment();
  const head = screenHead(active);
  if (head) frag.appendChild(head);
  if (active === "shop") frag.appendChild(shopScreen());
  else frag.appendChild(grid(active));
  el.replaceChildren(frag);
  markGridOverflow();
  coach.refresh(); // re-place onboarding marks against the freshly built DOM
}

// The cells shrink to fit rather than overflow, so this should never trigger on a
// phone. On something very short it still can, and a half-visible bottom row reads
// as a rendering bug rather than as "there's more below" — so mark the state and
// let CSS fade the cut edge.
function markGridOverflow() {
  const g = document.querySelector("#screen .grid");
  if (g) g.classList.toggle("is-scrollable", g.scrollHeight > g.clientHeight + 1);
}

// Telegram resizes the viewport when its own chrome expands/collapses.
window.addEventListener("resize", markGridOverflow);

function renderHud() {
  document.getElementById("coins").textContent = fmtNum(state.coins);
  document.getElementById("gems").textContent = game.gems();
  document.getElementById("level").textContent = state.level;
  const need = econ.xpForNextLevel(state.level);
  const xpText = document.getElementById("xp-text");
  const fill = document.getElementById("xp-fill");
  if (need > 0) {
    xpText.textContent = t("xp_progress", { cur: Math.floor(state.xp), need });
    fill.style.width = `${Math.min(100, (state.xp / need) * 100)}%`;
  } else {
    xpText.textContent = t("xp_max"); fill.style.width = "100%";
  }
  const dot = document.getElementById("daily-dot");
  if (dot) dot.hidden = !game.dailyHasUnclaimed();
  // The ad moved behind the coins counter, so it needs a nudge to stay findable.
  const coinsDot = document.getElementById("coins-dot");
  if (coinsDot) coinsDot.hidden = !game.coinBonusReady();
}

// ── Screen header: one-tap "do all" (star-gated) ─────────────────────────────

// Returns null when there is nothing to put in the header — the row is then not
// rendered at all. The screens used to carry a one-line hint here ("Plant crops…"),
// but the onboarding coach teaches the same thing in context, and on a narrow
// phone that hint wrapped to three lines and pushed the shop's bottom shelf row
// off the fixed floor.
function screenHead(screen) {
  // Star-priced do-all only exists where Stars do. On iOS it's hidden outright
  // rather than shown disabled: a paid-looking button that can't be paid for is
  // exactly what App Review flags (see docs/IOS_PLAN.md, 3.2).
  if (tgApi.caps.stars) {
    const head = div("screen-head");
    const btn = document.createElement("button");
    btn.className = "doall-btn";
    btn.innerHTML = `<span class="da-lbl">✨ ${t("doall_" + screen)}</span>` +
      `<span class="da-star">⭐${stars.starCost("do_all")}</span>`;
    // Straight to the Stars purchase — Telegram's native payment sheet is the
    // confirmation, so no extra custom confirm/undo gate is needed.
    btn.onclick = () => stars.purchase("do_all", () => onDoAllPaid(screen), { screen });
    head.appendChild(btn);
    return head;
  }
  return null;
}

// Called after a confirmed Stars payment for do-all.
function onDoAllPaid(screen) {
  if (backend.serverAuth()) {
    // Server-authoritative: the payment webhook already ran the do-all on the
    // canonical state (it's not triggerable from the client). Just pull it.
    toast(t("doall_paid"));
    game.reconcilePaidDoAll();
    return;
  }
  // Legacy / dev (no backend): run the do-all locally.
  let parts = [];
  if (screen === "garden") { const r = game.doAllGarden(); parts = [[r.collected, t("doall_collected")], [r.planted, t("doall_planted")]]; }
  else if (screen === "kitchen") { const r = game.doAllKitchen(); parts = [[r.collected, t("doall_collected")], [r.cooked, t("doall_cooked")]]; }
  else {
    const r = game.doAllShop();
    parts = [[r.stocked, t("doall_stocked")], [r.served, t("doall_served")]];
    shopfloor.syncToQueue(); // animate the served customers out of the floor
  }
  const msg = parts.filter(([n]) => n > 0).map(([n, w]) => `${w} ${n}`).join(", ");
  toast(msg || t("doall_nothing"));
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
      <span class="lock-build">${t("cell_build")}</span>
      <span class="lock-cost">${fmtNum(Math.round(cost))} 🪙</span>`;
    // Confirm before building so a stray tap can't spend coins by accident.
    el.onclick = () => {
      if (state.coins < cost) { bump(el); return; }
      const what = t("what_" + screen);
      tgApi.confirmDialog(t("build_confirm", { what, cost: fmtNum(Math.round(cost)) }), () => {
        if (game.build(screen, i)) render();
      });
    };
    return el;
  }

  // level chip (tap to upgrade) for built cells
  const chip = div("lvl-chip");
  chip.textContent = t("cell_level", { n: cell.level });
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
      <span class="cell-action">${screen === "garden" ? t("cell_plant") : t("cell_cook")}</span>`;
    el.onclick = () => (screen === "garden" ? seedModal(i) : recipeModal(i));
  } else if (status === "busy") {
    const def = econ.itemDef(cell.item);
    const p = Math.floor(game.progress(screen, cell) * 100);
    body.innerHTML = `<span class="cell-ic">${def.icon}</span>
      <span class="cell-name">${itemName(def)}</span>
      <div class="cell-bar"><div class="cell-fill" style="width:${p}%"></div></div>`;
    const skip = document.createElement("button");
    skip.className = "skip-btn";
    skip.innerHTML = `⚡<span class="skip-cost">💎${game.gemSkipCost(screen, cell)}</span>`;
    skip.onclick = (e) => {
      e.stopPropagation();
      if (game.skipProduction(screen, i)) { render(); return; }
      // Gems only. There used to be an "or watch an ad" offer here, but the whole
      // wait is under a minute (the slowest crop is 50s before the cell's speed
      // bonus), so a 30-second video to skip it is a worse deal than waiting —
      // and an ad the player regrets watching costs more than it earns.
      toast(t("no_gems"));
    };
    el.appendChild(skip);
  } else { // ready
    const def = econ.itemDef(cell.item);
    el.classList.add("cell-ready");
    body.innerHTML = `<span class="cell-ic">${def.icon}</span>
      <span class="cell-collect">${t("cell_collect", { n: cell.stock })}</span>`;
    el.onclick = () => {
      const ok = screen === "garden" ? game.collectGarden(i) : game.collectKitchen(i);
      if (ok) render();
    };
  }
  el.appendChild(body);
}

// The shop is a "floor": nothing but the shelf grid, with the space below it left
// open. Customers (shopfloor.js) walk in from off-screen over the #floor overlay,
// queue along that open strip, and are paid by tapping the one at the front —
// there is no drawn door or register, they only ate the height that the shelves
// needed to match the cell size of the other screens.
function shopScreen() {
  const wrap = div("shop-screen");
  wrap.appendChild(grid("shop"));
  return wrap;
}

function fillShopCell(el, cell, i, status) {
  const body = div("cell-body");
  if (status === "idle") {
    body.innerHTML = `<span class="cell-plus">＋</span><span class="cell-action">${t("act_place")}</span>`;
    el.onclick = () => shelfModal(i);
  } else { // stocked — no tap action (can't overwrite a full shelf)
    const def = econ.itemDef(cell.item);
    el.classList.add("cell-stocked");
    // Clamped because `repeat()` throws on a negative count: a stock above
    // MAX_STOCK (bad data, an older save, a balance change that lowered the cap)
    // would otherwise take down the whole screen render with nothing on screen
    // to say why — the tab switches, the old screen just stays.
    const stock = Math.max(0, Math.min(game.MAX_STOCK, cell.stock | 0));
    body.innerHTML = `<span class="cell-ic">${def.icon}</span>
      <span class="cell-name">${itemName(def)}</span>
      <span class="shelf-qty">${"●".repeat(stock)}${"○".repeat(game.MAX_STOCK - stock)}</span>`;
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
function lvlBadge(n) { return ` <span class="opt-lvl">${t("cell_level", { n })}</span>`; }

function seedModal(i) {
  const cell = state.garden[i];
  const seeds = game.availableSeeds(cell);
  if (seeds.length === 1) { if (game.plant(i, seeds[0].id)) render(); return; }
  const rows = seeds.map((r) => optionRow({
    icon: r.icon, name: itemName(r) + lvlBadge(r.unlock_level),
    sub: `⏱ ${fmtDuration(econ.productionTime(r.gather_time_sec, cell.level))} · ×${r.base_yield} · 💰${Math.round(r.base_sell_price)}`,
    actionText: t("act_plant"), enabled: true,
    onAction: () => { game.plant(i, r.id); closeModal(); render(); },
  }));
  closeModal = modal(t("seed_title", { n: cell.level }), rows);
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
      const note = ok ? "" : (locked ? " · 🔒" : " · ") + t("cell_level", { n: res.unlock_level });
      return `<span class="ing ${ok ? "ing-ok" : "ing-miss"}">${res.icon} ${have}/${q}${note}</span>`;
    }).join("");
    return optionRow({
      icon: out.icon, name: itemName(out) + lvlBadge(out.unlock_level),
      sub: `<span class="ing-list">${chips}</span><span class="ing-time">⏱ ${fmtDuration(econ.productionTime(r.time_sec, cell.level))}</span>`,
      actionText: t("act_cook"), enabled: has, lockText: t("lock_no_ingredients"),
      onAction: () => { game.cook(i, r.id); closeModal(); render(); },
    });
  });
  closeModal = modal(t("recipe_title", { n: cell.level }), rows.length ? rows : [emptyRow(t("empty_no_recipes"))]);
}

function shelfModal(i) {
  const cell = state.shop[i];
  const items = game.stockableItems(cell);
  const rows = items.map((it) => {
    const def = it.def || econ.itemDef(it.id);
    return optionRow({
      icon: def.icon, name: itemName(def) + lvlBadge(def.unlock_level),
      sub: t("shelf_sub", { qty: it.qty, price: Math.round(econ.sellPrice(it.id, cell.level)) }),
      actionText: t("act_place"), enabled: true,
      onAction: () => { game.stockShelf(i, it.id); closeModal(); render(); },
    });
  });
  closeModal = modal(t("shelf_title", { n: cell.level }),
    rows.length ? rows : [emptyRow(t("empty_no_goods"))]);
}

function upgradeModal(screen, i) {
  const cell = state[screen][i];
  const cost = econ.upgradeCost(cell.level);
  const needLevel = cell.level + 1;
  const rows = [];
  const info = div("upgrade-info");
  info.innerHTML = `<p>${t("upgrade_levels", { from: cell.level, to: needLevel })}</p>
    <p class="hint">${t("upgrade_hint")}</p>`;
  rows.push(info);

  // Concretely: what new content this exact upgrade unlocks on this cell.
  const unlocks = econ.unlocksAtLevel(screen, needLevel);
  const label = t("unlock_" + screen);
  const unlockBox = div("unlock-box");
  if (unlocks.length) {
    const chips = unlocks
      .map((u) => `<span class="unlock-chip">${u.icon} ${itemName(u)}</span>`).join("");
    unlockBox.innerHTML = `<p class="unlock-label">${label}</p>
      <div class="unlock-list">${chips}</div>`;
  } else {
    unlockBox.innerHTML = `<p class="unlock-label hint">${t("unlock_none")}</p>`;
  }
  rows.push(unlockBox);
  const canLevel = state.level >= needLevel;
  const canPay = state.coins >= cost;
  const btn = document.createElement("button");
  btn.className = "big-btn";
  if (!canLevel) { btn.disabled = true; btn.textContent = t("upgrade_need_level", { n: needLevel }); }
  else if (!canPay) { btn.disabled = true; btn.textContent = t("upgrade_short", { cost: fmtNum(Math.round(cost)) }); }
  else { btn.textContent = t("upgrade_do", { cost: fmtNum(Math.round(cost)) });
    btn.onclick = () => { game.upgrade(screen, i); closeModal(); render(); }; }
  rows.push(btn);
  closeModal = modal(t("upgrade_title"), rows);
}

function inventoryModal() {
  const items = game.inventoryList();
  const rows = items.length
    ? items.map((it) => optionRow({
        icon: it.def.icon, name: itemName(it.def),
        sub: t("bag_sub", { lvl: it.def.unlock_level, price: Math.round(econ.sellPrice(it.id, 1)) }),
        actionText: "×" + it.qty, enabled: false, lockText: "×" + it.qty,
      }))
    : [emptyRow(t("bag_empty"))];
  closeModal = modal(t("bag_title"), rows);
}

function gemStoreModal() {
  const costs = game.premiumCosts();
  const bal = div("gem-balance");
  bal.innerHTML = `<span class="gem-big">💎 ${game.gems()}</span>
    <span class="hint">${t("gems_hint")}</span>`;
  const rows = [
    bal,
    premiumRow("🧾", t("prem_autoreg"), t("prem_autoreg_sub"),
      costs.auto_register_cost, game.hasAutoRegister(), () => { if (game.buyAutoRegister()) gemStoreModal(); }),
    premiumRow("⏩", t("prem_x2"), t("prem_x2_sub"),
      costs.offline_x2_cost, game.hasOfflineX2(), () => { if (game.buyOfflineX2()) gemStoreModal(); }),
    hintRow(t("gems_speed_hint")),
  ];
  closeModal = modal(t("gems_title"), rows);
}

// Replay the onboarding coach from step 1 (kept next to reset so testers/curious
// players can revisit the how-to-play). Jumps to the garden where step 1 begins.
function replayTutorialRow() {
  const btn = document.createElement("button");
  btn.className = "ad-double-btn";
  btn.textContent = t("tutorial_replay");
  btn.onclick = () => {
    game.resetTutorial();
    closeModal();
    setScreen("garden");
    coach.restart();
  };
  return btn;
}

// Settings: everything that isn't a purchase. Lives behind its own ⚙️ button so
// the gem store stays about gems — mixing "buy this" with "delete everything"
// in one sheet was asking for a mis-tap.
function settingsModal() {
  const rows = [languageRow(), replayTutorialRow()];
  // Rules of conduct + privacy policy have to be reachable from inside the app:
  // App Review 1.2 wants the rules wherever players can see each other's names,
  // and 5.1.1 wants the policy. Both are served by the backend worker.
  if (backend.enabled()) rows.push(linkRow("📜", t("terms_label"), backend.termsUrl()));
  rows.push(linkRow("🔒", t("privacy_label"), backend.privacyUrl()));
  rows.push(linkRow("💬", t("support_label"), backend.supportUrl()));
  // Google requires a standing way back into the consent choices, but only for
  // players who were asked in the first place (EU/UK).
  if (ads.privacyOptionsRequired()) {
    rows.push(actionRow("📢", t("ad_settings_label"), () => ads.showPrivacyOptions()));
  }
  rows.push(resetRow());
  closeModal = modal(t("settings_title"), rows);
}

function linkRow(icon, label, url) {
  return actionRow(icon, label, () => tgApi.openLink(url));
}

function actionRow(icon, label, onTap) {
  const row = div("opt");
  row.innerHTML = `<span class="opt-ic">${icon}</span>
    <span class="opt-main"><span class="opt-name">${label}</span></span>
    <span class="opt-chevron">›</span>`;
  row.style.cursor = "pointer";
  row.onclick = onTap;
  return row;
}

export function initSettings() {
  const btn = document.getElementById("settings-btn");
  if (btn) btn.addEventListener("click", settingsModal);
}

// Manual language override. Auto-detection is right most of the time, but a
// player on an English phone who wants Russian (or the reverse) has no other way
// to say so — and on iOS the device language can't be changed per app.
const LANG_NAMES = { ru: "Русский", en: "English" };

function languageRow() {
  const row = div("opt");
  row.innerHTML = `<span class="opt-ic">🌐</span>
    <span class="opt-main"><span class="opt-name">${t("language_label")}</span></span>`;
  const group = div("lang-group");
  SUPPORTED.forEach((code) => {
    const b = document.createElement("button");
    b.className = "lang-btn" + (getLocale() === code ? " is-active" : "");
    b.textContent = LANG_NAMES[code] || code;
    b.onclick = () => {
      if (getLocale() === code) return;
      chooseLocale(code);
      settingsModal(); // rebuild the modal in the new language
    };
    group.appendChild(b);
  });
  row.appendChild(group);
  return row;
}

function resetRow() {
  const btn = document.createElement("button");
  btn.className = "danger-btn";
  btn.textContent = t("reset_progress");
  const closes = tgApi.PLATFORM === "telegram"; // only there can we actually close
  btn.onclick = () => tgApi.confirmDialog(t(closes ? "reset_confirm" : "reset_confirm_static"), async () => {
    btn.disabled = true;
    // False means the server refused or was unreachable — say so rather than
    // leave the player thinking their data is gone.
    if (!(await game.resetProgress())) {
      btn.disabled = false;
      toast(t("reset_failed"), 3000);
      return;
    }
    coach.clearProgress(); // how far onboarding got is progress too
    showAccountDeleted();
  });
  return btn;
}

// The end of the session, shown once the account is really gone.
//
// The game underneath is dead by now (no saving, no requests — see
// game.resetProgress), but it is still on screen and still tappable, and a
// player who keeps playing a deleted account has been lied to. So the screen is
// covered for good: in Telegram we then close the mini app, which is the only
// way to stop the page from re-registering the same Telegram user. iOS and the
// browser have no honest close — an app that quits itself reads as a crash — so
// there the dead end IS the answer, and the next launch starts a new account.
function showAccountDeleted() {
  const app = document.getElementById("app");
  if (app) app.setAttribute("aria-hidden", "true");
  const back = div("deleted-back");
  const card = div("deleted-card");
  const canClose = tgApi.PLATFORM === "telegram";
  card.innerHTML = `<span class="deleted-ic">🗑</span>
    <span class="deleted-title">${t("reset_done_title")}</span>
    <span class="deleted-sub">${t(canClose ? "reset_done_closing" : "reset_done_static")}</span>`;
  back.appendChild(card);
  document.body.appendChild(back);
  // Long enough to be read, short enough that nobody wonders if it hung.
  if (canClose) setTimeout(() => tgApi.close(), 2500);
}

function premiumRow(icon, name, sub, cost, owned, onBuy) {
  const row = div("opt");
  row.innerHTML = `<span class="opt-ic">${icon}</span>
    <span class="opt-main"><span class="opt-name">${name}</span><span class="opt-sub">${sub}</span></span>`;
  const btn = document.createElement("button");
  if (owned) { btn.className = "opt-lock"; btn.textContent = t("owned"); }
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

// Coins sheet: balance plus the rewarded-ad freebie. The ad used to be a banner
// pinned above the shop shelves, where it cost the shelves ~52px of height and
// was only reachable from that one screen. Behind the 🪙 counter it mirrors how
// 💎 opens the gem store, and works from anywhere.
export function initCoins() {
  const btn = document.getElementById("coins-btn");
  if (btn) btn.addEventListener("click", coinsModal);
}

function coinsModal() {
  const bal = div("gem-balance");
  bal.innerHTML = `<span class="gem-big">🪙 ${fmtNum(state.coins)}</span>
    <span class="hint">${t("coins_hint")}</span>`;
  closeModal = modal(t("coins_title"), [bal, adBonusRow()]);
}

// One row, three states: ready to watch, on cooldown, hourly cap spent.
function adBonusRow() {
  const row = div("opt");
  const ready = game.coinBonusReady();
  const capped = game.adsLeftThisHour() <= 0;
  const sub = ready ? t("ad_bonus_sub")
    : capped ? t("ad_hour_limit")
    : t("ad_in", { time: fmtDuration(game.coinBonusCooldownLeft()) });
  row.innerHTML = `<span class="opt-ic">📺</span>
    <span class="opt-main"><span class="opt-name">${t("ad_watch")}</span>
    <span class="opt-sub">${sub}</span></span>`;
  const btn = document.createElement("button");
  if (!ready) { btn.className = "opt-lock"; btn.textContent = capped ? "⏳" : "…"; }
  else {
    btn.className = "opt-btn";
    btn.textContent = `+${fmtNum(game.coinBonusAmount())} 🪙`;
    btn.onclick = async () => {
      btn.disabled = true;
      const amt = await game.watchCoinBonus();
      if (amt > 0) toast(`+${fmtNum(amt)} 🪙`);
      closeModal();
      render();
    };
  }
  row.appendChild(btn);
  return row;
}

// ── Phase 4: leaderboard + display name ──────────────────────────────────────

export function initBoard() {
  const btn = document.getElementById("board-btn");
  if (!btn) return;
  // Without a backend identity the modal can only say "unavailable", so drop the
  // button entirely rather than leave a dead end in the HUD. Comes back on iOS
  // with device-auth (Э3а in docs/IOS_PLAN.md).
  if (!tgApi.caps.leaderboard) { btn.remove(); return; }
  btn.addEventListener("click", leaderboardModal);
}

async function leaderboardModal() {
  // Loading placeholder while we fetch.
  const loading = div("opt opt-empty");
  loading.textContent = t("board_loading");
  closeModal = modal(t("board_title"), [loading]);

  const data = await backend.leaderboard(50);
  if (!data) { loading.textContent = t("board_offline"); return; }

  const rows = [];
  // Your own standing + a rename entry.
  const me = data.me || {};
  const meRow = div("board-me");
  meRow.innerHTML = `<span class="board-me-rank">#${me.rank || "—"}</span>
    <span class="board-me-name">${escapeHtml(playerName(me))}</span>
    <span class="board-me-stat">${t("board_me_stat", { lvl: me.level || 1, coins: fmtNum(me.coins || 0) })}</span>`;
  const rename = document.createElement("button");
  rename.className = "board-rename";
  rename.textContent = t("board_rename");
  rename.onclick = () => renameModal();
  meRow.appendChild(rename);
  rows.push(meRow);

  const top = data.top || [];
  if (!top.length) rows.push(emptyRow(t("board_empty")));
  top.forEach((r) => {
    const row = div("board-row" + (r.me ? " board-row-me" : ""));
    const medal = r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : "";
    row.innerHTML = `<span class="board-rank">${medal || r.rank}</span>
      <span class="board-name">${escapeHtml(playerName(r))}</span>
      <span class="board-lvl">${t("cell_level", { n: r.level })}</span>
      <span class="board-coins">${fmtNum(r.coins)} 🪙</span>`;
    // Everyone but you gets a report/block entry point (App Review 1.2). The
    // server withholds `pid` for your own row, so this can't target yourself.
    if (r.pid) {
      const more = document.createElement("button");
      more.className = "board-more";
      more.textContent = "⋯";
      more.title = t("mod_title");
      more.onclick = (e) => { e.stopPropagation(); playerActionsModal(r); };
      row.appendChild(more);
    }
    rows.push(row);
  });
  // Re-render the sheet with the loaded data.
  closeModal = modal(t("board_title"), rows);
}

// One-time intro shown after the player is assigned a generated name. Offers to
// keep it or rename. Both paths acknowledge server-side so it won't show again.
export function showNameIntro() {
  const name = playerName(game.profile);
  const info = div("upgrade-info");
  info.innerHTML = `<p style="font-size:40px;text-align:center;margin:0">🏆</p>
    <p style="text-align:center;font-size:15px;margin:8px 0 2px">${t("name_intro_head")}</p>
    <p style="text-align:center;color:var(--tg-hint);font-size:13px;margin:2px 0">${t("name_intro_sub")}</p>
    <p style="text-align:center;font-size:22px;font-weight:800;margin:4px 0">${escapeHtml(name)}</p>
    <p style="text-align:center;color:var(--tg-hint);font-size:12px;margin:2px 0">${t("name_intro_note")}</p>`;
  const keep = document.createElement("button");
  keep.className = "big-btn";
  keep.textContent = t("name_keep");
  keep.onclick = () => { backend.setName(""); game.setLocalName(null, true); closeModal(); };
  const change = document.createElement("button");
  change.className = "ad-double-btn";
  change.textContent = t("board_rename");
  change.onclick = () => renameModal();
  closeModal = modal(t("name_intro_title"), [info, change, keep]);
}

function renameModal() {
  const info = div("upgrade-info");
  info.innerHTML = `<p style="text-align:center;color:var(--tg-hint);font-size:13px;margin:2px 0 8px">${t("rename_hint")}</p>`;
  const input = document.createElement("input");
  input.className = "name-input";
  input.type = "text";
  input.maxLength = 24;
  input.value = game.profile.displayName || "";
  input.placeholder = t("rename_placeholder");
  info.appendChild(input);

  const save = document.createElement("button");
  save.className = "big-btn";
  save.textContent = t("rename_save");
  save.onclick = async () => {
    const name = input.value.trim();
    if (!name) { toast(t("rename_empty")); return; }
    save.disabled = true;
    const res = await backend.setName(name);
    if (res && res.ok) {
      game.setLocalName(res.displayName || name, true);
      toast(t("rename_done"));
      closeModal();
    } else {
      save.disabled = false;
      // The server filters names (profanity, impersonation) — say which it was,
      // otherwise a rejected rename looks like the game is simply broken.
      const why = res && res.error;
      toast(t(why === "profanity" ? "rename_bad" : why === "reserved" ? "rename_reserved" : "rename_failed"), 3000);
    }
  };
  closeModal = modal(t("rename_title"), [info, save]);
}

// Report / block, offered on every leaderboard row but your own. Required by App
// Review 1.2 for an app that shows names other players typed.
function playerActionsModal(row) {
  const who = playerName(row);
  const info = div("upgrade-info");
  info.innerHTML = `<p style="text-align:center;font-size:15px;font-weight:700;margin:2px 0">${escapeHtml(who)}</p>
    <p style="text-align:center;color:var(--tg-hint);font-size:12.5px;margin:4px 0 0">${t("mod_hint")}</p>`;

  const report = document.createElement("button");
  report.className = "ad-double-btn";
  report.textContent = t("mod_report");
  report.onclick = async () => {
    report.disabled = true;
    const ok = await backend.reportPlayer(row.pid, "");
    toast(t(ok ? "mod_report_done" : "mod_failed"), 3000);
    if (ok) closeModal();
    else report.disabled = false;
  };

  const block = document.createElement("button");
  block.className = "danger-btn";
  block.textContent = t("mod_block");
  block.onclick = () => tgApi.confirmDialog(t("mod_block_confirm", { name: who }), async () => {
    const ok = await backend.blockPlayer(row.pid, true);
    if (!ok) { toast(t("mod_failed"), 3000); return; }
    toast(t("mod_block_done"), 3000);
    closeModal();
    leaderboardModal(); // rebuild without them
  });

  closeModal = modal(t("mod_title"), [info, report, block]);
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
  if (!s) return t("reward_generic");
  const parts = [];
  if (s.coins) parts.push(`+${fmtNum(s.coins)} 🪙`);
  if (s.xp) parts.push(`+${s.xp} XP`);
  if (s.gems) parts.push(`+${s.gems} 💎`);
  if (s.dishes && s.dishItem) { const d = econ.itemDef(s.dishItem); parts.push(`+${s.dishes} ${d ? d.icon : "🍽"}`); }
  return parts.join("  ") || t("reward_generic");
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
  label.innerHTML = `<span class="daily-fire">${tp("daily_streak", streak)}</span>` +
    `<span class="daily-quality" title="${t("daily_quality_title")}">${t("daily_quality", { q: quality })}</span>`;
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

function dailyTaskRow(task, i) {
  // Sequential chain: a task stays locked until every earlier one is completed.
  if (i > 0 && !game.dailyTaskUnlocked(i)) {
    const row = div("daily-task daily-task-locked");
    const main = div("daily-task-main");
    main.innerHTML = `<span class="daily-task-lbl">${t("daily_locked", { n: i + 1 })}</span>
      <span class="daily-task-prog">${t("daily_locked_hint")}</span>`;
    row.appendChild(main);
    const lock = document.createElement("span");
    lock.className = "daily-claim"; lock.textContent = "🔒";
    row.appendChild(lock);
    return row;
  }
  const done = game.dailyTaskDone(task);
  const row = div("daily-task" + (task.claimed ? " daily-task-claimed" : done ? " daily-task-done" : ""));
  const main = div("daily-task-main");
  if (task.claimed) {
    // Already claimed: show exactly WHAT was received on the row (persisted), so a
    // missed toast doesn't matter. Reward is never shown before claiming.
    // With a reward recorded: "Получено: +40 🪙 +12 XP". Without one (a save from
    // before `granted` was persisted) the generic string stands alone — wrapping
    // it in the same template reads as "Получено: Награда получена".
    const got = task.granted
      ? t("daily_got", { reward: dailyRewardStr(task.granted) })
      : t("reward_generic");
    main.innerHTML = `<span class="daily-task-lbl">${game.dailyTaskLabel(task)}</span>
      <span class="daily-got">${got}</span>`;
  } else {
    const pct = Math.min(100, Math.round(((task.progress || 0) / task.goal) * 100));
    main.innerHTML = `<span class="daily-task-lbl">${game.dailyTaskLabel(task)}</span>
      <div class="daily-bar"><div class="daily-fill" style="width:${pct}%"></div></div>
      <span class="daily-task-prog">${Math.min(task.progress || 0, task.goal)} / ${task.goal}</span>`;
  }
  row.appendChild(main);

  const btn = document.createElement("button");
  if (task.claimed) { btn.className = "daily-claim claimed"; btn.textContent = "✓"; btn.disabled = true; }
  else if (done) {
    btn.className = "daily-claim ready"; btn.textContent = t("daily_claim");
    btn.onclick = async () => {
      btn.disabled = true;
      const r = await game.claimDailyTask(task.id);
      if (r) toast(dailyRewardStr(r), 2500);
      dailyModal(); // rebuild — the row now shows the received reward
    };
  } else { btn.className = "daily-claim"; btn.textContent = `${Math.min(task.progress || 0, task.goal)}/${task.goal}`; btn.disabled = true; }
  row.appendChild(btn);
  return row;
}

function dailyModal() {
  const rows = [streakCalendar()];
  const tasks = game.dailyTasks();
  if (!tasks.length) rows.push(emptyRow(t("daily_empty")));
  tasks.forEach((task, i) => rows.push(dailyTaskRow(task, i)));

  if (game.dailyChestIsSuper()) {
    rows.push(hintRow(t("daily_super_hint")));
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
    got.innerHTML = `<span class="daily-got">🎁 ${tier ? t("chest_super_prefix", { stars: "★".repeat(tier) }) : ""}${dailyRewardStr(game.dailyChestGranted())}</span>`;
    rows.push(got);
  }

  const chest = document.createElement("button");
  chest.id = "daily-chest-btn";
  paintDailyChest(chest);
  rows.push(chest);

  closeModal = modal(t("daily_title"), rows);
}

let claimingChest = false;

// Paint the chest button for the current state (called on build + every ticker
// tick so the cooldown counts down and the button re-enables live).
function paintDailyChest(btn) {
  if (claimingChest) {
    btn.className = "big-btn daily-chest"; btn.disabled = true; btn.onclick = null;
    btn.textContent = t("chest_ad_loading"); return;
  }
  const count = game.dailyChestCount();
  const isSuper = game.dailyChestIsSuper();
  btn.className = "big-btn daily-chest" + (isSuper ? " daily-chest-super" : "");
  if (game.dailyChestReady()) {
    btn.disabled = false;
    btn.textContent = count === 0
      ? (isSuper ? t("chest_watch_super") : t("chest_watch"))
      : t("chest_more");
    btn.onclick = onClaimChest;
  } else {
    btn.disabled = true; btn.onclick = null;
    if (game.adsLeftThisHour() <= 0) btn.textContent = t("chest_ad_limit");
    else btn.textContent = t("chest_cooldown", { time: fmtClock(game.dailyChestCooldownLeft()) });
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
    toast(r.superTier ? t("chest_super_toast", { stars: "★".repeat(r.superTier), body }) : t("chest_toast", { body }), 2800);
    // A claimed chest on a running streak is the best moment we get: the player
    // just came back and was handed something. review.js owns every other rule
    // and is a no-op outside iOS. Deliberately not awaited — the rating sheet
    // must never delay the reward toast.
    review.maybeAsk(state);
  }
  dailyModal(); // rebuild — updates the chest-count status + reward line
}

function chestCountText(n) {
  if (n === 0) return t("chest_none");
  return tp("chest_count", n);
}
function fmtClock(s) { const m = Math.floor(s / 60), ss = s % 60; return `${m}:${String(ss).padStart(2, "0")}`; }

// ── Tickers ──────────────────────────────────────────────────────────────────

let nextSpawnAt = 0;
let nextAutoServeAt = 0;

export function startTicker() {
  nextSpawnAt = Date.now() + econ.npcSpawnInterval(state.shop) * 1000;
  // Paying a customer is a tap on the customer now, and that tap is owned by the
  // floor overlay — so the floor tells us when it happened.
  shopfloor.onServe((gain) => { toast(`+${fmtNum(gain)} 🪙`); coach.signal("served"); });
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
    // The ad's cooldown ends silently, so refresh its dot on the HUD.
    const coinsDot = document.getElementById("coins-dot");
    if (coinsDot) coinsDot.hidden = !game.coinBonusReady();
    const chestBtn = document.getElementById("daily-chest-btn");
    if (chestBtn) paintDailyChest(chestBtn); // live cooldown countdown / re-enable
    coach.reposition(); // keep onboarding marks glued to their moving anchors
  }, 500);
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
    <p style="text-align:center;font-size:22px;font-weight:800;margin:4px 0">${t("levelup_head", { n: level })}</p>
    <p style="text-align:center;color:var(--tg-hint);font-size:13px;margin:2px 0">${t("levelup_sub", { n: level })}</p>`;
  if (unlocks.length) {
    html += `<p style="text-align:center;color:var(--tg-hint);font-size:13px;margin:6px 0 2px">${t("levelup_unlocks", { n: level })}</p>
      <div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center">${
        unlocks.map((u) => `<span class="unlock-chip">${u.icon} ${itemName(u)}</span>`).join("")}</div>`;
  }
  info.innerHTML = html;
  const btn = document.createElement("button");
  btn.className = "big-btn"; btn.textContent = t("levelup_btn");
  btn.onclick = () => closeModal();
  closeModal = modal(t("levelup_title"), [info, btn]);
}

export function showOfflineReport() {
  if (!game.offlineReport) return;
  const { earned, sold, queued, x2 } = game.offlineReport;
  game.clearOfflineReport();
  const info = div("upgrade-info");
  let btnText = t("offline_ok");
  let onOk = () => closeModal();
  if (queued) {
    // Default mode: customers lined up while away — the player collects.
    info.innerHTML = `<p style="font-size:40px;text-align:center">🧾🛎️</p>
      <p style="text-align:center">${tp("offline_queue", queued)}</p>
      <p style="text-align:center;color:var(--tg-hint);font-size:13px">${t("offline_go_shop_hint")}</p>`;
    btnText = t("offline_go_shop");
    onOk = () => { closeModal(); setScreen("shop"); };
  } else {
    info.innerHTML = `<p style="font-size:40px;text-align:center">🛒💤</p>
      <p style="text-align:center">${tp("offline_sold", sold)}</p>
      <p style="text-align:center;font-size:24px;font-weight:800;color:var(--gold)">+${fmtNum(earned)} 🪙${x2 ? ` <span style='font-size:13px;color:var(--tg-hint)'>${t("offline_x2_badge")}</span>` : ""}</p>`;
  }
  // There used to be an "watch an ad to double this" button here. Removed: the
  // payout it doubled only exists for players who bought the auto-register perk
  // AND stayed away long enough, so almost nobody ever saw it — a placement that
  // rare isn't worth an ad unit or the code that keeps it honest.
  const rows = [info];
  const btn = document.createElement("button");
  btn.className = "big-btn"; btn.textContent = btnText;
  btn.onclick = onOk;
  rows.push(btn);
  closeModal = modal(t("offline_title"), rows);
}

export function initBag() {
  document.getElementById("bag-btn").addEventListener("click", () => { coach.signal("bag"); inventoryModal(); });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function bump(el) { el.classList.remove("shake"); void el.offsetWidth; el.classList.add("shake"); }
function div(cls) { const d = document.createElement("div"); d.className = cls; return d; }
