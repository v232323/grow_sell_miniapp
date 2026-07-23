// Loads the shared game-data layer (single source of truth, shared with the
// Godot game under /shared/gamedata). Presentation lives in the app; rules and
// content live in these JSON files.

const BASE = "../shared/gamedata/";

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
