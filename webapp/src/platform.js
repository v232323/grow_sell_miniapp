// Which host we're running inside, and one API for everything host-specific.
//
// The game has three hosts: the Telegram mini app, the native iOS shell
// (Capacitor/WKWebView) and a plain browser (local dev). Each has its own driver
// module with the same shape; this file picks one and re-exports it, so game
// code never branches on the host itself.
//
// Adding a host = adding a driver + a line in PLATFORM/driver below.

import * as telegramDriver from "./telegram.js";
import * as iosDriver from "./ios.js";

// Capacitor injects `window.Capacitor` into the WKWebView before our modules
// run, so getPlatform() is already answerable here. The build script also sets
// window.PLATFORM_HINT as a belt-and-braces fallback.
function detect() {
  const cap = window.Capacitor;
  const native = cap && typeof cap.getPlatform === "function" ? cap.getPlatform() : null;
  if (native === "ios" || window.PLATFORM_HINT === "ios") return "ios";
  if (telegramDriver.isTelegram) return "telegram";
  return "web";
}

export const PLATFORM = detect(); // "telegram" | "ios" | "web"

const driver = PLATFORM === "ios" ? iosDriver : telegramDriver;

// Kept as a named export because half the codebase already reads it. It means
// "we are inside Telegram", NOT "we have a backend" — see caps.backend.
export const isTelegram = PLATFORM === "telegram";
export const isNative = PLATFORM === "ios";

// What this host can actually do. Game code asks these instead of asking
// which platform it is, so a new host only has to fill in the table.
//
//   ads      — Adsgram rewarded/interstitial video (Telegram-only SDK)
//   stars    — Telegram Stars payments. On iOS, charging for digital goods
//              outside Apple's IAP breaks App Review guideline 3.1.1, so it
//              stays off until StoreKit lands.
//   backend  — we can authenticate against the worker. Today that means
//              Telegram initData; iOS flips to true once device-auth ships
//              (Э3а in docs/IOS_PLAN.md).
//   cloudSync — save follows the user across devices without extra plumbing.
//   leaderboard — we have a server-side identity to rank. Stays a separate flag
//              from `backend` because on iOS it also carries the UGC obligations
//              of App Review 1.2 — name filtering (backend/src/namefilter.js),
//              reporting and blocking (/api/report, /api/block), and rules of
//              conduct reachable from settings. All three shipped, so it's on.
export const caps = {
  // Every host has a provider now: Adsgram in Telegram, AdMob on iOS, and a
  // demo overlay in a browser so reward flows stay testable in dev.
  ads: true,
  stars: PLATFORM === "telegram",
  // iOS authenticates with a device secret from the Keychain (Э3а); the web
  // build in a plain browser has no credential at all and stays local.
  backend: PLATFORM === "telegram" || PLATFORM === "ios",
  cloudSync: PLATFORM === "telegram",
  leaderboard: PLATFORM === "telegram" || PLATFORM === "ios",
};

// Async: the iOS driver reads its account credential out of the Keychain here,
// and nothing may talk to the backend before that finishes.
export function init() { return driver.init(); }
export function haptic(kind) { return driver.haptic(kind); }
export function alert(message) { return driver.alert(message); }
export function confirmDialog(message, cb) { return driver.confirmDialog(message, cb); }
export function saveState(obj) { return driver.saveState(obj); }
export function loadState() { return driver.loadState(); }
export function clearState() { return driver.clearState(); }
// Close the app after the player deletes their account. True only in Telegram,
// where the mini app can actually be dismissed; false elsewhere tells the caller
// to leave a dead-end screen up instead. See resetProgress() in game.js for why
// the session must not stay alive.
export function close() { return driver.close(); }
// fn runs each time the app/page returns to the foreground.
export function onResume(fn) { return driver.onResume(fn); }

// Open a page outside the game (rules of conduct, privacy policy, support).
//
// Nobody gets thrown out of the app for this. Telegram has its own in-app
// browser and ignores window.open in some clients, so it gets the SDK call. On
// iOS window.open hands the URL to Safari as a separate app — the player leaves
// the game and comes back through the app switcher, and a store build that
// bounces the reviewer out to a browser is exactly what guideline 4.2 reads as
// "a website in a wrapper". @capacitor/browser puts an SFSafariViewController
// sheet over the game instead. A plain browser keeps the new tab.
export function openLink(url) {
  if (PLATFORM === "telegram") {
    const wa = telegramDriver.webApp();
    if (wa && wa.openLink) { wa.openLink(url); return; }
  }
  if (PLATFORM === "ios" && iosDriver.openInApp(url)) return;
  window.open(url, "_blank", "noopener");
}

// Raw Telegram.WebApp — null off Telegram. Only the Telegram-specific paths
// (initData for backend auth, openInvoice for Stars) may touch this.
export function webApp() {
  return PLATFORM === "telegram" ? telegramDriver.webApp() : null;
}

// What proves who we are to the backend: signed initData in Telegram, the
// device secret on iOS, nothing in a plain browser. Shape matches what the
// worker's authed() accepts.
export function credentials() {
  if (PLATFORM === "telegram") {
    const wa = telegramDriver.webApp();
    const initData = (wa && wa.initData) || "";
    return initData ? { initData } : null;
  }
  if (PLATFORM === "ios") return iosDriver.credentials();
  return null;
}

// The host's own idea of the user's language, when it has one. Telegram knows
// the account language, which beats the device language inside the mini app.
// Native/browser hosts return null and i18n falls back to navigator.language.
export function hostLanguage() {
  if (PLATFORM !== "telegram") return null;
  const wa = telegramDriver.webApp();
  const user = wa && wa.initDataUnsafe && wa.initDataUnsafe.user;
  return (user && user.language_code) || null;
}
