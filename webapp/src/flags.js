// Remote levers pushed by the worker (backend/src/index.js → remoteFlags).
//
// Why this exists: on iOS the whole game ships inside the app bundle, so any
// code fix — a broken ad SDK, a wrong balance number — reaches players only
// after App Review, 1–3 days later. Until then these switches are the only
// thing that can be changed, and they are flipped as worker vars in the
// Cloudflare dashboard, without a deploy.
//
// Flags arrive on /api/sync and on every /api/action (the 10s poll included),
// so a change lands within seconds. Defaults here are the "everything normal"
// state: with no backend at all (local mode) nothing below ever fires.

import { alert as showAlert } from "./platform.js";
import { getLocale } from "./i18n.js";
import { CLIENT_VERSION, isOlderThan } from "./version.js";

const current = {
  adsEnabled: true,
  minVersion: "",
  notice: { ru: "", en: "" },
};

// A message is shown once, not on every poll. Kept in localStorage rather than
// in memory so it survives a reload — otherwise every app resume would repeat
// the same notice.
const SEEN_KEY = "gs_notice_seen";

function seen() {
  try { return localStorage.getItem(SEEN_KEY) || ""; } catch (_) { return ""; }
}

function markSeen(text) {
  try { localStorage.setItem(SEEN_KEY, text); } catch (_) { /* private mode */ }
}

export function adsEnabled() { return current.adsEnabled; }

// Called by backend.js for every server response that carries flags.
export function apply(flags) {
  if (!flags || typeof flags !== "object") return;

  if (typeof flags.adsEnabled === "boolean") current.adsEnabled = flags.adsEnabled;
  if (typeof flags.minVersion === "string") current.minVersion = flags.minVersion;
  if (flags.notice && typeof flags.notice === "object") {
    current.notice = {
      ru: String(flags.notice.ru || ""),
      en: String(flags.notice.en || ""),
    };
  }

  announce();
}

// The outdated-client warning is deliberately advisory: the game keeps working.
// A hard block would strand players whose update is still rolling out, and it is
// exactly the kind of screen App Review runs into on a fresh install.
function announce() {
  const text = current.notice[getLocale()] || current.notice.en || "";
  const outdated = isOlderThan(CLIENT_VERSION, current.minVersion);
  const message = outdated ? [text, updateText()].filter(Boolean).join("\n\n") : text;
  if (!message) return;

  // Key the "already seen" check on the message itself: editing the var to a new
  // text shows it again, re-saving the same one does not.
  if (seen() === message) return;
  markSeen(message);
  showAlert(message);
}

function updateText() {
  return getLocale() === "ru"
    ? "Доступна новая версия игры — обновите приложение."
    : "A new version of the game is available — please update the app.";
}
