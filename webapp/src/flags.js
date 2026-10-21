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
import { storageKey } from "./profile.js";

const current = {
  adsEnabled: true,
  minVersion: "",
  blockVersion: "",
  updateUrl: "",
  notice: { ru: "", en: "" },
};

// The UI renders the update sheet; this module only decides when. Set by ui.js
// at boot, the same way backend.js takes its throttle handler — so flags.js
// never has to import the UI and the two stay acyclic. Without a handler the
// old text-alert path still fires, which is what local mode and any caller
// that boots without the UI get.
let onUpdate = null;
export function setUpdateHandler(fn) { onUpdate = fn; }

// A required update is shown once per session rather than on every poll: the
// sheet does not close, so re-opening it every 10 seconds would only rebuild
// the same DOM under the player's finger.
let requiredShown = false;

// A message is shown once, not on every poll. Kept in localStorage rather than
// in memory so it survives a reload — otherwise every app resume would repeat
// the same notice.
const SEEN_KEY = storageKey("gs_notice_seen");
// Separate key: the notice and the update prompt are shown for different reasons
// and must not be able to mark each other as already seen.
const SEEN_UPD_KEY = storageKey("gs_update_seen");

function seen() {
  try { return localStorage.getItem(SEEN_KEY) || ""; } catch (_) { return ""; }
}

function markSeen(text) {
  try { localStorage.setItem(SEEN_KEY, text); } catch (_) { /* private mode */ }
}

function seenUpdate() {
  try { return localStorage.getItem(SEEN_UPD_KEY) || ""; } catch (_) { return ""; }
}

function markSeenUpdate(key) {
  try { localStorage.setItem(SEEN_UPD_KEY, key); } catch (_) { /* private mode */ }
}

export function adsEnabled() { return current.adsEnabled; }

// Called by backend.js for every server response that carries flags.
export function apply(flags) {
  if (!flags || typeof flags !== "object") return;

  if (typeof flags.adsEnabled === "boolean") current.adsEnabled = flags.adsEnabled;
  if (typeof flags.minVersion === "string") current.minVersion = flags.minVersion;
  if (typeof flags.blockVersion === "string") current.blockVersion = flags.blockVersion;
  if (typeof flags.updateUrl === "string") current.updateUrl = flags.updateUrl;
  if (flags.notice && typeof flags.notice === "object") {
    current.notice = {
      ru: String(flags.notice.ru || ""),
      en: String(flags.notice.en || ""),
    };
  }

  announce();
}

// Two strengths, and the difference matters. MIN_CLIENT_VERSION is advisory —
// the game keeps working, because a block would strand players whose update is
// still rolling out and it is exactly the screen App Review meets on a fresh
// install. BLOCK_CLIENT_VERSION is the real stop, for the one case that earns
// it: a protocol change after which an old build would silently lose or
// double-apply actions, so letting it keep playing damages the save.
function announce() {
  const required = isOlderThan(CLIENT_VERSION, current.blockVersion);
  const outdated = required || isOlderThan(CLIENT_VERSION, current.minVersion);

  // With a handler the update gets its own sheet, so it is no longer glued onto
  // the notice text: the two are different things and the notice must not be
  // able to suppress the update (or the other way round) via the seen-key.
  if (onUpdate && outdated) {
    if (required) {
      if (!requiredShown) { requiredShown = true; onUpdate({ required: true, url: current.updateUrl }); }
    } else if (seenUpdate() !== updateKey()) {
      markSeenUpdate(updateKey());
      onUpdate({ required: false, url: current.updateUrl });
    }
  }

  const text = current.notice[getLocale()] || current.notice.en || "";
  // No handler (local mode, or a boot path without the UI): fall back to the
  // plain alert that shipped in 1.0.x, update text glued on as before.
  const message = (!onUpdate && outdated) ? [text, updateText()].filter(Boolean).join("\n\n") : text;
  if (!message) return;

  // Key the "already seen" check on the message itself: editing the var to a new
  // text shows it again, re-saving the same one does not.
  if (seen() === message) return;
  markSeen(message);
  showAlert(message);
}

// Keyed on the version being asked for, not on the sentence: bumping
// MIN_CLIENT_VERSION asks again, re-saving the same value does not.
function updateKey() { return "upd:" + current.minVersion; }

function updateText() {
  return getLocale() === "ru"
    ? "Доступна новая версия игры — обновите приложение."
    : "A new version of the game is available — please update the app.";
}
