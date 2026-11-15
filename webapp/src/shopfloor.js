// Animated customers on the shop floor. A customer walks in from off-screen,
// crosses to a stocked shelf, takes one item, then lines up along the open strip
// below the shelves (up to MAX_QUEUE). If the queue is already full when they
// enter, they browse and leave without taking anything.
//
// Paying: the customer at the front of the line carries a price tag and is the
// tap target (serveFront) — there is no drawn register or door, so the shelves
// get the full screen and their cells match the garden's and kitchen's. Only the
// front one is tappable, exactly like a real queue: the server's `serve` action
// pays the front entry, so nothing about the model had to change.
//
// Visual agents live in the fixed #floor overlay (pointer-events: none, lifted
// per-agent for the front one) so the generic render() rebuilding the shop screen
// doesn't disturb them. Targets are read from live DOM rects, so positions stay
// correct across re-renders.

import { state } from "./game.js";
import * as game from "./game.js";
import * as econ from "./economy.js";
import * as art from "./art.js";
import { fmtNum } from "./i18n.js";

// The game's own customers when it has art (glyphs art.js swaps for pictures).
const FACES = art.faces(["🧑", "👩", "👨", "🧓", "👦", "🧔", "👱", "👵", "🧕", "👳", "👲", "🙎"]);
const SPEED = 150; // px per second

let overlay = null;
let running = false;
let queueAgents = []; // aligned with state.queue (front = index 0)

// ── visit generation ─────────────────────────────────────────────────────────
// Every customer is a running async function parked on an `await` — a move, a
// pause at a shelf, a stagger before stepping through the door. Leaving the shop
// used to drop them by reassigning `queueAgents = []` and emptying the overlay,
// which discards the AGENTS but not the functions still walking them.
//
// Those functions resumed on the next await and checked `!a.alive || !running`.
// Neither caught them: nothing had set `alive = false`, and `running` was true
// again the moment the player came back. So a customer from the previous visit
// carried on inside the NEW one — taking a place in the line, calling
// refreshFront(), releasing a reservation on a shelf that belonged to somebody
// else. That is what "customers randomly appear in the queue when I switch
// screens quickly" was.
//
// So each visit gets a number. A walk captures it and is inert the moment it no
// longer matches — no flag to remember to set, and it cannot be resurrected by
// the player returning, because coming back is a NEW number, not the old one.
let generation = 0;

// Every agent currently on the floor, queued or not. queueAgents only holds the
// ones in line; browsers and customers still walking to a shelf live only here,
// which is why leaving could not find them to kill them.
const agents = new Set();

// True when this walk no longer belongs to the visit on screen.
function stale(a, gen) { return !a.alive || gen !== generation; }

// ── shelf reservations ───────────────────────────────────────────────────────
// The server decrements a shelf the moment it spawns the customer who bought
// from it, and the client learns about both together on the next poll. Drawn
// literally, that means the goods vanish and only THEN does someone walk across
// the shop and mime taking them off an empty shelf — the single most-reported
// thing that looked broken.
//
// So the floor keeps a count, per shelf, of customers who are on their way to it
// and have not reached it yet, and ui.js adds that back when drawing the shelf.
// It is purely cosmetic: the economy already happened server-side and nothing
// here touches state. The shelf empties on screen at the moment a customer
// actually takes from it, which is what the player expects to see.
const reserved = new Map();
// What the reserved units ARE. Needed because the server clears `cell.item` as
// soon as the last unit is spoken for, so the cell itself can no longer say what
// is still standing on it.
const heldItem = new Map();

export function reservedAt(i) { return reserved.get(i) || 0; }
export function itemAt(i) { return heldItem.get(i) || ""; }

// Told to ui.js so a shelf can be repainted the moment its reservation clears.
let onShelfChange = () => {};
export function onShelf(fn) { onShelfChange = fn; }

function reserve(a, i, item) {
  if (!(i >= 0)) return;
  a.shelf = i;
  reserved.set(i, (reserved.get(i) || 0) + 1);
  if (item) heldItem.set(i, item);
  onShelfChange(i);
}

// Idempotent: called when the customer takes the item, and again if the agent is
// removed before getting there (screen left, served server-side mid-walk). A
// reservation that outlived its agent would leave phantom goods on the shelf.
function unreserve(a) {
  const i = a.shelf;
  if (!(i >= 0)) return;
  a.shelf = -1;
  // Leaving the shop clears the whole map, so a late arrival from a dropped walk
  // can land here with nothing to release. Going negative would make the NEXT
  // visit's counts wrong, which is worse than doing nothing.
  const held = reserved.get(i) || 0;
  if (held <= 0) return;
  if (held > 1) reserved.set(i, held - 1);
  else { reserved.delete(i); heldItem.delete(i); }
  onShelfChange(i);
}

// ── geometry (read live DOM each time) ───────────────────────────────────────

function screenRect() { return document.getElementById("screen").getBoundingClientRect(); }

// The queue lives on the open floor under the shelves: customers come in from the
// left, line up facing right, and leave to the right once paid — so a newcomer
// never walks through the people already waiting.
const SLOT_GAP = 44;
function lineY() { return screenRect().bottom - 52; }
function doorPos() { const s = screenRect(); return { x: s.left - 60, y: lineY() }; }
function exitPos() { const s = screenRect(); return { x: s.right + 60, y: lineY() }; }
function slotPos(i) { const s = screenRect(); return { x: s.right - 64 - i * SLOT_GAP, y: lineY() }; }
function shelfPos(idx) {
  const cells = document.querySelectorAll("#screen .cell");
  const el = cells[idx]; if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2 - 18, y: r.top + r.height - 34 };
}
function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── agents ───────────────────────────────────────────────────────────────────

function makeAgent() {
  const el = document.createElement("div");
  el.className = "cs";
  el.innerHTML = `<span class="cs-face">${rnd(FACES)}</span><span class="cs-item"></span>` +
    `<span class="cs-pay"></span>`;
  // Only the front customer ever has pointer events (see refreshFront), so this
  // can't fire for someone still in line or walking.
  el.onclick = () => {
    const gain = serveFront();
    if (gain > 0) onServed(gain);
  };
  overlay.appendChild(el);
  const a = { el, x: 0, y: 0, item: "", arrived: false, alive: true, shelf: -1, inLine: false };
  agents.add(a);
  return a;
}

// Strip the price tag off someone who is leaving (paid, or gone server-side):
// they're out of the line, so they shouldn't still be advertising a price.
function clearTag(a) {
  a.el.classList.remove("front");
  const tag = a.el.querySelector(".cs-pay");
  if (tag) tag.textContent = "";
}

// Put everyone who belongs in the line at the slot their CURRENT index calls for.
//
// One place decides positions, and that is the point. Three places used to: a
// newcomer picked a slot with queueAgents.indexOf(a) after its awaits had already
// resolved, and serveFront() re-seated only agents with `arrived === true`. So
// serving somebody while a newcomer was still walking left that newcomer heading
// for a slot that had just shifted — and two customers ended up standing in the
// same spot. Re-seating everyone, walkers included, makes a stale target
// impossible: whatever moved, the next relayout corrects it.
//
// Returns `who`'s own arrival promise, so a caller waiting to be in place does not
// have to duplicate the travel-time arithmetic (and cannot get it wrong when a
// later relayout re-targets them mid-walk).
function relayout(who = null) {
  let arrival = null;
  queueAgents.forEach((a, i) => {
    if (!a.alive || !a.inLine) return;
    const p = slotPos(i);
    // Already aimed there: leave them alone. render() calls this on every pass
    // now, and re-issuing a transition to the coordinates an agent is already
    // heading for would restart it — a queue that never quite settles.
    if (Math.abs(a.x - p.x) < 0.5 && Math.abs(a.y - p.y) < 0.5) {
      if (a === who) arrival = Promise.resolve();
      return;
    }
    // Someone already standing shuffles up briskly; someone still crossing the
    // shop keeps the walking pace they came in at.
    const done = move(a, p.x, p.y, a.arrived ? SPEED * 1.4 : SPEED);
    if (a === who) arrival = done;
  });
  return arrival;
}

// Who's payable right now: the front of the line, once they've actually arrived.
// Everyone else is inert, so a stray tap can't collect the wrong customer.
function refreshFront() {
  queueAgents.forEach((a, i) => {
    const isFront = i === 0 && a.arrived;
    a.el.classList.toggle("front", isFront);
    const tag = a.el.querySelector(".cs-pay");
    if (!tag) return;
    const entry = state.queue[i];
    tag.textContent = isFront && entry ? `+${fmtNum(Math.round(entry.price))}` : "";
  });
}

// Told to ui.js so a paid customer still produces a toast and feeds the coach.
let onServed = () => {};
export function onServe(fn) { onServed = fn; }
function place(a, x, y) { a.x = x; a.y = y; a.el.style.transition = "none"; a.el.style.transform = `translate(${x}px,${y}px)`; }
function move(a, x, y, speed = SPEED) {
  const dist = Math.hypot(x - a.x, y - a.y);
  const ms = Math.max(220, (dist / speed) * 1000);
  const face = a.el.querySelector(".cs-face");
  if (face) face.style.transform = x < a.x ? "scaleX(-1)" : "scaleX(1)";
  a.x = x; a.y = y;
  a.el.style.transition = `transform ${ms}ms linear`;
  requestAnimationFrame(() => { a.el.style.transform = `translate(${x}px,${y}px)`; });
  return wait(ms);
}
function carry(a, item) {
  a.item = item;
  const def = econ.itemDef(item);
  a.el.querySelector(".cs-item").textContent = def ? def.icon : "";
  a.el.classList.add("carrying");
}
function removeAgent(a) {
  a.alive = false;
  agents.delete(a);
  unreserve(a); // no-op unless they were still walking to a shelf
  if (a.el && a.el.parentNode) a.el.remove();
}

// ── lifecycle of one walk-in ─────────────────────────────────────────────────

// Driven by the global ticker while the shop screen is open.
export async function spawnAnimated() {
  if (!running) return;
  const gen = generation;
  const a = makeAgent();
  const d = doorPos();
  place(a, d.x, d.y);
  const s = screenRect();
  await move(a, s.left + s.width * 0.32, s.top + s.height * 0.42);
  if (stale(a, gen)) return;

  const shelves = game.stockedShelfIndices();
  if (game.queueFull() || shelves.length === 0) return browseLeave(a, gen);

  const target = rnd(shelves);
  const sp = shelfPos(target);
  if (!sp) return browseLeave(a, gen);
  await move(a, sp.x, sp.y);
  if (stale(a, gen)) return;
  await wait(380); // reach up and take

  const picked = game.pickFromCell(target); // decrements shelf + pushes to state.queue
  if (!picked) return browseLeave(a, gen); // shelf emptied or queue filled meanwhile
  carry(a, picked.item);

  queueAgents.push(a);
  a.inLine = true;
  await relayout(a);
  if (stale(a, gen)) return;
  a.arrived = true;
  refreshFront();
}

async function browseLeave(a, gen) {
  a.el.classList.add("browsing");
  await wait(800);
  if (stale(a, gen)) return;
  a.el.classList.remove("browsing");
  const e = exitPos();
  await move(a, e.x, e.y);
  removeAgent(a);
}

// ── public ───────────────────────────────────────────────────────────────────

// Pay the front customer (must have arrived), animate them out, shuffle the rest
// up. Returns coins earned (0 if none ready). Called by the tap on that customer,
// and by the auto-register perk.
export function serveFront() {
  const front = queueAgents[0];
  if (!front) {
    // No visual agents (e.g., queue restored but overlay not materialized yet)
    // — still serve logically so payment never depends on the animation.
    return state.queue.length ? game.collectPayment() : 0;
  }
  if (!front.arrived) return 0; // still walking to their place in line
  if (!state.queue.length) return 0;

  // Out of the line BEFORE the payment, and that order is load-bearing.
  // collectPayment() shifts state.queue and re-renders synchronously, and
  // render() now levels the floor with the queue — so if this agent were still
  // counted in queueAgents at that moment, the floor would look one agent too
  // long and syncToQueue would send the NEWEST arrival to the exit to make the
  // numbers match. The person paying would stay and a stranger would be shown
  // the door.
  queueAgents.shift();
  front.arrived = false;
  front.inLine = false;
  // Drop the tap target immediately: they're walking out, and a second tap on
  // the way would collect from whoever is now first without them looking payable.
  clearTag(front);

  const gain = game.collectPayment(); // shifts state.queue (also re-renders)
  front.el.classList.add("paid");
  const e = exitPos();
  move(front, e.x, e.y).then(() => removeAgent(front));
  relayout();                                // re-seats everyone, walkers included
  refreshFront();
  return gain;
}

// When the next newcomer is allowed to step through the door. A poll can hand us
// several customers at once — they were spawned seconds apart on the server, but
// we only hear about them together — and walking them all in shoulder to
// shoulder is what made arrivals look random and clumped. They enter one at a
// time instead, spaced by how far apart they actually arrived.
let nextWalkAt = 0;

function walkGap(prev, cur) {
  const dt = (prev && cur && prev.at && cur.at) ? cur.at - prev.at : 0;
  const fallback = econ.npcSpawnInterval(state.shop) * 1000;
  // Floor: two people never overlap in the doorway. Ceiling: after a long
  // absence the queue is filled in one go and honouring hours of real spacing
  // would leave the shop looking empty.
  return Math.min(5000, Math.max(900, dt > 0 ? dt : fallback));
}

// Server-authoritative: the server is the sole spawner, so the floor mirrors
// state.queue (updated by reconcile). Newcomers walk the full path (door → shelf
// → line) so it looks like the legacy loop; extras (served/left on the
// server) head for the exit. Purely visual — the economy already happened server-
// side; this never mutates state.queue.
export function syncToQueue() {
  if (!running) return;
  while (queueAgents.length > state.queue.length) {
    const a = queueAgents.pop();
    if (!a) break;
    a.arrived = false;
    a.inLine = false;
    clearTag(a);
    a.el.classList.add("paid");
    const e = exitPos();
    move(a, e.x, e.y).then(() => removeAgent(a));
  }
  while (queueAgents.length < state.queue.length) {
    const i = queueAgents.length;
    const a = makeAgent();
    queueAgents.push(a); // hold the slot now so the count stays aligned
    const now = Date.now();
    const delay = Math.max(0, nextWalkAt - now);
    nextWalkAt = Math.max(now, nextWalkAt) + walkGap(state.queue[i - 1], state.queue[i]);
    walkInToLine(a, state.queue[i], delay);
  }
  relayout();   // the served ones left a gap; whoever is left closes it
  refreshFront();
}

// Walk a queued customer in: door → the shelf they bought from (taking the item)
// → their slot in the line. The entry comes from the server.
async function walkInToLine(a, entry, delay = 0) {
  const gen = generation;
  const d = doorPos();
  place(a, d.x, d.y);              // parked off-screen at the door until their turn

  // The shelf this customer actually bought from — the server says so now
  // (`from`), where before this could only be guessed from the item they carry.
  // Reserved straight away, so the goods stay drawn on that shelf for the whole
  // walk rather than disappearing the moment the server told us about the sale.
  const shelves = game.stockedShelfIndices();
  let target = entry && Number.isInteger(entry.from) ? entry.from : -1;
  if (target < 0) target = entry ? game.shelfIndexForItem(entry.item) : -1;
  if (target < 0 && shelves.length) target = rnd(shelves);
  if (target >= 0) reserve(a, target, entry && entry.item);

  if (delay > 0) {
    await wait(delay);
    if (stale(a, gen)) return;
  }

  if (target >= 0) {
    const sp = shelfPos(target);
    if (sp) {
      await move(a, sp.x, sp.y);
      if (stale(a, gen)) return;
      await wait(320);
      if (stale(a, gen)) return;
    }
    unreserve(a);                  // taken off the shelf — now it may empty on screen
  } else {
    const s = screenRect();
    await move(a, s.left + s.width * 0.4, s.top + s.height * 0.45);
    if (stale(a, gen)) return;
  }
  if (entry) carry(a, entry.item);
  // From here the line owns this customer's position: relayout() re-seats them
  // if the queue shifts while they are still crossing the floor.
  a.inLine = true;
  await relayout(a);
  if (stale(a, gen)) return;
  a.arrived = true;
  refreshFront();
}

// A decorative browser: walks in, looks around (❓), and leaves. Never joins the
// queue — used for liveliness when the queue is full or the shelves are empty.
export function spawnBrowser() {
  if (!running) return;
  const gen = generation;
  const a = makeAgent();
  const d = doorPos();
  place(a, d.x, d.y);
  const shelves = game.stockedShelfIndices();
  const s = screenRect();
  const mid = shelves.length ? shelfPos(rnd(shelves)) : { x: s.left + s.width * 0.4, y: s.top + s.height * 0.45 };
  move(a, mid.x, mid.y).then(async () => {
    if (stale(a, gen)) return;
    a.el.classList.add("browsing");
    await wait(800);
    if (stale(a, gen)) return;
    a.el.classList.remove("browsing");
    const e = exitPos();
    await move(a, e.x, e.y);
    removeAgent(a);
  });
}

// Draw the line as it stands right now: everyone already waiting, placed at their
// slot. No walk-in — they were queued before the player opened the shop, and
// making them stroll in would leave the front customer unpayable for seconds.
//
// It clears the floor first, and that is a fix rather than tidiness. It used to
// only reset `queueAgents`, leaving the previous batch's DOM nodes in the overlay
// — so a second materialize drew a second set of customers exactly on top of the
// first. Reachable by simply tapping the Лавка tab while already in the shop:
// setScreen() only calls leave() when moving AWAY from it, so that tap was an
// enter() with no leave, and the queue silently doubled.
function materialize() {
  clearFloor();
  state.queue.forEach((c, i) => {
    const a = makeAgent();
    const s = slotPos(i);
    place(a, s.x, s.y);
    carry(a, c.item);
    a.arrived = true;
    a.inLine = true;
    queueAgents.push(a);
  });
  refreshFront();
}

// Take everyone off the floor: kill first, then empty. Killing matters more than
// emptying — a dropped agent whose walk is still parked on an await has to find
// itself dead when it resumes (see the generation note at the top).
function clearFloor() {
  for (const a of agents) a.alive = false;
  agents.clear();
  queueAgents = [];
  reserved.clear();
  heldItem.clear();
  nextWalkAt = 0;
  if (overlay) overlay.replaceChildren();
}

export function enter() {
  // Idempotent. setScreen() calls this on every tap of the shop tab, including
  // taps made while the shop is already open — and those come with no matching
  // leave(). Re-entering would rebuild a floor that is already correct.
  if (running) return;
  overlay = document.getElementById("floor");
  overlay.classList.add("active");
  generation++;            // a new visit; anything still walking belongs to the old one
  running = true;
  clearFloor();
  scheduleMaterialize(generation);
}

// Draw the floor once the shop DOM has laid out, so slotPos() reads real rects.
//
// rAF is the right trigger and an unreliable one: a hidden document does not fire
// it at all, and this runs inside a Telegram mini app and a WKWebView, both of
// which get suspended on a whim. If the only trigger never fires, the floor is
// never built — and since enter() is now idempotent, coming back would not
// retry it, leaving a shop with a full register and nobody standing in it.
//
// So: whichever comes first, the frame or the timeout. Both funnel through one
// latch, and both re-check the generation, so a visit that ended in between
// draws nothing.
function scheduleMaterialize(gen) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    if (running && gen === generation) materialize();
  };
  requestAnimationFrame(run);
  setTimeout(run, 120);
}

export function leave() {
  running = false;
  generation++;            // everything in flight is now stale and will bail on resume
  clearFloor();
  if (overlay) overlay.classList.remove("active");
}
