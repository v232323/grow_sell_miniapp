// Backend seam — talks to the grow-sell-bot Cloudflare Worker.
//
// Mirrors the stars.js / ads.js pattern: fully wired, but a no-op until the URL
// is filled in. With BACKEND_URL empty (or outside Telegram, where there's no
// initData to authenticate with) the game runs exactly as before on client-only
// CloudStorage/localStorage. Point BACKEND_URL at the deployed worker to switch
// on the authoritative server store, referral credits and (later) Stars.

import * as tg from "./telegram.js";

// e.g. "https://grow-sell-bot.<subdomain>.workers.dev"
export const BACKEND_URL = "https://grow-sell-bot.growsellwebapp.workers.dev";

// Phase 2 kill-switch. false → legacy behaviour (client-authoritative save synced
// via /api/sync, exactly as Phase 1). true → server-authoritative economy: every
// value action goes through /api/action and the client reconciles to the server.
// Flip to true only once the action path is verified in Telegram.
export const SERVER_AUTH = true;

export function enabled() {
  return !!BACKEND_URL && tg.isTelegram;
}

// Server-authoritative mode is on AND we can actually reach the backend.
export function serverAuth() {
  return SERVER_AUTH && enabled();
}

function initData() {
  const wa = tg.webApp();
  return (wa && wa.initData) || "";
}

// POST the current save (or null to pull) and get the authoritative save back:
// the server folds in any referral / purchase gems and entitlements exactly
// once. Returns { save, ledger } or null on any failure (caller keeps local).
export async function sync(save = null) {
  if (!enabled()) return null;
  try {
    const res = await fetch(`${BACKEND_URL}/api/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: initData(), save }),
    });
    const data = await res.json();
    return data && data.ok ? { save: data.save, ledger: data.ledger } : null;
  } catch (_) {
    return null;
  }
}

// Pull-only: authoritative save from the server, or null.
export function pull() { return sync(null); }

// ── Phase 2: server-authoritative actions ────────────────────────────────────
// Post one action intent and get the authoritative state back:
//   { ok, result, offlineReport, state, serverTime }  or null on any failure.
// Actions are serialized (one in flight at a time) so the server's compare-and-
// swap on `version` never conflicts with our own previous action.
let actionChain = Promise.resolve(null);

export function action(type, args) {
  if (!serverAuth()) return Promise.resolve(null);
  const run = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initData: initData(), action: { type, args: args || {} } }),
      });
      const data = await res.json();
      return data && data.ok ? data : null;
    } catch (_) {
      return null;
    }
  };
  const p = actionChain.then(run, run);
  actionChain = p.catch(() => null);
  return p;
}

// ── Phase 4: leaderboard + display name ──────────────────────────────────────
// Both are initData-authenticated POSTs (auth reads initData from the body).

// Fetch the leaderboard: { top: [{rank,name,level,coins,me}], me: {...} } or null.
export async function leaderboard(limit = 50) {
  if (!enabled()) return null;
  try {
    const res = await fetch(`${BACKEND_URL}/api/leaderboard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: initData(), limit }),
    });
    const data = await res.json();
    return data && data.ok ? data : null;
  } catch (_) {
    return null;
  }
}

// Set (non-empty name) or just acknowledge (empty name) the display name.
// Returns { ok, displayName } or null on transport failure.
export async function setName(name) {
  if (!enabled()) return null;
  try {
    const res = await fetch(`${BACKEND_URL}/api/name`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: initData(), name: name || "" }),
    });
    return await res.json();
  } catch (_) {
    return null;
  }
}

// Throttled background push. save() fires on every state change, so we coalesce
// pushes to at most one per PUSH_INTERVAL to keep the server current without
// spamming it. Fire-and-forget: local storage stays the immediate source.
const PUSH_INTERVAL = 10000;
let lastPush = 0;
let pending = null;
let timer = null;

export function queuePush(getSave) {
  if (!enabled() || serverAuth()) return; // server-auth persists via /api/action
  pending = getSave;
  if (timer) return;
  const wait = Math.max(0, PUSH_INTERVAL - (Date.now() - lastPush));
  timer = setTimeout(() => {
    timer = null;
    lastPush = Date.now();
    const snapshot = pending && pending();
    pending = null;
    if (snapshot) sync(snapshot);
  }, wait);
}
