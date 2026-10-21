// Rewarded + interstitial ads — one contract, one provider per host.
//
//   Telegram → Adsgram   (ads-adsgram.js)
//   iOS      → AdMob     (ads-admob.js)
//   browser  → a demo overlay, so reward flows stay testable in local dev
//
// showRewarded(placement) resolves to one of three statuses — the distinction
// between the last two is the whole point:
//
//   "rewarded"     the video was watched through → grant.
//   "skipped"      the player closed it early → grant NOTHING. Nothing else
//                  guards the rewards: there is no server-side view
//                  verification yet (AdMob supports SSV; wiring it is a
//                  follow-up), so a provider that reported this as success
//                  would mint free coins.
//   "unavailable"  no ad could be shown at all — no fill, failed load, SDK not
//                  ready. The player did nothing wrong, so callers grant the
//                  reward anyway. This matters most right after launch: AdMob
//                  serves almost nothing until the app is linked to its App
//                  Store listing, which can only happen after publishing, and
//                  without this the daily chest would be unopenable — for early
//                  players and for the App Review tester alike.
//
// Placements: coins | skip | offline | daily_chest. Each provider maps them to
// its own block/unit ids, which never leak outside the provider module.
//
// The caps and cooldowns behind these rewards are enforced server-side in
// backend/src/sim.js, identically for every platform.

import { caps, PLATFORM } from "./platform.js";
import * as flags from "./flags.js";
import * as adsgram from "./ads-adsgram.js";
import * as admob from "./ads-admob.js";
import { t } from "./i18n.js";

function provider() {
  if (PLATFORM === "telegram") return adsgram;
  if (PLATFORM === "ios") return admob;
  return demo;
}

export function initAds() {
  if (!caps.ads) return;
  const p = provider();
  if (p.init) p.init();
}

export const REWARDED = "rewarded";
export const SKIPPED = "skipped";
export const UNAVAILABLE = "unavailable";

export async function showRewarded(placement) {
  if (!caps.ads) return UNAVAILABLE;
  // Remote kill switch (ADS_ENABLED="0" on the worker). Reported as UNAVAILABLE
  // on purpose: the contract above already says the player gets the reward in
  // that case, so turning ads off degrades into a generous game rather than
  // into dead buttons and an unopenable daily chest.
  if (!flags.adsEnabled()) return UNAVAILABLE;
  return provider().showRewarded(placement);
}

export async function showInterstitial() {
  if (!caps.ads) return;
  if (!flags.adsEnabled()) return;
  return provider().showInterstitial();
}

// GDPR consent choices. Only AdMob has them (Adsgram handles consent inside
// Telegram), so everywhere else this is simply "nothing to offer".
export function privacyOptionsRequired() {
  const p = provider();
  return !!(p.privacyOptionsRequired && p.privacyOptionsRequired());
}

export async function showPrivacyOptions() {
  const p = provider();
  if (p.showPrivacyOptions) return p.showPrivacyOptions();
}

// ── demo provider (local dev only) ───────────────────────────────────────────
// A self-contained placeholder "ad": a 3-second countdown the player can skip
// (✕ → no reward). Never used in Telegram or on iOS.
const demo = {
  init() {},
  showInterstitial() {},
  showRewarded() {
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
          <div class="ad-hint">${t("ad_demo_hint")}</div>`;
      };
      paint();
      let done = false;
      const finish = (status) => {
        if (done) return; done = true;
        clearInterval(timer); back.remove(); resolve(status);
      };
      x.onclick = () => finish("skipped");
      const timer = setInterval(() => {
        left -= 1;
        if (left <= 0) { finish("rewarded"); return; }
        paint();
      }, 1000);
    });
  },
};
