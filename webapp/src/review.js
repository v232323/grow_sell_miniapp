// When to ask the player to rate the game.
//
// The native sheet itself is one call (ios/App/App/ReviewPlugin.swift); the hard
// part is choosing the moment, and getting it wrong is expensive: iOS shows the
// sheet at most three times a year per player, so a request spent on someone
// mid-frustration is a request that cannot be spent later on someone happy.
//
// Rules, in order of how much they matter:
//   1. Only after a good beat — a claimed daily chest or a level-up, i.e. right
//      after the game gave the player something.
//   2. Never during onboarding. A player who has not finished the tutorial has
//      no opinion worth asking for, and the sheet over a coach mark reads as a
//      bug.
//   3. Not on the first day: the daily streak must be at least 2, i.e. the
//      player came back. Ratings from someone who installed an hour ago are the
//      least informative and the most volatile. The streak is used because it is
//      state the game already keeps — nothing new to store or migrate.
//   4. At most once per app version, tracked locally — iOS enforces its own cap
//      anyway, but asking a second time is wasted either way.
//
// Telegram has no equivalent, so everything here is a no-op off iOS.

import { PLATFORM } from "./platform.js";
import { CLIENT_VERSION } from "./version.js";

const ASKED_KEY = "gs_review_asked_version";
const MIN_STREAK = 2;

function plugin() {
  const cap = window.Capacitor;
  if (!cap) return null;
  if (cap.Plugins && cap.Plugins.Review) return cap.Plugins.Review;
  // Plugins living in the app target have no JS wrapper until something asks for
  // a proxy — same dance as the Keychain one in ios.js.
  if (typeof cap.registerPlugin === "function") {
    try { return cap.registerPlugin("Review"); } catch (_) { return null; }
  }
  return null;
}

function askedThisVersion() {
  try { return localStorage.getItem(ASKED_KEY) === CLIENT_VERSION; } catch (_) { return true; }
}

function markAsked() {
  try { localStorage.setItem(ASKED_KEY, CLIENT_VERSION); } catch (_) { /* private mode */ }
}

// Call right after a good beat, passing the current game state.
// Returns true only when the sheet was actually requested.
export async function maybeAsk(state) {
  if (PLATFORM !== "ios") return false;
  if (askedThisVersion()) return false;
  if (!state || !state.tutorialDone) return false;
  if (((state.daily && state.daily.streak) || 0) < MIN_STREAK) return false;

  const p = plugin();
  if (!p) return false;

  // Mark before asking, not after: if the native call throws we still do not
  // want to retry on the next chest. A missed request costs nothing, a repeated
  // one burns the yearly budget.
  markAsked();
  try {
    await p.request();
    return true;
  } catch (_) {
    return false;
  }
}
