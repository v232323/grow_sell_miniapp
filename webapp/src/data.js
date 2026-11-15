// Loads the game data: shared/<game>/gamedata (profile.js picks the game).
// Single source of truth for the client, the worker and the iOS bundle —
// presentation lives in the app; rules and content live in these JSON files.

import { profile } from "./profile.js";

// Web deployment serves the repo root, so the app at /webapp/ reaches the data
// one level up (each game has its own folder, see profile.js). The iOS bundle
// has a flat layout instead and overrides this via window.GAMEDATA_BASE (set by
// ios-app/scripts/lib-bundle.mjs).
const BASE = window.GAMEDATA_BASE || profile.gamedataBase;

export const data = {
  economy: null,
  resources: [],
  products: [],
  recipes: [],
  resourceById: {},
  productById: {},
};

export async function loadData() {
  const [economy, resources, products, recipes] = await Promise.all([
    fetchJson("economy.json"),
    fetchJson("resources.json"),
    fetchJson("products.json"),
    fetchJson("recipes.json"),
  ]);
  data.economy = economy;
  data.resources = resources.resources;
  data.products = products.products;
  data.recipes = recipes.recipes;
  for (const r of data.resources) data.resourceById[r.id] = r;
  for (const p of data.products) data.productById[p.id] = p;
  return data;
}

async function fetchJson(name) {
  const res = await fetch(BASE + name, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load ${name}: ${res.status}`);
  return res.json();
}
