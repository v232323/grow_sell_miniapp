// Backend seam — talks to the grow-sell-bot Cloudflare Worker.
//
// Mirrors the stars.js / ads.js pattern: fully wired, but a no-op until the URL
// is filled in. With BACKEND_URL empty (or outside Telegram, where there's no
// initData to authenticate with) the game runs exactly as before on client-only
// CloudStorage/localStorage. Point BACKEND_URL at the deployed worker to switch
// on the authoritative server store, referral credits and (later) Stars.

import * as tg from "./platform.js";
import * as flags from "./flags.js";

// The studio domain (docs/RELEASE_PLAN.md 3.2), not the worker's own
// *.workers.dev hostname: that one is blocked by some providers, and a blocked
// host costs the player the whole backend, not just a link. The old hostname
// still answers (`workers_dev = true` in backend/wrangler.toml), so clients that
// haven't reloaded keep working.
export const BACKEND_URL = "https://growsell.v23labs.com";

// Public pages the same worker serves. The app links to them from settings, and
// the privacy and support ones are what App Store Connect gets.
export function privacyUrl() { return `${BACKEND_URL}/privacy`; }
export function termsUrl() { return `${BACKEND_URL}/terms`; }
export function supportUrl() { return `${BACKEND_URL}/support`; }

// Phase 2 kill-switch. false → legacy behaviour (client-authoritative save synced
// via /api/sync, exactly as Phase 1). true → server-authoritative economy: every
// value action goes through /api/action and the client reconciles to the server.
// Flip to true only once the action path is verified in Telegram.
export const SERVER_AUTH = true;

// Needs both a configured worker and a host we can authenticate from. Today
// only Telegram carries credentials (initData); iOS flips caps.backend on once
// device-auth ships, and this function keeps working unchanged.
export function enabled() {
  return !deleted && !!BACKEND_URL && tg.caps.backend && !!tg.credentials();
}

// One-way switch, thrown when the player deletes their account. Our credential
// (Telegram initData / the device secret) still authenticates after the delete,
// so ANY later request — the 10s poll, a queued push, a stray tap — would make
// the server create the account again from scratch. Turning enabled() off kills
// every network path at once, which is exactly the guarantee the delete button
// promises. Irreversible on purpose: the page is finished, the player closes it.
let deleted = false;
export function markDeleted() {
  deleted = true;
  pending = null;
  if (timer) { clearTimeout(timer); timer = null; }
}

// Server-authoritative mode is on AND we can actually reach the backend.
export function serverAuth() {
  return SERVER_AUTH && enabled();
}

// Credentials for the worker's authed(): { initData } in Telegram,
// { deviceSecret } on iOS. Null means we can't authenticate — enabled() below
// keeps us out of the network paths in that case.
function creds() {
  return tg.credentials() || {};
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
      body: JSON.stringify({ ...creds(), save }),
    });
    const data = await res.json();
    if (data) flags.apply(data.flags);
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
        body: JSON.stringify({ ...creds(), action: { type, args: args || {} } }),
      });
      const data = await res.json();
      if (data) flags.apply(data.flags);
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
      body: JSON.stringify({ ...creds(), limit }),
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
      body: JSON.stringify({ ...creds(), name: name || "" }),
    });
    return await res.json();
  } catch (_) {
    return null;
  }
}

// Report a leaderboard name, or block/unblock the player behind it. `pid` is the
// opaque id from a leaderboard row — the client never sees account ids.
// Both resolve to true only on a confirmed server write.
export async function reportPlayer(pid, reason) {
  return postOk("/api/report", { pid, reason: reason || "" });
}

export async function blockPlayer(pid, blocked = true) {
  return postOk("/api/block", { pid, blocked });
}

async function postOk(path, extra) {
  if (!enabled()) return false;
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...creds(), ...extra }),
    });
    const data = await res.json();
    return !!(data && data.ok);
  } catch (_) {
    return false;
  }
}

// Delete the server-side account. Returns true only on a confirmed delete —
// the caller must not claim success it can't verify.
export async function deleteAccount() {
  if (!enabled()) return false;
  try {
    const res = await fetch(`${BACKEND_URL}/api/account/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...creds() }),
    });
    const data = await res.json();
    return !!(data && data.ok);
  } catch (_) {
    return false;
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
