// Adsgram — the rewarded/interstitial provider inside Telegram.
//
// Moved here verbatim from ads.js when AdMob joined for iOS; the rules and block
// ids are unchanged. ads.js now picks a provider and owns the shared contract.

import { profile } from "./profile.js";

// Block ids come from profile.js: Adsgram blocks belong to one mini app, so
// each game has its own. Grow Sell's block 38599 is a **Reward** (rewarded
// video) block, so it's passed as the bare numeric id — NO prefix. The "int-"
// prefix is only for Interstitial-type blocks (passing "int-38599" makes the SDK
// reject it: "block type Reward, wrong prefix int-"). A "task-*" id is yet another
// product (the <adsgram-task> web component), not this AdController.show() flow.
const COIN_BLOCK_ID = profile.adsgram ? profile.adsgram.coins : null;

// A second **Reward** block, gating the daily-chest claim (same kind as 38599, so
// also a bare numeric id — no "int-" prefix). Kept separate so its fill/analytics
// are tracked apart from the coin-bonus block.
const DAILY_CHEST_BLOCK_ID = profile.adsgram ? profile.adsgram.daily_chest : null;

// Interstitial (full-screen, no reward) block — interstitial ids keep the "int-"
// prefix, unlike the Reward blocks above.
const INTERSTITIAL_BLOCK_ID = profile.adsgram ? profile.adsgram.interstitial : null;

// Which block backs each placement. Everything outside this file talks in
// placements; block ids never leave the provider.
const BLOCKS = {
  coins: COIN_BLOCK_ID,
  skip: COIN_BLOCK_ID,
  offline: COIN_BLOCK_ID,
  daily_chest: DAILY_CHEST_BLOCK_ID,
};

const controllers = {}; // one AdController per block id
let interstitial = null;

function getController(blockId) {
  if (!blockId) return null;
  if (controllers[blockId]) return controllers[blockId];
  if (window.Adsgram) {
    try { controllers[blockId] = window.Adsgram.init({ blockId }); } catch (_) {}
  }
  return controllers[blockId] || null;
}

// Inject the Adsgram SDK once.
export function init() {
  if (document.getElementById("adsgram-sdk")) return;
  const s = document.createElement("script");
  s.id = "adsgram-sdk";
  s.src = "https://sad.adsgram.ai/js/sad.min.js";
  document.head.appendChild(s);
}

// "skipped" only when the PLAYER cut the ad short — no reward, their choice.
// When Adsgram itself has nothing to show (no fill, a block still in
// moderation, a load error) it reports error: true, and that is
// "unavailable": the caller grants the reward anyway, as everywhere else in
// the game. It used to be "skipped" too, and that is how a deleted platform
// and a block under review left every rewarded button — the daily chest
// included — giving nothing at all (2026-10-21).
export async function showRewarded(placement) {
  // A game without its own blocks yet (see profile.js) is the one exception:
  // there is no ad to show, so say so and let the caller grant the reward.
  if (!profile.adsgram) return "unavailable";
  const ctrl = getController(BLOCKS[placement] || COIN_BLOCK_ID);
  if (!ctrl) return "unavailable";   // SDK not loaded (blocked, offline)
  try {
    await ctrl.show(); // resolves on a completed view, rejects otherwise
    return "rewarded";
  } catch (e) {
    // ShowPromiseResult: { done, description, state, error }
    return e && e.error ? "unavailable" : "skipped";
  }
}

// Fire-and-forget: never blocks or rewards gameplay, stays silent without fill.
export async function showInterstitial() {
  if (!INTERSTITIAL_BLOCK_ID) return;
  if (!interstitial && window.Adsgram) {
    try { interstitial = window.Adsgram.init({ blockId: INTERSTITIAL_BLOCK_ID }); } catch (_) {}
  }
  if (!interstitial) return;
  try { await interstitial.show(); } catch (_) { /* no fill / closed — ignore */ }
}
