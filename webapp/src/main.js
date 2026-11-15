// Boot: init Telegram, load shared data + save, wire navigation, first render.

import * as tg from "./platform.js";
import * as ads from "./ads.js";
import { loadData, data } from "./data.js";
import * as art from "./art.js";
import * as game from "./game.js";
import * as backend from "./backend.js";
import { render, setScreen, startTicker, initBag, initGems, initCoins, initBoard, initDaily, maybeShowDaily, showOfflineReport, showLevelUp, showNameIntro, applyChrome, initSettings } from "./ui.js";
import * as coach from "./coach.js";
import { t, initLocale, onLocaleChange } from "./i18n.js";

async function boot() {
  // Awaited: on iOS this reads the account credential from the Keychain, and
  // game.load() below must not reach the backend before it exists.
  await tg.init();
  // Language before anything is drawn: the error path below is already localized.
  initLocale(tg.hostLanguage());
  applyChrome();
  onLocaleChange(() => { applyChrome(); render(); });
  ads.initAds();
  try {
    await loadData();
  } catch (e) {
    document.getElementById("screen").innerHTML =
      `<div class="screen-note">${t("data_load_error", { msg: e.message })}</div>`;
    // The splash is no longer taken down at startup, so this early return has to
    // take it down itself — otherwise a failed data load leaves the launch
    // screen up for good and the error behind it is never seen.
    tg.hideSplash();
    return;
  }
  // Games with their own art: item glyphs come from the gamedata, so register
  // them first, then start swapping emoji for pictures (no-op in Grow Sell).
  art.registerItems(data);
  art.start();
  // Returns as soon as there is something to draw; `settled` is the server's
  // say-so, which for a returning player lands a moment after the first frame.
  const booted = await game.load();
  game.subscribe(render);
  // On level-up: play the full-screen ad, then celebrate the new level. No ad on
  // the very first level-up (1→2) so onboarding isn't interrupted by an ad.
  game.subscribeLevelUp((lvl) => {
    const gate = lvl <= 2 ? Promise.resolve() : ads.showInterstitial();
    gate.finally(() => showLevelUp(lvl));
  });

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      tg.haptic("light");
      setScreen(tab.dataset.screen);
    });
  });
  initBag();
  initGems();
  initCoins();
  initBoard();
  initDaily();
  initSettings();

  // Returning from the background is treated like a small re-load: catch the
  // world up, redraw, and show the welcome-back summary if time had passed.
  tg.onResume(async () => {
    await game.onResume();
    render();
    showOfflineReport();
  });

  // Going the other way, hand over anything still buffered. Taps are batched for
  // a few seconds before they are sent (see backend.js), and iOS suspends the
  // WKWebView on the way out — without this, the last few seconds of play would
  // be lost every time the player switches apps, which is most of the time.
  tg.onPause(() => { backend.flushNow(); });

  render();
  // Only now does the launch screen come down: behind it is the player's real
  // shop rather than the empty HUD shell. On iOS launchAutoHide is off, so this
  // is the only thing that dismisses it (see hideSplash in ios.js).
  tg.hideSplash();
  startTicker();

  // Everything below decides what MODAL to open, and each answer depends on
  // server truth: whether onboarding is done, whether time passed while away,
  // whether the leaderboard name was ever acknowledged. The game is interactive
  // already, so waiting here costs nothing visible — and asking too early is how
  // you replay onboarding over somebody's real account.
  // Swallowed on purpose: a failed reconcile is not a reason to skip onboarding
  // or the welcome-back summary. The poll will catch up on its own, and the
  // outer catch below is for boot failing, not for the network being flaky.
  await booted.settled.catch(() => {});
  render();

  if (game.isNewPlayer()) {
    coach.start();
  } else {
    // One modal at a time: the offline report wins this session if present;
    // otherwise the one-time leaderboard-name intro; otherwise the daily prompt.
    const hadReport = !!game.offlineReport;
    showOfflineReport();
    const showedIntro = !hadReport && game.profile.loaded && !game.profile.nameSeen;
    if (showedIntro) showNameIntro();
    if (!hadReport && !showedIntro) maybeShowDaily();
  }
}

// Nothing may leave the launch screen up. It is dismissed by us now (iOS sets
// launchAutoHide: false), so an unexpected throw anywhere in boot() would
// otherwise freeze the app on the splash with no way to tell what happened —
// the failure mode is indistinguishable from a hang, and on a store build it is
// unreportable. Surface the error instead.
boot().catch((e) => {
  console.error("boot failed:", e);
  const screen = document.getElementById("screen");
  if (screen) {
    screen.innerHTML = `<div class="screen-note">${t("data_load_error", { msg: String((e && e.message) || e) })}</div>`;
  }
  tg.hideSplash();
});
