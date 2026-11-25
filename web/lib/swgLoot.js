/**
 * SWG ship component loot, read from the server scripts:
 *
 *   bin/scripts/loot/items/ship/components/<type>/<item>.lua   stat ranges per looted component
 *   bin/scripts/loot/groups/**.lua                               loot groups (items or other groups, weights)
 *   bin/scripts/ship_mobile/ships/*.lua                          NPC ships: lootChance + lootTable
 *
 * How the server rolls (LootManagerImplementation / LootValues):
 * - a ship drops loot with probability lootChance (rolled against 10,000,000);
 * - its lootTable is a loot group; a group picks one entry with probability weight / 10,000,000
 *   (System::random(10000000)), following nested groups until it reaches an item;
 * - every ship component stat except reverseengineeringlevel is rolled NORMAL (LootAttributeType),
 *   see public/swg-loot-calc.js for the distribution.
 */

const ROLL = 10000000;

const TYPES = ['armor', 'booster', 'droid_interface', 'engine', 'reactor', 'shield_generator', 'weapon', 'weapon_capacitor'];

function stripComments(text) {
  return text.replace(/--\[\[[\s\S]*?\]\]/g, '').replace(/--[^\n]*/g, '');
}

/** One loot item file → { id, tier, stats: { stat: [min, max, precision] } } */
function parseLootItem(text) {
  const src = stripComments(text);
  const id = (src.match(/addLootItemTemplate\(\s*"([^"]+)"/) || src.match(/^\s*([A-Za-z0-9_]+)\s*=\s*\{/m) || [])[1];
  const block = src.match(/craftingValues\s*=\s*\{([\s\S]*?)\n\s*\},/);
  if (!id || !block) return null;
  const stats = {};
  let tier = null;
  const re = /\{\s*"([A-Za-z0-9_]+)"\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)(?:\s*,\s*(\d+))?/g;
  let m;
  while ((m = re.exec(block[1]))) {
    const [, key, a, b, p] = m;
    if (key === 'reverseengineeringlevel') tier = Number(a);
    else stats[key] = [Number(a), Number(b), p == null ? 0 : Number(p)];
  }
  return { id, tier, stats };
}

/** One loot group file → { name, entries: [{ group | item, weight }] } */
function parseLootGroup(text) {
  const src = stripComments(text);
  const name = (src.match(/addLootGroupTemplate\(\s*"([^"]+)"/) || [])[1];
  const block = src.match(/lootItems\s*=\s*\{([\s\S]*)\}/);
  if (!name || !block) return null;
  const entries = [];
  const re = /\{\s*(groupTemplate|itemTemplate)\s*=\s*"([^"]+)"\s*,\s*weight\s*=\s*(\d+)\s*\}/g;
  let m;
  while ((m = re.exec(block[1]))) {
    entries.push(m[1] === 'groupTemplate' ? { group: m[2], weight: Number(m[3]) } : { item: m[2], weight: Number(m[3]) });
  }
  return { name, entries };
}

/** One NPC ship file → { id, lootChance, lootRolls, lootTable, faction, ship } */
function parseShipAgent(text) {
  const src = stripComments(text);
  const id = (src.match(/addShipAgentTemplate\(\s*[A-Za-z0-9_]+\s*,\s*"([^"]+)"/) || [])[1];
  if (!id) return null;
  const num = (k) => {
    const m = src.match(new RegExp('\\b' + k + '\\s*=\\s*(-?[\\d.]+)'));
    return m ? Number(m[1]) : null;
  };
  const str = (k) => {
    const m = src.match(new RegExp('\\b' + k + '\\s*=\\s*"([^"]*)"'));
    return m ? m[1] : null;
  };
  return {
    id,
    lootChance: num('lootChance') || 0,
    lootRolls: num('lootRolls'),
    lootTable: str('lootTable') || '',
    faction: str('spaceFaction') || '',
    ship: str('template') || '',
  };
}

/**
 * What rolling `name` once can give: { groups: Map(leafGroup → p), items: Map(item → p) }.
 * A leaf group lists only items; it is kept as a unit (stored once in the data file) and its
 * items' chances are weight / 10,000,000, as the server rolls them.
 */
function resolveMix(name, groups, cache, depth = 0) {
  if (cache.has(name)) return cache.get(name);
  const out = { groups: new Map(), items: new Map() };
  cache.set(name, out); // guards against loops
  const g = groups.get(name);
  const add = (map, k, p) => map.set(k, (map.get(k) || 0) + p);
  if (!g) add(out.items, name, 1); // an item used directly as a loot table
  else if (isLeaf(g)) add(out.groups, name, 1);
  else if (depth < 32) {
    for (const e of g.entries) {
      const p = e.weight / ROLL;
      if (e.item) add(out.items, e.item, p);
      else {
        const sub = resolveMix(e.group, groups, cache, depth + 1);
        for (const [k, q] of sub.groups) add(out.groups, k, p * q);
        for (const [k, q] of sub.items) add(out.items, k, p * q);
      }
    }
  }
  return out;
}
const isLeaf = (g) => g.entries.length > 0 && g.entries.every((e) => e.item);

/** Flattened: Map(item → probability) for one roll of `name`. */
function resolveTable(name, groups, cache = new Map()) {
  const mix = resolveMix(name, groups, cache);
  const out = new Map(mix.items);
  for (const [gname, p] of mix.groups) for (const e of groups.get(gname).entries) out.set(e.item, (out.get(e.item) || 0) + (p * e.weight) / ROLL);
  return out;
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/** Stat names without the common prefix: "ship_component_mass" → "mass" */
const shortStat = (k) => k.replace(/^ship_component_/, '');

/**
 * items: [{ type, text }], groups: [text], ships: [text] →
 * {
 *   items:  [{ id, type, tier, stats: { stat: [listed min, listed max, precision] } }]
 *   groups: { leafGroup: [[itemIndex, chance], ...] }          chance = weight / 10,000,000
 *   tables: { table: { g: [[leafGroup, p], ...], i: [[itemIndex, p], ...] } }
 *   npcs:   [[id, lootChance, lootRolls, table, faction], ...]
 * }
 * Only ship-component items, tables that can give one, and ships that roll loot are kept.
 */
function buildLootData({ items, groups, ships }) {
  const outItems = [];
  for (const { type, text } of items) {
    const it = parseLootItem(text);
    if (!it || !TYPES.includes(type) || !(it.tier >= 1)) continue;
    const stats = {};
    for (const [k, v] of Object.entries(it.stats)) stats[shortStat(k)] = v;
    outItems.push({ id: it.id, type, tier: it.tier, stats });
  }
  outItems.sort((a, b) => a.type.localeCompare(b.type) || a.tier - b.tier || a.id.localeCompare(b.id));
  const index = new Map(outItems.map((it, i) => [it.id, i]));

  const groupMap = new Map();
  for (const t of groups) {
    const g = parseLootGroup(t);
    if (g) groupMap.set(g.name, g);
  }

  const cache = new Map();
  const tables = {};
  const leafGroups = {};
  const npcs = [];
  const unknownTables = new Set();
  for (const t of ships) {
    const s = parseShipAgent(t);
    // lootRolls = loot attempts per kill (ShipObject::…); the template default is 0 = no loot
    if (!s || !(s.lootChance > 0) || !s.lootTable || !(s.lootRolls > 0)) continue;
    if (!tables[s.lootTable]) {
      if (!groupMap.has(s.lootTable) && !index.has(s.lootTable)) {
        unknownTables.add(s.lootTable);
        continue;
      }
      const mix = resolveMix(s.lootTable, groupMap, cache);
      const g = [];
      for (const [name, p] of mix.groups) {
        const entries = groupMap.get(name).entries.filter((e) => index.has(e.item)).map((e) => [index.get(e.item), e.weight / ROLL]);
        if (!entries.length) continue;
        leafGroups[name] = entries;
        g.push([name, round(p, 9)]);
      }
      const i = [...mix.items].filter(([id]) => index.has(id)).map(([id, p]) => [index.get(id), round(p, 9)]);
      if (!g.length && !i.length) continue;
      tables[s.lootTable] = { g, i };
    }
    npcs.push([s.id, s.lootChance, s.lootRolls, s.lootTable, s.faction]);
  }
  npcs.sort((a, b) => a[0].localeCompare(b[0]));
  return { items: outItems, groups: leafGroups, tables, npcs, unknownTables: [...unknownTables].sort() };
}

module.exports = { TYPES, ROLL, parseLootItem, parseLootGroup, parseShipAgent, resolveTable, buildLootData, shortStat };
