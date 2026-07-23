// Animated customers on the shop floor. A customer walks in from the door,
// crosses to a stocked shelf, takes one item, then lines up at the register
// (nearest slot first, up to MAX_QUEUE). If the queue is already full when they
// enter, they browse and leave without taking anything. Tapping the register
// (serveFront) pays the front customer, who then leaves; the rest shuffle up.
//
// Visual agents live in the fixed #floor overlay (pointer-events: none) so the
// generic render() rebuilding the shop screen doesn't disturb them. Targets are
// read from live DOM rects, so positions stay correct across re-renders.

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
function regRect() {
  const el = document.getElementById("register-anchor");
  return el ? el.getBoundingClientRect() : null;
}
function doorPos() { const s = screenRect(); return { x: s.left + 14, y: s.bottom - 96 }; }
function exitPos() { const s = screenRect(); return { x: s.left - 70, y: s.bottom - 96 }; }
function slotPos(i) {
  const r = regRect(); if (!r) return doorPos();
  return { x: r.left - 42 - i * 40, y: r.top - 6 };
}
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
  el.innerHTML = `<span class="cs-face">${rnd(FACES)}</span><span class="cs-item"></span>`;
  overlay.appendChild(el);
  return { el, x: 0, y: 0, item: "", arrived: false, alive: true };
}
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

// Tap the register: pay the front customer (must have arrived), animate them
// out, shuffle the rest up. Returns coins earned (0 if none ready).
export function serveFront() {
  const front = queueAgents[0];
  if (!front) {
    // No visual agents (e.g., queue restored but overlay not materialized yet)
    // — still serve logically so the register always works.
    return state.queue.length ? game.collectPayment() : 0;
  }
  if (!front.arrived) return 0; // still walking to the register
  const gain = game.collectPayment(); // shifts state.queue (also re-renders)
  queueAgents.shift();
  front.arrived = false;
  front.el.classList.add("paid");
  const e = exitPos();
  move(front, e.x, e.y).then(() => removeAgent(front));
  queueAgents.forEach((ag, i) => { if (ag.arrived) { const s = slotPos(i); move(ag, s.x, s.y, SPEED * 1.4); } });
  return gain;
}

// Server-authoritative: the server is the sole spawner, so the floor mirrors
// state.queue (updated by reconcile). Newcomers walk the full path (door → shelf
// → register) so it looks like the legacy loop; extras (served/left on the
// server) head for the exit. Purely visual — the economy already happened server-
// side; this never mutates state.queue.
export function syncToQueue() {
  if (!running) return;
  while (queueAgents.length > state.queue.length) {
    const a = queueAgents.pop();
    if (!a) break;
    a.arrived = false;
    a.el.classList.add("paid");
    const e = exitPos();
    move(a, e.x, e.y).then(() => removeAgent(a));
  }
  while (queueAgents.length < state.queue.length) {
    const a = makeAgent();
    queueAgents.push(a); // reserve the slot now so the count stays aligned
    walkInToRegister(a, state.queue[queueAgents.length - 1]);
  }
}

// Walk a queued customer in: door → a stocked shelf (mime taking the item) →
// their register slot. The item comes from the server's queue entry.
async function walkInToRegister(a, entry) {
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
  if (a.alive) a.arrived = true;
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
