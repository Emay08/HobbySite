const express = require('express');
const { ObjectId } = require('mongodb');
const { getDb } = require('../lib/db');
const cards = require('../lib/cards');
const vendors = require('../lib/vendors');
const { reconcile, localDate } = require('../lib/reconcile');
const search = require('../lib/search');

const router = express.Router();

const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const num = (v, { min = -Infinity, max = Infinity } = {}) => {
  if (String(v ?? '').trim() === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cardPath = (name) => `/mtgo/card/${encodeURIComponent(name)}`;

/** Every MTGO version of a card name, with your quantities, daily prices and list memberships. */
async function loadVersions(name) {
  const db = getDb();
  const lower = name.toLowerCase();
  const [defs, owned, watch, targets] = await Promise.all([
    db.collection('cards').find({ nameLower: lower }).toArray(),
    db.collection('collection').find({ name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' } }).toArray(),
    db.collection('watchlist').find({ name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' } }).toArray(),
    db.collection('targets').find({ name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' } }).toArray(),
  ]);

  const byId = new Map();
  for (const d of defs) byId.set(d._id, { mtgoId: d._id, name: d.name, set: d.set, foil: !!d.foil, rarity: d.rarity || '' });
  for (const o of owned) {
    if (o.mtgoId && !byId.has(o.mtgoId)) byId.set(o.mtgoId, { mtgoId: o.mtgoId, name: o.name, set: o.set, foil: !!o.foil, rarity: o.rarity || '' });
  }
  const ids = [...byId.keys()];
  const [prices, history] = await Promise.all([cards.getPrices(ids), cards.getHistory(ids, 90)]);

  const ownedById = new Map(owned.filter((o) => o.mtgoId).map((o) => [o.mtgoId, o.qty]));
  const versions = [...byId.values()].map((v) => {
    const price = prices.get(v.mtgoId) ?? null;
    return {
      ...v,
      price,
      d1: cards.pctChange(price, prices.prev.get(v.mtgoId)),
      qty: ownedById.get(v.mtgoId) || 0,
      lists: watch.filter((w) => w.mtgoId === v.mtgoId).map((w) => w.list),
      targets: targets.filter((t) => t.mtgoId === v.mtgoId),
      history: history.get(v.mtgoId) || [],
    };
  });
  versions.sort((a, b) => (b.qty > 0) - (a.qty > 0) || (b.price ?? -1) - (a.price ?? -1) || a.set.localeCompare(b.set) || a.foil - b.foil);
  const displayName = (defs[0] && defs[0].name) || (owned[0] && owned[0].name) || (watch[0] && watch[0].name) || name;
  return { displayName, versions, ownedWithoutId: owned.filter((o) => !o.mtgoId) };
}

// ---------------------------------------------------------------- page

router.get('/card/:name', async (req, res, next) => {
  try {
    const name = text(req.params.name, 150);
    const { displayName, versions, ownedWithoutId } = await loadVersions(name);
    if (!versions.length && !ownedWithoutId.length) {
      return res.status(404).render('error', { title: 'Card not found', message: `No MTGO card called “${name}” in the card list or your collection.` });
    }
    const db = getDb();
    const lower = displayName.toLowerCase();
    const [trades, changes, pending] = await Promise.all([
      db.collection('trades').find({ nameLower: lower }).sort({ date: -1, at: -1, createdAt: -1 }).toArray(),
      db.collection('collection_changes').find({ nameLower: lower }).sort({ at: -1 }).limit(100).toArray(),
      db.collection('pending_changes').find({ nameLower: lower, status: 'open' }).sort({ windowEnd: -1 }).toArray(),
    ]);
    for (const p of pending) {
      p.minDate = p.windowStart ? localDate(p.windowStart) : '';
      p.maxDate = localDate(p.windowEnd);
    }
    const owned = versions.filter((v) => v.qty > 0);
    const flash = req.session.flash || null;
    delete req.session.flash;
    res.render('mtgo/card', {
      title: displayName,
      name: displayName,
      versions,
      owned,
      ownedWithoutId,
      ownedQty: owned.reduce((n, v) => n + v.qty, 0) + ownedWithoutId.reduce((n, o) => n + o.qty, 0),
      ownedValue: owned.reduce((n, v) => n + v.qty * (v.price || 0), 0),
      trades,
      changes,
      pending,
      flash,
      links: {
        goatbots: vendors.goatbotsUrl(displayName),
        cardhoarder: `https://www.cardhoarder.com/cards?cardname=${encodeURIComponent(`"${displayName}"`)}`,
        dojo: 'https://www.dojotradebots.com/mtgoPrices',
        scryfallImage: `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(displayName)}&format=image&version=normal`,
      },
      today: new Date().toISOString().slice(0, 10),
      livePricesEnabled: process.env.VENDOR_LIVE_DISABLED !== '1',
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- search

router.get('/api/suggest', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'private, max-age=30');
    res.json(await search.suggest(text(req.query.q, 80)));
  } catch (err) {
    next(err);
  }
});

/** Nav-bar search without JavaScript (or Enter before suggestions arrive): best match's card page. */
router.get('/go', async (req, res, next) => {
  try {
    const q = text(req.query.q, 80);
    if (!q) return res.redirect(303, '/mtgo/collection');
    const [best] = await search.suggest(q, 1);
    res.redirect(303, cardPath(best ? best.name : q));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- live prices (JSON)

router.get('/api/live', async (req, res, next) => {
  try {
    const name = text(req.query.name, 150);
    if (!name) return res.status(400).json({ error: 'name required' });
    res.json(await vendors.livePrices(name));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- watch list toggles

router.post('/card/:name/watch', async (req, res, next) => {
  const back = cardPath(req.params.name);
  try {
    const list = req.body.list === 'long' ? 'long' : 'short';
    const coll = getDb().collection('watchlist');
    const existing = await coll.findOne({ list, mtgoId: String(req.body.mtgoId || '') });
    if (existing) {
      await coll.deleteOne({ _id: existing._id });
      search.invalidate();
      req.session.flash = { type: 'ok', message: `Removed ${existing.name} (${existing.set}) from the ${list}-term watch list.` };
      return res.redirect(303, back);
    }
    const card = await cards.getCard(req.body.mtgoId);
    if (!card) {
      req.session.flash = { type: 'error', message: 'Unknown card version.' };
      return res.redirect(303, back);
    }
    await coll.insertOne({
      list,
      mtgoId: card.mtgoId,
      name: card.name,
      set: card.set,
      rarity: card.rarity,
      foil: card.foil,
      note: '',
      alertPct: null,
      addedPrice: card.price,
      addedAt: new Date(),
    });
    await cards.seedHistory(card.mtgoId, card.price);
    search.invalidate();
    req.session.flash = { type: 'ok', message: `Added ${card.name} (${card.set}${card.foil ? ' foil' : ''}) to the ${list}-term watch list.` };
    res.redirect(303, back);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- trade log

router.post('/card/:name/trades', async (req, res, next) => {
  const back = cardPath(req.params.name);
  try {
    const name = text(req.params.name, 150);
    const direction = ['buy', 'sell'].includes(req.body.direction) ? req.body.direction : null;
    const qty = num(req.body.qty, { min: 1, max: 10000 });
    const price = num(req.body.price, { min: 0, max: 100000 });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : new Date().toISOString().slice(0, 10);
    if (!direction || !qty) {
      req.session.flash = { type: 'error', message: 'Choose bought or sold, and a quantity.' };
      return res.redirect(303, back);
    }
    const version = req.body.mtgoId ? await cards.getCard(req.body.mtgoId) : null;
    await getDb().collection('trades').insertOne({
      name: version ? version.name : name,
      nameLower: (version ? version.name : name).toLowerCase(),
      mtgoId: version ? version.mtgoId : null,
      set: version ? version.set : '',
      foil: version ? version.foil : false,
      direction,
      qty,
      price, // tix per card
      counterparty: text(req.body.counterparty, 80),
      note: text(req.body.note),
      date,
      createdAt: new Date(),
    });
    await getDb().collection('trades').createIndex({ nameLower: 1, date: -1 });
    if (version) await reconcile(getDb(), { mtgoId: version.mtgoId });
    req.session.flash = { type: 'ok', message: `Logged: ${direction === 'buy' ? 'bought' : 'sold'} ${qty}.` };
    res.redirect(303, `${back}#trades`);
  } catch (err) {
    next(err);
  }
});

router.post('/card/:name/trades/:id/delete', async (req, res, next) => {
  try {
    if (ObjectId.isValid(req.params.id)) await getDb().collection('trades').deleteOne({ _id: new ObjectId(req.params.id), source: { $ne: 'goatbots' } });
    res.redirect(303, `${cardPath(req.params.name)}#trades`);
  } catch (err) {
    next(err);
  }
});

module.exports = { router, loadVersions, cardPath };
