// Rewarded ads — client seam (Phase B, see docs/MONETIZATION.md).
//
// The reward is granted only after a full view. Real ads come from Adsgram
// (client-side SDK, no backend): register at adsgram.ai, get a block id, and set
// ADSGRAM_BLOCK_ID below. The SDK is injected lazily and ONLY when a block id is
// configured — until then no third-party ad script loads at all.
//
// With no block id:
//   • a self-contained "demo ad" overlay plays (a short countdown) so every
//     rewarded feature stays fully testable in dev and in Telegram.
//
// showRewarded() resolves true when the reward should be granted, false if the
// view was skipped/closed early or the ad failed.

// Block id from the Adsgram dashboard. Our block 38599 is a **Reward** (rewarded
// video) block, so it's passed as the bare numeric id — NO prefix. The "int-"
// prefix is only for Interstitial-type blocks (passing "int-38599" makes the SDK
// reject it: "block type Reward, wrong prefix int-"). A "task-*" id is yet another
// product (the <adsgram-task> web component), not this AdController.show() flow.
export const ADSGRAM_BLOCK_ID = "38599";

// A second **Reward** block, gating the daily-chest claim (same kind as 38599, so
// also a bare numeric id — no "int-" prefix). Kept separate so its fill/analytics
// are tracked apart from the coin-bonus block.
export const DAILY_CHEST_BLOCK_ID = "39476";

// Interstitial (full-screen, no reward) block — shown at natural breaks like a
// level-up. Interstitial ids keep the "int-" prefix (unlike the Reward block).
export const INTERSTITIAL_BLOCK_ID = "int-39242";

const controllers = {}; // one AdController per rewarded block id
let interstitial = null;

function getController(blockId) {
  const id = blockId || ADSGRAM_BLOCK_ID;
  if (!id) return null;
  if (controllers[id]) return controllers[id];
  if (window.Adsgram) {
    try { controllers[id] = window.Adsgram.init({ blockId: id }); } catch (_) {}
  }
  return controllers[id] || null;
}

// Inject the Adsgram SDK once, only if monetization is actually configured.
export function initAds() {
  if (!ADSGRAM_BLOCK_ID || document.getElementById("adsgram-sdk")) return;
  const s = document.createElement("script");
  s.id = "adsgram-sdk";
  s.src = "https://sad.adsgram.ai/js/sad.min.js";
  document.head.appendChild(s);
}

// Show an interstitial (full-screen, no reward). Fire-and-forget: never blocks or
// rewards gameplay, and stays silent if the SDK/block isn't available (e.g. in a
// browser outside Telegram) — no demo overlay, since there's nothing to grant.
function getInterstitial() {
  if (interstitial) return interstitial;
  if (INTERSTITIAL_BLOCK_ID && window.Adsgram) {
    try { interstitial = window.Adsgram.init({ blockId: INTERSTITIAL_BLOCK_ID }); } catch (_) {}
  }
  return interstitial;
}
export async function showInterstitial() {
  const ctrl = getInterstitial();
  if (!ctrl) return;
  try { await ctrl.show(); } catch (_) { /* no fill / closed / error — ignore */ }
}

// Show a rewarded ad for `placement` (used only for logging/labels). Resolves to
// whether the reward is earned.
export async function showRewarded(placement, blockId) {
  // Configured: only ever grant on a real, completed view. If the SDK hasn't
  // loaded (or a show fails/was skipped), grant nothing — never fall back to the
  // demo, or a blocked SDK would mint free rewards.
  const id = blockId || ADSGRAM_BLOCK_ID;
  if (id) {
    const ctrl = getController(id);
    if (!ctrl) return false;
    try {
      await ctrl.show(); // resolves on a completed view, rejects otherwise
      return true;
    } catch (_) {
      return false;
    }
  }
  // No block id → self-contained demo so reward flows stay testable in dev.
  return demoAd(placement);
}

// Self-contained placeholder "ad": a 3-second countdown overlay the player can
// skip (✕ → no reward). Keeps the reward flows testable without an ad network.
function demoAd() {
  return new Promise((resolve) => {
    let left = 3;
    const back = document.createElement("div");
    back.className = "ad-back";
    const card = document.createElement("div");
    card.className = "ad-card";
    const x = document.createElement("button");
    x.className = "ad-skip"; x.textContent = "✕";
    card.appendChild(x);
    const body = document.createElement("div");
    body.className = "ad-body";
    card.appendChild(body);
    back.appendChild(card);
    document.body.appendChild(back);

    const paint = () => {
      body.innerHTML = `<div class="ad-badge">DEMO AD</div>
        <div class="ad-count">${left}</div>
        <div class="ad-hint">Реклама-заглушка. Награда — после просмотра.</div>`;
    };
    paint();
    let done = false;
    const finish = (ok) => {
      if (done) return; done = true;
      clearInterval(t); back.remove(); resolve(ok);
    };
    x.onclick = () => finish(false);
    const t = setInterval(() => {
      left -= 1;
      if (left <= 0) { finish(true); return; }
      paint();
    }, 1000);
  });
}
