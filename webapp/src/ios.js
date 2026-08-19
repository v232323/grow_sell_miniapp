// Native iOS host (Capacitor / WKWebView). Same shape as telegram.js.
//
// Plugins are reached through the `window.Capacitor.Plugins` bridge that the
// native runtime injects, NOT through npm imports — the web app ships as plain
// ES modules with no bundler, and we want to keep it that way.
//
// Every plugin is optional at runtime: if one isn't installed yet, the call
// falls back to a web equivalent instead of throwing. That way the app boots in
// the simulator before all the native pieces are wired up.

const SAVE_KEY = "idle_tycoon_save";

function plugin(name) {
  const cap = window.Capacitor;
  return (cap && cap.Plugins && cap.Plugins[name]) || null;
}

export const isTelegram = false;

export function webApp() { return null; }

// ── account credential ───────────────────────────────────────────────────────
// The backend has no Telegram initData to identify a native player, so the app
// carries its own credential: 256 random bits, generated once and kept in the
// Keychain (which survives deleting the app — NSUserDefaults would not).
// It IS the account: whoever holds it is the player, so it never leaves the
// device except as the request body over TLS, and the server stores only its
// SHA-256.
const SECRET_KEY = "account_secret";
let deviceSecret = null;

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Read the secret, minting one on first launch. Resolves to null if the
// Keychain isn't reachable — the caller then stays in offline/local mode rather
// than inventing a credential it can't persist (that would orphan the account).
// Our own plugin lives in the app target, so unlike the packaged ones it has no
// JS wrapper on window.Capacitor.Plugins until something asks for a proxy.
// registerPlugin() builds that proxy over the native bridge.
function keychainPlugin() {
  const cap = window.Capacitor;
  if (!cap) return null;
  if (cap.Plugins && cap.Plugins.Keychain) return cap.Plugins.Keychain;
  if (typeof cap.registerPlugin === "function") {
    try { return cap.registerPlugin("Keychain"); } catch (_) {}
  }
  return null;
}

async function loadDeviceSecret() {
  const kc = keychainPlugin();
  if (!kc) return null;
  try {
    const found = await kc.get({ key: SECRET_KEY });
    if (found && found.value) {
      // "loaded" after a reinstall is the proof the Keychain did its job.
      console.info("[account] device secret loaded from Keychain");
      return (deviceSecret = found.value);
    }
    const fresh = randomHex(32);
    await kc.set({ key: SECRET_KEY, value: fresh });
    console.info("[account] device secret minted");
    return (deviceSecret = fresh);
  } catch (e) {
    console.warn("Keychain unavailable:", e);
    return null;
  }
}

// What to send the backend to prove who we are. Null until init() has run, or
// forever if the Keychain refused us.
export function credentials() {
  return deviceSecret ? { deviceSecret } : null;
}

export async function init() {
  // Dark status-bar content on our dark background; ignore if the plugin or the
  // platform doesn't support it.
  const statusBar = plugin("StatusBar");
  if (statusBar && statusBar.setStyle) {
    try { statusBar.setStyle({ style: "DARK" }); } catch (_) {}
  }
  // The splash screen is dismissed by us rather than on a timer, so the player
  // never sees a blank web view while the JSON data loads.
  const splash = plugin("SplashScreen");
  if (splash && splash.hide) {
    try { splash.hide(); } catch (_) {}
  }
  document.documentElement.dataset.theme = "dark";
  // Before the first render: game.load() talks to the backend, and without the
  // secret in hand it would fall back to a local-only save.
  await loadDeviceSecret();
}

// Fires when the app returns to the foreground. Uses Capacitor's App plugin
// rather than visibilitychange: iOS fires the DOM event unreliably for a
// suspended WKWebView, while appStateChange is the platform's own signal.
export function onResume(fn) {
  const app = plugin("App");
  if (app && app.addListener) {
    try {
      app.addListener("appStateChange", (s) => { if (s && s.isActive) fn(); });
      return;
    } catch (_) {}
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) fn();
  });
}

// kind: light | medium | heavy | success | error | warning
export function haptic(kind = "light") {
  const haptics = plugin("Haptics");
  if (!haptics) return;
  try {
    if (kind === "success" || kind === "error" || kind === "warning") {
      haptics.notification({ type: kind.toUpperCase() });
    } else {
      haptics.impact({ style: kind.toUpperCase() });
    }
  } catch (_) {}
}

export function alert(message) {
  const dialog = plugin("Dialog");
  if (dialog && dialog.alert) {
    try { dialog.alert({ message }); return; } catch (_) {}
  }
  window.alert(message);
}

// cb runs only on OK. Native Dialog.confirm is async, hence the promise hop.
export function confirmDialog(message, cb) {
  const dialog = plugin("Dialog");
  if (dialog && dialog.confirm) {
    try {
      dialog.confirm({ message }).then((r) => { if (r && r.value) cb(); }).catch(() => {});
      return;
    } catch (_) {}
  }
  if (window.confirm(message)) cb();
}

// Preferences is backed by NSUserDefaults, so the save survives app updates —
// unlike WKWebView's localStorage, which iOS may evict under storage pressure.
// We still mirror to localStorage: it's synchronous, so it's the copy that
// survives a hard kill between the setItem call and the async native write.
export function saveState(obj) {
  const json = JSON.stringify(obj);
  try { localStorage.setItem(SAVE_KEY, json); } catch (_) {}
  const prefs = plugin("Preferences");
  if (prefs && prefs.set) {
    try { prefs.set({ key: SAVE_KEY, value: json }); } catch (_) {}
  }
}

export async function loadState() {
  const prefs = plugin("Preferences");
  if (prefs && prefs.get) {
    try {
      const r = await prefs.get({ key: SAVE_KEY });
      if (r && r.value) return JSON.parse(r.value);
    } catch (_) {}
  }
  return loadLocal();
}

function loadLocal() {
  try {
    const v = localStorage.getItem(SAVE_KEY);
    return v ? JSON.parse(v) : null;
  } catch (_) {
    return null;
  }
}

export function clearState() {
  try { localStorage.removeItem(SAVE_KEY); } catch (_) {}
  const prefs = plugin("Preferences");
  if (prefs && prefs.remove) {
    try { prefs.remove({ key: SAVE_KEY }); } catch (_) {}
  }
  // The device secret IS the account, so a wipe has to take it too. The server
  // has already dropped the identity row, so the old secret would in any case
  // register a fresh account — but it was minted for data the player asked us to
  // forget, and it outlives even a reinstall. Fire-and-forget: the next launch
  // mints a new one.
  const kc = keychainPlugin();
  if (kc && kc.remove) {
    try { Promise.resolve(kc.remove({ key: SECRET_KEY })).catch(() => {}); } catch (_) {}
  }
  deviceSecret = null;
}

// Nothing to close: an iOS app must never quit itself (HIG — it reads as a
// crash, and App Review rejects exit() calls). The caller shows a dead-end
// screen instead, and the next launch starts a brand-new account.
export function close() { return false; }

// ── external pages ───────────────────────────────────────────────────────────
// Opens a URL in an SFSafariViewController sheet on top of the game instead of
// handing it to Safari as a separate app. Returns false when the plugin isn't
// there, so the caller can fall back to window.open rather than swallow the tap
// — a settings link that does nothing is worse than one that leaves the app.
export function openInApp(url) {
  const browser = plugin("Browser");
  if (!browser || typeof browser.open !== "function") return false;
  try {
    // Fire-and-forget: the sheet is native, nothing here waits on it. A rejected
    // promise would otherwise surface as an unhandled rejection in the webview.
    Promise.resolve(browser.open({ url, presentationStyle: "popover" })).catch(() => {});
    return true;
  } catch (_) {
    return false;
  }
}
