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

const FACES = ["🧑", "👩", "👨", "🧓", "👦", "🧔", "👱", "👵", "🧕", "👳", "👲", "🙎"];
const SPEED = 150; // px per second

let overlay = null;
let running = false;
let queueAgents = []; // aligned with state.queue (front = index 0)

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
  return { el, x: 0, y: 0, item: "", arrived: false, alive: true };
}

// Strip the price tag off someone who is leaving (paid, or gone server-side):
// they're out of the line, so they shouldn't still be advertising a price.
function clearTag(a) {
  a.el.classList.remove("front");
  const tag = a.el.querySelector(".cs-pay");
  if (tag) tag.textContent = "";
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
    tag.textContent = isFront && entry ? `+${Math.round(entry.price)}` : "";
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
  if (a.el && a.el.parentNode) a.el.remove();
}

// ── lifecycle of one walk-in ─────────────────────────────────────────────────

// Driven by the global ticker while the shop screen is open.
export async function spawnAnimated() {
  if (!running) return;
  const a = makeAgent();
  const d = doorPos();
  place(a, d.x, d.y);
  const s = screenRect();
  await move(a, s.left + s.width * 0.32, s.top + s.height * 0.42);
  if (!a.alive || !running) return;

  const shelves = game.stockedShelfIndices();
  if (game.queueFull() || shelves.length === 0) return browseLeave(a);

  const target = rnd(shelves);
  const sp = shelfPos(target);
  if (!sp) return browseLeave(a);
  await move(a, sp.x, sp.y);
  if (!a.alive || !running) return;
  await wait(380); // reach up and take

  const picked = game.pickFromCell(target); // decrements shelf + pushes to state.queue
  if (!picked) return browseLeave(a); // shelf emptied or queue filled meanwhile
  carry(a, picked.item);

  queueAgents.push(a);
  const slot = queueAgents.length - 1;
  const q = slotPos(slot);
  await move(a, q.x, q.y);
  a.arrived = true;
  refreshFront();
}

async function browseLeave(a) {
  a.el.classList.add("browsing");
  await wait(800);
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
  const gain = game.collectPayment(); // shifts state.queue (also re-renders)
  queueAgents.shift();
  front.arrived = false;
  // Drop the tap target immediately: they're walking out, and a second tap on
  // the way would collect from whoever is now first without them looking payable.
  clearTag(front);
  front.el.classList.add("paid");
  const e = exitPos();
  move(front, e.x, e.y).then(() => removeAgent(front));
  queueAgents.forEach((ag, i) => { if (ag.arrived) { const s = slotPos(i); move(ag, s.x, s.y, SPEED * 1.4); } });
  refreshFront();
  return gain;
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
    clearTag(a);
    a.el.classList.add("paid");
    const e = exitPos();
    move(a, e.x, e.y).then(() => removeAgent(a));
  }
  while (queueAgents.length < state.queue.length) {
    const a = makeAgent();
    queueAgents.push(a); // reserve the slot now so the count stays aligned
    walkInToLine(a, state.queue[queueAgents.length - 1]);
  }
  refreshFront();
}

// Walk a queued customer in: door → a stocked shelf (mime taking the item) →
// their slot in the line. The item comes from the server's queue entry.
async function walkInToLine(a, entry) {
  const d = doorPos();
  place(a, d.x, d.y);
  const shelves = game.stockedShelfIndices();
  // Walk to the shelf that actually sells what this customer carries; fall back
  // to any stocked shelf only if that item's shelf has already sold out.
  let target = entry ? game.shelfIndexForItem(entry.item) : -1;
  if (target < 0 && shelves.length) target = rnd(shelves);
  if (target >= 0) {
    const sp = shelfPos(target);
    if (sp) { await move(a, sp.x, sp.y); if (!a.alive || !running) return; await wait(320); }
  } else {
    const s = screenRect();
    await move(a, s.left + s.width * 0.4, s.top + s.height * 0.45);
    if (!a.alive || !running) return;
  }
  if (entry) carry(a, entry.item);
  const slot = queueAgents.indexOf(a);
  const q = slotPos(slot < 0 ? queueAgents.length - 1 : slot);
  await move(a, q.x, q.y);
  if (a.alive) { a.arrived = true; refreshFront(); }
}

// A decorative browser: walks in, looks around (❓), and leaves. Never joins the
// queue — used for liveliness when the queue is full or the shelves are empty.
export function spawnBrowser() {
  if (!running) return;
  const a = makeAgent();
  const d = doorPos();
  place(a, d.x, d.y);
  const shelves = game.stockedShelfIndices();
  const s = screenRect();
  const mid = shelves.length ? shelfPos(rnd(shelves)) : { x: s.left + s.width * 0.4, y: s.top + s.height * 0.45 };
  move(a, mid.x, mid.y).then(async () => {
    if (!a.alive || !running) return;
    a.el.classList.add("browsing");
    await wait(800);
    a.el.classList.remove("browsing");
    const e = exitPos();
    await move(a, e.x, e.y);
    removeAgent(a);
  });
}

function materialize() {
  queueAgents = [];
  state.queue.forEach((c, i) => {
    const a = makeAgent();
    const s = slotPos(i);
    place(a, s.x, s.y);
    carry(a, c.item);
    a.arrived = true;
    queueAgents.push(a);
  });
  refreshFront();
}

export function enter() {
  overlay = document.getElementById("floor");
  overlay.classList.add("active");
  running = true;
  // let the shop DOM lay out before reading rects
  requestAnimationFrame(() => { if (running) materialize(); });
}

export function leave() {
  running = false;
  queueAgents = [];
  if (overlay) { overlay.replaceChildren(); overlay.classList.remove("active"); }
}
