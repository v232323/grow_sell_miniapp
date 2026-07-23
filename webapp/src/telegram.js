// Thin wrapper around the Telegram WebApp SDK. Degrades gracefully to a no-op
// mock when opened in a normal browser (local dev / preview), so the same code
// runs everywhere.

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

export const isTelegram = !!tg && !!tg.initData;

// Raw Telegram.WebApp (or null in a browser) — used by the Stars flow for
// openInvoice. Prefer the typed helpers above for everything else.
export function webApp() { return tg; }

// showAlert/showConfirm need Bot API 6.2+ (SDK outside Telegram reports 6.0).
function popupsSupported() {
  return !!tg && typeof tg.isVersionAtLeast === "function" && tg.isVersionAtLeast("6.2");
}

// Native popup in Telegram, window.alert in a browser.
export function alert(message) {
  if (popupsSupported()) { try { tg.showAlert(message); return; } catch (_) {} }
  window.alert(message);
}

// Native confirm in Telegram, window.confirm in a browser. cb runs only on OK.
export function confirmDialog(message, cb) {
  if (popupsSupported()) {
    try { tg.showConfirm(message, (ok) => { if (ok) cb(); }); return; } catch (_) {}
  }
  if (window.confirm(message)) cb();
}

// Wipe the save everywhere (used by the reset-progress button).
export function clearState() {
  try { localStorage.removeItem("idle_tycoon_save"); } catch (_) {}
  if (tg && tg.CloudStorage && isTelegram) {
    try { tg.CloudStorage.removeItem(CLOUD_KEY); } catch (_) {}
  }
}

export function init() {
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    if (tg.setHeaderColor) tg.setHeaderColor("secondary_bg_color");
    applyTheme();
    tg.onEvent && tg.onEvent("themeChanged", applyTheme);
  } catch (e) {
    console.warn("Telegram init failed:", e);
  }
}

// Map Telegram theme params onto our CSS variables. Falls back to sensible
// dark-garden defaults (also used outside Telegram).
function applyTheme() {
  if (!tg || !tg.themeParams) return;
  const p = tg.themeParams;
  const root = document.documentElement;
  const set = (name, val) => val && root.style.setProperty(name, val);
  set("--tg-bg", p.bg_color);
  set("--tg-secondary-bg", p.secondary_bg_color);
  set("--tg-text", p.text_color);
  set("--tg-hint", p.hint_color);
  set("--tg-link", p.link_color);
  set("--tg-button", p.button_color);
  set("--tg-button-text", p.button_text_color);
  if (tg.colorScheme) root.dataset.theme = tg.colorScheme;
}

// Haptic feedback — silent no-op outside Telegram.
export function haptic(kind = "light") {
  if (!tg || !tg.HapticFeedback) return;
  try {
    if (kind === "success" || kind === "error" || kind === "warning") {
      tg.HapticFeedback.notificationOccurred(kind);
    } else {
      tg.HapticFeedback.impactOccurred(kind); // light | medium | heavy
    }
  } catch (_) {}
}

// Persistent storage. Prefers Telegram CloudStorage (syncs across the user's
// devices); falls back to localStorage. Both are async-friendly here.
const CLOUD_KEY = "save";

export function saveState(obj) {
  const json = JSON.stringify(obj);
  try {
    localStorage.setItem("idle_tycoon_save", json);
  } catch (_) {}
  if (tg && tg.CloudStorage && isTelegram) {
    try { tg.CloudStorage.setItem(CLOUD_KEY, json); } catch (_) {}
  }
}

export function loadState() {
  return new Promise((resolve) => {
    if (tg && tg.CloudStorage && isTelegram) {
      try {
        tg.CloudStorage.getItem(CLOUD_KEY, (err, value) => {
          if (!err && value) {
            try { return resolve(JSON.parse(value)); } catch (_) {}
          }
          resolve(loadLocal());
        });
        return;
      } catch (_) {}
    }
    resolve(loadLocal());
  });
}

function loadLocal() {
  try {
    const v = localStorage.getItem("idle_tycoon_save");
    return v ? JSON.parse(v) : null;
  } catch (_) {
    return null;
  }
}
