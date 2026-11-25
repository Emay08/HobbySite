const fs = require('fs');
const path = require('path');
const express = require('express');
const { getDb } = require('../lib/db');

/**
 * SWG tools — Ship Builder (now), Loot and Crafting (later).
 *
 * The ship math runs in the browser (public/swg-calc.js). The server renders the pages,
 * serves the chassis list (data/swg-ships.json, rebuilt with scripts/swg-import-ships.js)
 * and keeps saved builds in `swg_builds` (one doc per build name).
 */
const router = express.Router();
const COLLECTION = 'swg_builds';
const SHIPS_FILE = path.join(__dirname, '..', 'data', 'swg-ships.json');

let shipsCache = null;
function ships() {
  if (!shipsCache) shipsCache = JSON.parse(fs.readFileSync(SHIPS_FILE, 'utf8')).ships;
  return shipsCache;
}

const page = (view, title, tab) => (req, res) => res.render('swg/' + view, { title, section: 'swg', tab });

router.get('/', (req, res) => res.redirect('/swg/ships'));
router.get('/ships', page('ships', 'Ship builder', 'ships'));
router.get('/loot', page('soon', 'Loot', 'loot'));
router.get('/crafting', page('soon', 'Crafting', 'crafting'));

router.get('/api/ships', (req, res) => res.json({ ships: ships() }));

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

module.exports = { router };
