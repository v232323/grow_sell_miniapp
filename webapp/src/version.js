// Version of the game code itself (this webapp), not of the iOS wrapper.
//
// Two different numbers on purpose: MARKETING_VERSION in the Xcode project is
// what the App Store shows, while this is what the server compares against
// MIN_CLIENT_VERSION. In Telegram the mini app always loads the newest code, so
// this only ever matters on iOS, where the bundle is frozen until the player
// installs an update.
//
// Bump on every store build that changes webapp/ or shared/gamedata.
export const CLIENT_VERSION = "1.0.0";

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
