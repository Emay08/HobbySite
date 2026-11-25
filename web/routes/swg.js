const fs = require('fs');
const path = require('path');
const express = require('express');
const { getDb } = require('../lib/db');

/**
 * SWG tools — Ship Builder, Loot, Crafting (later).
 *
 * All the math runs in the browser (public/swg-calc.js, public/swg-loot-calc.js). The server
 * renders the pages, serves the chassis list (data/swg-ships.json, scripts/swg-import-ships.js)
 * and the loot data (data/swg-loot.json, scripts/swg-import-loot.js), and keeps saved builds in
 * `swg_builds` and saved components (looted parts and RE projects) in `swg_components`,
 * one doc per name.
 */
const router = express.Router();
const COLLECTION = 'swg_builds';
const COMPONENTS = 'swg_components';
const SHIPS_FILE = path.join(__dirname, '..', 'data', 'swg-ships.json');
const LOOT_FILE = path.join(__dirname, '..', 'data', 'swg-loot.json');
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

const page = (view, title, tab) => (req, res) => res.render('swg/' + view, { title, section: 'swg', tab });

router.get('/', (req, res) => res.redirect('/swg/ships'));
router.get('/ships', page('ships', 'Ship builder', 'ships'));
router.get('/loot', page('loot', 'Loot', 'loot'));
router.get('/crafting', page('soon', 'Crafting', 'crafting'));

router.get('/api/ships', (req, res) => res.json({ ships: ships() }));
router.get('/api/loot', (req, res) => {
  res.set('Cache-Control', 'private, max-age=3600');
  res.type('json').send(lootJson());
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
    const doc = { name, ship: b.ship, overloads: b.overloads, components: b.components, updatedAt: new Date() };
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

module.exports = { router };
