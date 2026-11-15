// Which game this page is. One engine runs two games: Grow Sell (garden →
// kitchen → shop) and MineSell (mine → forge → shop) — same rules, same
// balance, other names, art, server and bot. See docs/MINESELL_PLAN.md.
//
// Chosen once at load, in this order:
//   1. window.GAME, set by the page that boots us (the iOS bundle bakes it in);
//   2. ?game=… in the URL (how the Telegram bot's menu button picks MineSell);
//   3. Grow Sell.
// Grow Sell's profile is "everything as it was": no prefix on storage keys, no
// art, no theme — so with no game named nothing about Grow Sell changes.
//
// Everything that belongs to one game only sits in a folder named after it:
// shared/<game>/gamedata, webapp/games/<game>/ (art, theme), art/<game>/
// (what the pictures are generated from). The engine around it is common.
//
// The internal screen ids stay garden/kitchen/shop for every game. They are in
// the action protocol, the saves and the server, and renaming them would buy
// the player nothing; MineSell's "garden" is simply called "Шахта" on screen.

const PROFILES = {
  growsell: {
    id: "growsell",
    backendUrl: "https://growsell.v23labs.com",
    gamedataBase: "../shared/growsell/gamedata/",
    storagePrefix: "",
    art: null,
    theme: null,
    // Adsgram blocks belong to one mini app, so each game has its own.
    // Platform 52431 (GSApp). The first platform (blocks 38599 / 39476 /
    // int-39242) was deleted when the mini app moved to its own domain.
    adsgram: { coins: "55325", daily_chest: "55324", interstitial: "int-55326" },
    // AdMob ad units (iOS). The AdMob APP id is not here: it lives in the
    // project's Info.plist (GADApplicationIdentifier), where the SDK reads it.
    admob: {
      coins: "ca-app-pub-7943520600036469/3930806992",       // free coins, behind the 🪙 counter
      daily_chest: "ca-app-pub-7943520600036469/8799990297", // opens the daily chest
      interstitial: "ca-app-pub-7943520600036469/3204194475", // on level-up, from level 3
    },
  },
  minesell: {
    id: "minesell",
    backendUrl: "https://minesell.v23labs.com",
    gamedataBase: "../shared/minesell/gamedata/",
    // Both mini apps are served from the same GitHub Pages origin, so they
    // share one localStorage: without a prefix MineSell would read Grow Sell's
    // save, language and onboarding step.
    storagePrefix: "minesell:",
    art: "games/minesell/art/",
    theme: "games/minesell/theme.css",
    // Platform 52432 (MSApp).
    adsgram: { coins: "55328", daily_chest: "55327", interstitial: "int-55329" },
    // AdMob app "Mine Sell" (app id is in ios/minesell's Info.plist).
    admob: {
      coins: "ca-app-pub-7943520600036469/4449213526",       // free coins, behind the 🪙 counter
      daily_chest: "ca-app-pub-7943520600036469/8159112416", // opens the daily chest
      interstitial: "ca-app-pub-7943520600036469/6699972340", // on level-up, from level 3
    },
  },
};

function pick() {
  let fromUrl = null;
  try { fromUrl = new URLSearchParams(location.search).get("game"); } catch (_) {}
  const fromWindow = typeof window !== "undefined" ? window.GAME : undefined;
  return PROFILES[fromWindow] || PROFILES[fromUrl] || PROFILES.growsell;
}

export const profile = pick();

// Every localStorage key goes through this, so two games on one origin never
// see each other's data.
export function storageKey(key) { return profile.storagePrefix + key; }

if (typeof document !== "undefined") {
  document.documentElement.dataset.game = profile.id;
  if (profile.theme) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = profile.theme;
    document.head.appendChild(link);
  }
}
