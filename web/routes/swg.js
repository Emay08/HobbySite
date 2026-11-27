const fs = require('fs');
const path = require('path');
const express = require('express');
const { getDb } = require('../lib/db');

/**
 * SWG tools — Ship Builder, Loot, Crafting.
 *
 * All the math runs in the browser (public/swg-calc.js, public/swg-loot-calc.js). The server
 * renders the pages, serves the chassis list (data/swg-ships.json, scripts/swg-import-ships.js)
 * and the loot data (data/swg-loot.json, scripts/swg-import-loot.js), and keeps saved builds in
 * `swg_builds` and saved components (looted parts and RE projects) in `swg_components`,
 * one doc per name. The Crafting page reads data/swg-crafting.json (scripts/swg-import-crafting.js)
 * and keeps crafted items in `swg_crafted`, one doc per name.
 */
const router = express.Router();
const COLLECTION = 'swg_builds';
const COMPONENTS = 'swg_components';
const SHIPS_FILE = path.join(__dirname, '..', 'data', 'swg-ships.json');
const LOOT_FILE = path.join(__dirname, '..', 'data', 'swg-loot.json');
const CRAFTING_FILE = path.join(__dirname, '..', 'data', 'swg-crafting.json');
const CRAFTED = 'swg_crafted';
const COMPONENT_TYPES = ['armor', 'booster', 'droid_interface', 'engine', 'reactor', 'shield_generator', 'weapon', 'weapon_capacitor'];
const COMPONENT_KINDS = ['loot', 're', 'crafted'];

let shipsCache = null;
function ships() {
  if (!shipsCache) shipsCache = JSON.parse(fs.readFileSync(SHIPS_FILE, 'utf8')).ships;
  return shipsCache;
}

let lootCache = null;
function lootJson() {
  if (!lootCache) lootCache = fs.readFileSync(LOOT_FILE, 'utf8');
  return lootCache;
}

let craftingCache = null;
function craftingJson() {
  if (!craftingCache) craftingCache = fs.readFileSync(CRAFTING_FILE, 'utf8');
  return craftingCache;
}
let schematicIds = null;
function schematicTargets() {
  if (!schematicIds) schematicIds = new Map(JSON.parse(craftingJson()).schematics.map((s) => [s.id, s.t]));
  return schematicIds;
}

const page = (view, title, tab) => (req, res) => res.render('swg/' + view, { title, section: 'swg', tab });

router.get('/', (req, res) => res.redirect('/swg/ships'));
router.get('/ships', page('ships', 'Ship builder', 'ships'));
router.get('/loot', page('loot', 'Loot', 'loot'));
router.get('/crafting', page('crafting', 'Crafting', 'crafting'));

router.get('/api/ships', (req, res) => res.json({ ships: ships() }));
router.get('/api/loot', (req, res) => {
  res.set('Cache-Control', 'private, max-age=3600');
  res.type('json').send(lootJson());
});

router.get('/api/crafting', (req, res) => {
  res.set('Cache-Control', 'private, max-age=3600');
  res.type('json').send(craftingJson());
});

router.get('/api/builds', async (req, res, next) => {
  try {
    const list = await getDb()
      .collection(COLLECTION)
      .find({}, { projection: { name: 1, ship: 1, updatedAt: 1 } })
      .sort({ updatedAt: -1 })
      .toArray();
    res.json({ builds: list.map((b) => ({ name: b.name, ship: b.ship, updatedAt: b.updatedAt })) });
  } catch (err) {
    next(err);
  }
});

const cleanName = (s) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 80);
const nameKey = (s) => cleanName(s).toLowerCase();
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

router.get('/api/builds/:name', async (req, res, next) => {
  try {
    const doc = await getDb().collection(COLLECTION).findOne({ _id: nameKey(req.params.name) });
    if (!doc) return res.status(404).json({ error: 'No saved build with that name' });
    const { _id, ...build } = doc;
    res.json({ build });
  } catch (err) {
    next(err);
  }
});

router.put('/api/builds/:name', async (req, res, next) => {
  try {
    const name = cleanName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Give the build a name' });
    const b = req.body || {};
    if (!ships().some((s) => s.id === b.ship)) return res.status(400).json({ error: 'Unknown ship' });
    if (!isObj(b.overloads) || !isObj(b.components)) return res.status(400).json({ error: 'overloads and components must be objects' });
    if (Object.keys(b.components).length > 40) return res.status(400).json({ error: 'Too many components' });
    const doc = { name, ship: b.ship, shipName: cleanName(b.shipName), overloads: b.overloads, components: b.components, updatedAt: new Date() };
    await getDb().collection(COLLECTION).replaceOne({ _id: nameKey(name) }, doc, { upsert: true });
    res.json({ ok: true, name, updatedAt: doc.updatedAt });
  } catch (err) {
    next(err);
  }
});

router.delete('/api/builds/:name', async (req, res, next) => {
  try {
    const r = await getDb().collection(COLLECTION).deleteOne({ _id: nameKey(req.params.name) });
    res.json({ ok: true, deleted: r.deletedCount });
  } catch (err) {
    next(err);
  }
});

// ---------- preferences: tile layout per ship type ----------
const PREFS = 'swg_prefs';

router.get('/api/prefs', async (req, res, next) => {
  try {
    const doc = await getDb().collection(PREFS).findOne({ _id: 'layout' });
    res.json({ layouts: (doc && doc.ships) || {} });
  } catch (err) {
    next(err);
  }
});

router.put('/api/prefs/layout/:ship', async (req, res, next) => {
  try {
    const id = req.params.ship;
    if (!ships().some((s) => s.id === id)) return res.status(400).json({ error: 'Unknown ship' });
    const order = Array.isArray(req.body && req.body.order) ? req.body.order.filter((k) => typeof k === 'string' && /^[a-z_0-9]{1,40}$/.test(k)).slice(0, 40) : [];
    const update = order.length ? { $set: { ['ships.' + id]: order } } : { $unset: { ['ships.' + id]: '' } };
    await getDb().collection(PREFS).updateOne({ _id: 'layout' }, update, { upsert: true });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- saved components (looted parts, RE projects; crafted later) ----------

const num = (v) => typeof v === 'number' && Number.isFinite(v);
function cleanNumbers(obj, max = 60) {
  const out = {};
  if (!isObj(obj)) return out;
  for (const [k, v] of Object.entries(obj).slice(0, max)) if (/^[A-Za-z0-9_]{1,60}$/.test(k) && num(v)) out[k] = v;
  return out;
}

router.get('/api/components', async (req, res, next) => {
  try {
    const q = {};
    if (COMPONENT_KINDS.includes(req.query.kind)) q.kind = req.query.kind;
    if (COMPONENT_TYPES.includes(req.query.type)) q.type = req.query.type;
    const list = await getDb()
      .collection(COMPONENTS)
      .find(q, { projection: { name: 1, kind: 1, type: 1, tier: 1, launcher: 1, 'ship.mass': 1, updatedAt: 1 } })
      .sort({ updatedAt: -1 })
      .toArray();
    res.json({
      components: list.map((c) => ({ name: c.name, kind: c.kind, type: c.type, tier: c.tier, launcher: c.launcher, mass: c.ship && c.ship.mass, updatedAt: c.updatedAt })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/api/components/:name', async (req, res, next) => {
  try {
    const doc = await getDb().collection(COMPONENTS).findOne({ _id: nameKey(req.params.name) });
    if (!doc) return res.status(404).json({ error: 'No saved component with that name' });
    const { _id, ...component } = doc;
    res.json({ component });
  } catch (err) {
    next(err);
  }
});

router.put('/api/components/:name', async (req, res, next) => {
  try {
    const name = cleanName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Give the component a name' });
    const b = req.body || {};
    if (!COMPONENT_KINDS.includes(b.kind)) return res.status(400).json({ error: 'Unknown component kind' });
    if (!COMPONENT_TYPES.includes(b.type)) return res.status(400).json({ error: 'Unknown component type' });
    const tier = Number(b.tier);
    if (!(Number.isInteger(tier) && tier >= 1 && tier <= 10)) return res.status(400).json({ error: 'Tier must be 1–10' });
    const doc = {
      name,
      kind: b.kind,
      type: b.type,
      tier,
      values: cleanNumbers(b.values),
      ship: cleanNumbers(b.ship),
      itemIds: Array.isArray(b.itemIds) ? b.itemIds.filter((x) => typeof x === 'string').slice(0, 200) : [],
      updatedAt: new Date(),
    };
    // weapon launchers (crafted only) fit only launcher slots of the same kind
    if (b.type === 'weapon' && ['missile', 'countermeasure'].includes(b.launcher)) doc.launcher = b.launcher;
    if (b.kind === 're') {
      const comps = Array.isArray(b.components) ? b.components.slice(0, 10) : [];
      doc.components = comps.map((c) => ({
        name: cleanName(c && c.name) || 'Component',
        itemIds: Array.isArray(c && c.itemIds) ? c.itemIds.filter((x) => typeof x === 'string').slice(0, 200) : [],
        values: cleanNumbers(c && c.values),
        typical: cleanNumbers(c && c.typical),
      }));
    }
    await getDb().collection(COMPONENTS).replaceOne({ _id: nameKey(name) }, doc, { upsert: true });
    res.json({ ok: true, name, updatedAt: doc.updatedAt });
  } catch (err) {
    next(err);
  }
});

router.delete('/api/components/:name', async (req, res, next) => {
  try {
    const r = await getDb().collection(COMPONENTS).deleteOne({ _id: nameKey(req.params.name) });
    res.json({ ok: true, deleted: r.deletedCount });
  } catch (err) {
    next(err);
  }
});

// ---------- crafted items (Crafting page) ----------

const MAX_INPUTS = 15000; // characters of JSON; the body limit is 20 kB

/** [[name, value, precision, group, hidden], …] — the stats a crafted item carries into other schematics */
function cleanProps(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const p of list.slice(0, 80)) {
    if (!Array.isArray(p) || !/^[A-Za-z0-9_]{1,60}$/.test(String(p[0])) || !num(p[1])) return null;
    const prec = Number.isInteger(p[2]) && p[2] >= 0 && p[2] <= 20 ? p[2] : 0;
    out.push([p[0], p[1], prec, typeof p[3] === 'string' ? p[3].slice(0, 60) : '', !!p[4]]);
  }
  return out;
}

router.get('/api/crafted', async (req, res, next) => {
  try {
    const list = await getDb()
      .collection(CRAFTED)
      .find({}, { projection: { name: 1, schematic: 1, target: 1, updatedAt: 1 } })
      .sort({ updatedAt: -1 })
      .toArray();
    res.json({ items: list.map((c) => ({ name: c.name, schematic: c.schematic, target: c.target, updatedAt: c.updatedAt })) });
  } catch (err) {
    next(err);
  }
});

router.get('/api/crafted/:name', async (req, res, next) => {
  try {
    const doc = await getDb().collection(CRAFTED).findOne({ _id: nameKey(req.params.name) });
    if (!doc) return res.status(404).json({ error: 'No saved item with that name' });
    const { _id, ...item } = doc;
    res.json({ item });
  } catch (err) {
    next(err);
  }
});

router.put('/api/crafted/:name', async (req, res, next) => {
  try {
    const name = cleanName(req.params.name);
    if (!name) return res.status(400).json({ error: 'Give the item a name' });
    const b = req.body || {};
    const target = schematicTargets().get(b.schematic);
    if (!target) return res.status(400).json({ error: 'Unknown schematic' });
    const props = cleanProps(b.props);
    if (!props) return res.status(400).json({ error: 'props must be a list of [stat, value, precision, group, hidden]' });
    if (b.inputs != null && (!isObj(b.inputs) || JSON.stringify(b.inputs).length > MAX_INPUTS)) return res.status(400).json({ error: 'inputs must be a small object' });
    const doc = { name, schematic: b.schematic, target, props, inputs: b.inputs || {}, updatedAt: new Date() };
    await getDb().collection(CRAFTED).replaceOne({ _id: nameKey(name) }, doc, { upsert: true });
    res.json({ ok: true, name, updatedAt: doc.updatedAt });
  } catch (err) {
    next(err);
  }
});

router.delete('/api/crafted/:name', async (req, res, next) => {
  try {
    const r = await getDb().collection(CRAFTED).deleteOne({ _id: nameKey(req.params.name) });
    res.json({ ok: true, deleted: r.deletedCount });
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
