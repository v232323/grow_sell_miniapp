// Backend seam — talks to the grow-sell-bot Cloudflare Worker.
//
// Mirrors the stars.js / ads.js pattern: fully wired, but a no-op until the URL
// is filled in. With BACKEND_URL empty (or outside Telegram, where there's no
// initData to authenticate with) the game runs exactly as before on client-only
// CloudStorage/localStorage. Point BACKEND_URL at the deployed worker to switch
// on the authoritative server store, referral credits and (later) Stars.

import * as tg from "./platform.js";
import * as flags from "./flags.js";
import { CLIENT_VERSION } from "./version.js";
import { profile, storageKey } from "./profile.js";

// The studio domain (docs/RELEASE_PLAN.md 3.2), not the worker's own
// *.workers.dev hostname: that one is blocked by some providers, and a blocked
// host costs the player the whole backend, not just a link. The old hostname
// still answers (`workers_dev = true` in backend/wrangler.toml), so clients that
// haven't reloaded keep working. Each game has its own worker (profile.js).
export const BACKEND_URL = profile.backendUrl;

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
  queued = [];
  try { localStorage.removeItem(OUTBOX_KEY); } catch (_) {}
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (timer) { clearTimeout(timer); timer = null; }
}

// Server-authoritative mode is on AND we can actually reach the backend.
export function serverAuth() {
  return SERVER_AUTH && enabled();
}

// Credentials for the worker's authed(): { initData } in Telegram,
// { deviceSecret } on iOS. Null means we can't authenticate — enabled() below
// keeps us out of the network paths in that case.
//
// `clientVersion` rides along on every request. It is not authentication and the
// server does not trust it for anything — it exists so "which build is this
// player on" is a dashboard question. Before this, the client only ever compared
// its version against the flags LOCALLY and told the server nothing, which is
// how a store build carrying a three-day-old bundle ran unnoticed until a player
// sent in a screen recording. See webapp/src/version.js.
function creds() {
  return { ...(tg.credentials() || {}), clientVersion: CLIENT_VERSION, platform: tg.PLATFORM };
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
// Post action intents and get the authoritative state back:
//   { ok, result, results, offlineReport, state, serverTime }  or null on failure.
// Requests are serialized (one in flight at a time) so the server's compare-and-
// swap on `version` never conflicts with our own previous one.
let actionChain = Promise.resolve(null);

// Rate limiting is what makes a dropped action expensive rather than merely
// annoying. The zone rule on /api/action (30 requests / 10s per IP, see
// docs/RELEASE_PLAN.md 7) answers with Cloudflare's HTML block page, so
// `res.json()` throws and a 429 used to be indistinguishable from a dead
// connection: action() returned null and the mutation was simply LOST. Under
// SERVER_AUTH the client never pushes its save, so the next successful `touch`
// overwrites the optimistic local state — the player watches their taps roll
// back with no explanation. Serving the register queue is exactly the burst that
// trips the limit, so this is the normal path for an engaged player, not an edge
// case. Hence: retry the action instead of dropping it.
//
// The free plan blocks for a fixed 10 seconds, so the first wait clears it with
// a little margin; the doubling after that covers a limit tightened later
// without needing another client release.
const RETRY_DELAYS_MS = [11000, 22000, 44000];

let blockedUntil = 0;

// True while we are sitting out a 429. The UI reads this to explain the pause
// once, instead of leaving the player to guess why the shop stopped answering.
export function throttled() {
  return Date.now() < blockedUntil;
}

// Fires when a backoff STARTS, not on every blocked request — the player needs
// one explanation, not one per queued tap. ui.js owns the toast; game.js can't,
// because ui.js already imports it and the cycle would be real.
let onThrottle = null;
export function setThrottleHandler(fn) { onThrottle = fn; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Batching ─────────────────────────────────────────────────────────────────
// One request per tap is what puts the rate limit within reach at all: emptying
// the register queue or harvesting the garden is dozens of requests inside a few
// seconds, from a single player who is doing nothing wrong. So taps are buffered
// and delivered together — a burst of 24 harvest taps becomes about 2 requests
// instead of 24, and the limit stops being something normal play can touch.
//
// NOT buffered: anything whose outcome the player is waiting to see. Ad rewards
// and daily-chest claims are decided server-side, and holding one for five
// seconds leaves the player looking at a button that did nothing. Those go
// straight out through action() — which carries the buffer along with them, so
// the server still sees everything in the order the player did it.
//
// The cost of buffering is durability: up to FLUSH_MS of taps live only on the
// device. flushNow() on the way to the background covers the ordinary case (the
// player switches apps), leaving only a hard kill mid-buffer, which loses at
// most five seconds of taps and cannot roll anything back beyond that.
const FLUSH_MS = 5000;

// Ceiling on what a failed send may hand back. Past this the player has been
// unreachable long enough that replaying old taps is worth less than the memory
// it costs; the next successful poll reconciles them to server truth anyway.
const MAX_QUEUED = 100;

// Must not exceed MAX_BATCH in backend/src/index.js. The server slices the batch
// to that many actions and answers `ok` for the whole request, so anything sent
// past it is applied nowhere and reported nowhere — the taps are simply gone,
// while the client has already shown them applied. The normal 5s buffer never
// gets near 50, but a send that failed hands back up to MAX_QUEUED, and that is
// exactly the burst that would overflow.
const MAX_PER_REQUEST = 50;

// ── Идентичность действий ────────────────────────────────────────────────────
// Каждое действие несёт монотонный `seq`, а установка целиком — `seqEpoch`.
// Сервер помнит последний применённый номер и пропускает всё, что уже видел,
// поэтому повтор пачки после потерянного ответа больше не применяет её дважды.
// Счётчик переживает перезагрузку: иначе после неё номера пошли бы заново и
// оказались бы ниже серверной отметки, то есть все действия отвергались бы.
// Эпоха — страховка на случай очищенного хранилища: увидев новую, сервер
// сбрасывает отметку и принимает нумерацию заново.
const SEQ_KEY = storageKey("gs_seq");
const EPOCH_KEY = storageKey("gs_seq_epoch");

let seq = 0;
let seqEpoch = "";
try {
  seq = parseInt(localStorage.getItem(SEQ_KEY), 10) || 0;
  seqEpoch = localStorage.getItem(EPOCH_KEY) || "";
  if (!seqEpoch) {
    seqEpoch = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    localStorage.setItem(EPOCH_KEY, seqEpoch);
  }
} catch (_) {
  // Приватный режим: живём одну сессию. Эпоха всё равно уникальна, так что
  // сервер просто примет нумерацию с нуля вместо того, чтобы всё отвергнуть.
  seqEpoch = "mem" + Math.random().toString(36).slice(2, 8);
}

function nextSeq() {
  seq += 1;
  try { localStorage.setItem(SEQ_KEY, String(seq)); } catch (_) {}
  return seq;
}

// Очередь переживает убийство приложения. До этого она жила только в памяти, и
// комментарий выше честно признавал, что жёсткий килл теряет до FLUSH_MS тапов.
// Теперь она лежит рядом с сейвом: на старте поднимается и уезжает с первым же
// запросом. Повторно применить восстановленное не страшно — номера действий
// сохраняются вместе с ними, и сервер отбросит то, что уже видел.
const OUTBOX_KEY = storageKey("gs_outbox");

function loadOutbox() {
  try {
    const a = JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]");
    if (!Array.isArray(a)) return [];
    return a.filter((x) => x && typeof x.type === "string" && typeof x.seq === "number");
  } catch (_) { return []; }
}

// Копия списка из backend/src/sim.js (DIVERGED_ERRORS). Причины отсюда значат,
// что кошелёк, склад или уровень у сторон уже разные: клиент показал действие
// применённым, а сервер его отверг, и дальше по этому состоянию будет
// отклоняться всё подряд. Гонки (тапнул за полсекунды до пересчёта, кулдаун
// рекламы, «уже куплено») сюда НЕ входят — они штатны, и дёргать из-за них
// картинку было бы хуже, чем ничего не делать.
const DIVERGED = new Set(["coins", "gems", "level", "inputs", "locked", "nocell"]);

// Отказы по «этого уже/ещё нет»: собрать нечего, клетка занята, очередь пуста.
// Раньше они считались штатными гонками и не делали ничего — и именно они дают
// игроку симптом «собрал урожай, а он пропал». Клиент показал сбор применённым,
// сервер его отверг, и картинка оставалась неправдой до очередного опроса: до
// десяти секунд, после которых урожай исчезал молча и без повода.
//
// Сверяемся сразу. Это не то же самое, что DIVERGED: там расходятся кошелёк и
// уровень, и туда же смотрит серверная аналитика. Здесь — только просьба
// перерисоваться по правде, без события и без тоста. Дёрганья картинки не будет:
// если сервер согласен с нами, сверка ничего не меняет.
const RESYNC = new Set(["nothing", "busy", "empty"]);

// Кто чинит расхождение. Ставится игровым слоем (game.js), как и обработчик
// троттлинга: сам этот модуль про сверку состояния ничего не знает.
let onDiverged = null;
export function setDivergedHandler(fn) { onDiverged = fn; }

// Раньше сервер возвращал результат каждого действия, а клиент их выбрасывал —
// поэтому отклонённое действие было видно только игроку и только по симптому
// («выполнил задание, не засчиталось»). Теперь первое расхождение в пачке
// поднимает сверку сразу, а не через десять секунд опроса, и разъезд
// останавливается на одном действии вместо десяти.
function inspectResults(batch, data) {
  if (!onDiverged || !data || !Array.isArray(data.results)) return;
  for (let i = 0; i < data.results.length; i++) {
    const r = data.results[i];
    if (!r || r.ok || r.dup) continue;
    if (!DIVERGED.has(r.error) && !RESYNC.has(r.error)) continue;
    onDiverged({ reason: r.error, type: (batch[i] && batch[i].type) || "?" });
    return;
  }
}

let queued = loadOutbox();
let flushTimer = null;

function saveOutbox() {
  try {
    if (queued.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(queued));
    else localStorage.removeItem(OUTBOX_KEY);
  } catch (_) { /* приватный режим: очередь остаётся только в памяти */ }
}

// True while taps are buffered or in flight. The caller uses it to hold off
// reconciling: server state that predates these taps would roll them back on
// screen, which is the exact rollback batching is here to prevent.
let inFlight = 0;
export function hasPending() { return queued.length > 0 || inFlight > 0; }

// Копия неподтверждённой очереди — то, что сервер ещё не признал применённым.
// Игровой слой переигрывает её поверх серверного состояния при сверке, поэтому
// сверка больше не обязана ждать, пока очередь опустеет.
export function pendingActions() { return queued.map((a) => ({ type: a.type, args: a.args })); }

// Record a mutation the player has already seen applied locally. `at` is the
// moment of the tap: the server dates production from it rather than from
// delivery, so sitting in this buffer never costs the player growing time.
export function enqueue(type, args) {
  if (!serverAuth()) return;
  queued.push({ seq: nextSeq(), type, args: args || {}, at: Date.now() });
  saveOutbox();
  if (!flushTimer) {
    flushTimer = setTimeout(() => { flushTimer = null; deliver([]); }, FLUSH_MS);
  }
}

// Deliver whatever is buffered right now. Called on the way to the background,
// and safe to call with an empty buffer.
export function flushNow() {
  if (!queued.length) return Promise.resolve(null);
  return deliver([]);
}

// Send the buffer plus `extra`, in player order. Returns the server's reply, or
// null if it could not be delivered.
function deliver(extra) {
  if (!serverAuth()) return Promise.resolve(null);
  const run = async () => {
    // Действия НЕ покидают очередь при отправке — только когда сервер скажет,
    // докуда он применил. Раньше очередь очищалась ДО ответа, и всё, что сервер
    // не применил (пачка длиннее его лимита, отказ, потерянный ответ), исчезало
    // вместе с ней, а на экране оставалось применённым.
    if (extra.length) { queued = queued.concat(extra); saveOutbox(); }
    const batch = queued.slice(0, MAX_PER_REQUEST);
    if (!batch.length) return null;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    inFlight++;
    try {
      const data = await post(batch);
      if (data && Number.isFinite(data.appliedThrough)) {
        // Единственный источник правды о том, что можно забыть.
        queued = queued.filter((a) => a.seq > data.appliedThrough);
      } else if (data) {
        // Сервер старой сборки: подтверждений не шлёт. Ведём себя как раньше —
        // считаем отправленное применённым.
        queued = queued.slice(batch.length);
      } else if (queued.length > MAX_QUEUED) {
        // Не доставлено. Держим до следующего рейса, но не бесконечно.
        queued = queued.slice(-MAX_QUEUED);
      }
      saveOutbox();
      inspectResults(batch, data);
      return data;
    } finally {
      inFlight--;
      // Whatever did not fit (or came back undelivered) needs its own trip; the
      // 10s poll would drain it eventually, but only 50 taps per poll.
      if (queued.length && !flushTimer) {
        flushTimer = setTimeout(() => { flushTimer = null; deliver([]); }, FLUSH_MS);
      }
    }
  };
  // Serialized: the server compare-and-swaps on `version`, so two batches in
  // flight at once would make the second lose to a conflict.
  const p = actionChain.then(run, run);
  actionChain = p.catch(() => null);
  return p;
}

async function post(batch) {
  // A batch of nothing but polls carries no player intent, so a lost one costs
  // nothing and the next tick covers it — whereas retrying would stack polls
  // behind each other and keep feeding the very limit we back off from.
  const idle = batch.every((a) => a.type === "touch");
  const attempts = idle ? 1 : RETRY_DELAYS_MS.length + 1;
  for (let i = 0; i < attempts; i++) {
    // Every request shares one backoff: while the edge is blocking this IP the
    // next one would only be blocked too, and would restart the block's clock.
    const wait = blockedUntil - Date.now();
    if (wait > 0) await sleep(wait);
    if (!serverAuth()) return null; // account deleted while we waited
    let res;
    try {
      res = await fetch(`${BACKEND_URL}/api/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...creds(), actions: batch, seqEpoch }),
      });
    } catch (_) {
      return null; // offline: the poll reconciles once the network is back
    }
    if (res.status === 429) {
      const first = !throttled();
      blockedUntil = Date.now() + RETRY_DELAYS_MS[Math.min(i, RETRY_DELAYS_MS.length - 1)];
      if (first && onThrottle) onThrottle();
      continue;
    }
    blockedUntil = 0;
    // Anything else non-JSON (a 5xx HTML page from the edge) is a failure we
    // can't retry our way out of, and must not throw past the caller.
    let data = null;
    try { data = await res.json(); } catch (_) { return null; }
    if (data) flags.apply(data.flags);
    return data && data.ok ? data : null;
  }
  return null;
}

// Immediate delivery: the buffer plus this one action, awaited. For actions the
// player is watching the result of, and for the 10s poll.
export function action(type, args) {
  if (!serverAuth()) return Promise.resolve(null);
  return deliver([{ seq: nextSeq(), type, args: args || {}, at: Date.now() }]);
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
