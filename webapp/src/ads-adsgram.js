// Adsgram — the rewarded/interstitial provider inside Telegram.
//
// Moved here verbatim from ads.js when AdMob joined for iOS; the rules and block
// ids are unchanged. ads.js now picks a provider and owns the shared contract.

// Block id from the Adsgram dashboard. Our block 38599 is a **Reward** (rewarded
// video) block, so it's passed as the bare numeric id — NO prefix. The "int-"
// prefix is only for Interstitial-type blocks (passing "int-38599" makes the SDK
// reject it: "block type Reward, wrong prefix int-"). A "task-*" id is yet another
// product (the <adsgram-task> web component), not this AdController.show() flow.
const COIN_BLOCK_ID = "38599";

// A second **Reward** block, gating the daily-chest claim (same kind as 38599, so
// also a bare numeric id — no "int-" prefix). Kept separate so its fill/analytics
// are tracked apart from the coin-bonus block.
const DAILY_CHEST_BLOCK_ID = "39476";

// Interstitial (full-screen, no reward) block — interstitial ids keep the "int-"
// prefix, unlike the Reward blocks above.
const INTERSTITIAL_BLOCK_ID = "int-39242";

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

// Never returns "unavailable": Telegram behaviour must stay exactly as it was,
// so a missing SDK or an empty block is reported as a plain no-reward. The
// no-ad fallback therefore never fires in the mini app.
export async function showRewarded(placement) {
  const ctrl = getController(BLOCKS[placement] || COIN_BLOCK_ID);
  if (!ctrl) return "skipped";
  try {
    await ctrl.show(); // resolves on a completed view, rejects otherwise
    return "rewarded";
  } catch (_) {
    return "skipped";
  }
}

// Fire-and-forget: never blocks or rewards gameplay, stays silent without fill.
export async function showInterstitial() {
  if (!interstitial && window.Adsgram) {
    try { interstitial = window.Adsgram.init({ blockId: INTERSTITIAL_BLOCK_ID }); } catch (_) {}
  }
  if (!interstitial) return;
  try { await interstitial.show(); } catch (_) { /* no fill / closed — ignore */ }
}
