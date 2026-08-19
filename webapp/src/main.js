// Boot: init Telegram, load shared data + save, wire navigation, first render.

import * as tg from "./platform.js";
import * as ads from "./ads.js";
import { loadData } from "./data.js";
import * as game from "./game.js";
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
    return;
  }
  await game.load();
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

  render();
  startTicker();

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

boot();
