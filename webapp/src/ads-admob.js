// Google AdMob — the rewarded/interstitial provider in the native iOS build.
//
// Reached through the Capacitor bridge (@capacitor-community/admob) rather than
// an npm import, like every other plugin here — the web app ships as plain ES
// modules with no bundler.
//
// The reward rule is the security-critical part: AdMob reports "user earned the
// reward" and "ad was dismissed" as two SEPARATE events, and showRewardVideoAd()
// can resolve even when the player closed the video early. So a reward counts
// only if the Rewarded event actually fired — never on the promise alone.

// Real units from the AdMob console (publisher pub-7943520600036469). Only two
// rewarded placements survive: the ad-to-skip-production offer was dropped (the
// whole wait is under a minute, so a 30s video is a worse deal than waiting) and
// so was the offline-double button (it needed the auto-register perk plus a long
// absence, so essentially nobody reached it).
const UNITS = {
  coins: "ca-app-pub-7943520600036469/3930806992",       // free coins, behind the 🪙 counter
  daily_chest: "ca-app-pub-7943520600036469/8799990297", // opens the daily chest
};
const INTERSTITIAL = "ca-app-pub-7943520600036469/3204194475"; // on level-up, from level 3

// Google's own test units, kept as the fallback for an unmapped placement — a
// real unit shown in a context Google didn't approve is worse than a test ad.
const TEST = {
  rewarded: "ca-app-pub-3940256099942544/1712485313",
  interstitial: "ca-app-pub-3940256099942544/4411468910",
};

// Test mode stays ON until the submission build. Watching your own live ads is a
// policy violation Google bans accounts for, so every device we develop and test
// on must keep getting test creatives even with the real unit ids above.
const IS_TESTING = false;

function plugin() {
  const cap = window.Capacitor;
  if (!cap) return null;
  if (cap.Plugins && cap.Plugins.AdMob) return cap.Plugins.AdMob;
  if (typeof cap.registerPlugin === "function") {
    try { return cap.registerPlugin("AdMob"); } catch (_) {}
  }
  return null;
}

let ready = false;
let rewardEarned = false;
// Whether this player must be offered a way back into the consent form (EU/UK).
// Read from the UMP SDK at startup; settings shows the entry point only if so.
let privacyOptions = "UNKNOWN";

// GDPR consent, gathered through Google's User Messaging Platform BEFORE the ads
// SDK starts: showing an EU player ads without asking breaks Google's consent
// policy. The messages themselves are configured in the AdMob console (Privacy
// & messaging) — no message there means no form is available, and this quietly
// does nothing.
//
// Deliberately fail-open: any error here leaves ads running non-personalised
// rather than taking the game's rewards down with it.
async function gatherConsent(admob) {
  if (!admob.requestConsentInfo) return;
  try {
    let info = await admob.requestConsentInfo();
    if (info.status === "REQUIRED" && info.isConsentFormAvailable) {
      info = await admob.showConsentForm();
    }
    privacyOptions = info.privacyOptionsRequirementStatus || "UNKNOWN";
  } catch (e) {
    console.warn("AdMob consent failed:", e);
  }
}

// Order matters: gather consent, then initialize, then ask for tracking
// permission. Requesting ATT before the SDK is up gets the prompt swallowed on
// some iOS versions.
export async function init() {
  const admob = plugin();
  if (!admob) return;
  try {
    await gatherConsent(admob);
    await admob.initialize({ initializeForTesting: IS_TESTING });
    // iOS 14+: without this the SDK can only serve non-personalized ads. A
    // refusal is fine — ads still work, they just pay less.
    if (admob.requestTrackingAuthorization) {
      try { await admob.requestTrackingAuthorization(); } catch (_) {}
    }
    // Latch the reward signal once; the listener outlives individual shows.
    if (admob.addListener) {
      admob.addListener("onRewardedVideoAdReward", () => { rewardEarned = true; });
    }
    ready = true;
  } catch (e) {
    console.warn("AdMob init failed:", e);
  }
}

export async function showRewarded(placement) {
  const admob = plugin();
  // No SDK at all counts as "we couldn't show one", not as a refusal.
  if (!admob || !ready) return "unavailable";
  const adId = UNITS[placement] || TEST.rewarded;

  rewardEarned = false;
  try {
    await admob.prepareRewardVideoAd({ adId, isTesting: IS_TESTING });
    await admob.showRewardVideoAd();
  } catch (_) {
    // Failing to load or to present is on us (no fill, network, bad unit id) —
    // the player never got the chance to watch.
    return "unavailable";
  }
  // Resolving is NOT enough: showRewardVideoAd() also resolves when the video
  // was closed early. Only the Rewarded event means it was watched through.
  return rewardEarned ? "rewarded" : "skipped";
}

// Google requires a standing entry point back into the consent choices wherever
// consent was required, so settings shows a row — but only for those players.
export function privacyOptionsRequired() { return privacyOptions === "REQUIRED"; }

export async function showPrivacyOptions() {
  const admob = plugin();
  if (!admob || !admob.showPrivacyOptionsForm) return;
  try { await admob.showPrivacyOptionsForm(); } catch (e) { console.warn("AdMob privacy form failed:", e); }
}

export async function showInterstitial() {
  const admob = plugin();
  if (!admob || !ready) return;
  try {
    await admob.prepareInterstitial({ adId: INTERSTITIAL || TEST.interstitial, isTesting: IS_TESTING });
    await admob.showInterstitial();
  } catch (_) { /* no fill / closed — never blocks gameplay */ }
}
