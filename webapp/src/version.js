// Version of the game code itself (this webapp), not of the iOS wrapper.
//
// This is what the client reports to the server (and what the server compares
// against MIN_CLIENT_VERSION). It MUST equal MARKETING_VERSION in that game's
// Xcode project — ios/scripts/preflight.mjs fails the build otherwise.
//
// One number per game: Grow Sell and MineSell are separate apps that ship and
// get reviewed on their own schedule, and each worker has its own
// MIN_CLIENT_VERSION. The Telegram build of a game reports the same number.
//
// They used to be allowed to differ, described as "two different numbers on
// purpose". That is how build 6 reached the App Store: the Xcode number was
// bumped by a commit, the web bundle was not rebuilt, and the store showed 1.1.0
// while this constant still said 1.0.1 — with three days of balance changes
// missing. The store number and the code number are one number now.
//
// Bump a game's number on every store build of it that changes webapp/ or its
// shared/<game>/gamedata, and bump CURRENT_PROJECT_VERSION in ios/<game> with it.
import { profile } from "./profile.js";

export const CLIENT_VERSIONS = {
  growsell: "1.2.0",
  minesell: "1.0.0",
};

export const CLIENT_VERSION = CLIENT_VERSIONS[profile.id];

// "1.2.10" > "1.2.9" — plain string compare gets this wrong, so compare the
// numeric parts. Missing or unparseable parts count as 0, so "1.1" === "1.1.0"
// and a mistyped MIN_CLIENT_VERSION like "v1.2" reads as 0.1.2 — which errs
// toward NOT nagging anyone, the safe direction for a lever edited by hand in a
// dashboard. An empty `min` disables the check outright.
export function isOlderThan(version, min) {
  if (!min) return false;
  const parts = (s) => String(s).split(".").map((n) => parseInt(n, 10) || 0);
  const a = parts(version);
  const b = parts(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}
