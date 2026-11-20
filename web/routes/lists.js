const express = require('express');
const { ObjectId } = require('mongodb');
const { getDb } = require('../lib/db');
const cards = require('../lib/cards');
const search = require('../lib/search');

const router = express.Router();

// ---------------------------------------------------------------- helpers

const oid = (s) => (ObjectId.isValid(s) ? new ObjectId(String(s)) : null);
const num = (v, { min = -Infinity, max = Infinity } = {}) => {
  if (String(v ?? '').trim() === '') return null;
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};
const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const cardFields = (c) => ({ mtgoId: c.mtgoId, name: c.name, set: c.set, rarity: c.rarity, foil: c.foil });

function flash(req, type, message) {
  req.session.flash = { type, message };
}
function takeFlash(req) {
  const f = req.session.flash;
  delete req.session.flash;
  return f || null;
}
function back(res, path) {
  // forms on other pages (e.g. the Treasure Chest page) can ask to come back to them
  const b = String((res.req && res.req.body && res.req.body.back) || '');
  return res.redirect(303, b.startsWith('/mtgo/') && !b.includes('//') ? b : path);
}

// ---------------------------------------------------------------- card search API

router.get('/api/cards', async (req, res, next) => {
  try {
    const q = text(req.query.q, 60);
    const name = text(req.query.name, 150);
    if (!name && q.length < 2) return res.json([]);
    res.json(await cards.search({ q, name, ownedOnly: req.query.owned === '1' }));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- watch lists

const WATCH = {
  short: { title: 'Short-term watch', historyDays: 30, other: 'long' },
  long: { title: 'Long-term watch', historyDays: 180, other: 'short' },
};

router.get('/watch/:list(short|long)', async (req, res, next) => {
  try {
    const list = req.params.list;
    const cfg = WATCH[list];
    const items = await getDb().collection('watchlist').find({ list }).sort({ addedAt: -1 }).toArray();
    const ids = items.map((i) => i.mtgoId);
    const [prices, history, owned] = await Promise.all([cards.getPrices(ids), cards.getHistory(ids, cfg.historyDays), cards.getOwned(ids)]);

    const rows = items.map((i) => {
      const h = history.get(i.mtgoId) || [];
      const price = prices.get(i.mtgoId) ?? null;
      return {
        ...i,
        price,
        owned: owned.get(i.mtgoId) || 0,
        history: h,
        d1: cards.pctChange(price, prices.prev.get(i.mtgoId)),
        d7: cards.pctChange(price, cards.priceDaysAgo(h, 7)),
        d30: cards.pctChange(price, cards.priceDaysAgo(h, 30)),
        d90: cards.pctChange(price, cards.priceDaysAgo(h, 90)),
        sinceAdded: cards.pctChange(price, i.addedPrice),
      };
    });

    res.render('mtgo/watch', {
      title: cfg.title,
      list,
      cfg,
      rows,
      flash: takeFlash(req),
      defaultAlertPct: Number(process.env.WATCH_ALERT_PCT || 15),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/watch/:list(short|long)', async (req, res, next) => {
  const list = req.params.list;
  try {
    const card = await cards.getCard(req.body.mtgoId);
    if (!card) {
      flash(req, 'error', 'Pick a card from the search results.');
      return back(res, `/mtgo/watch/${list}`);
    }
    const coll = getDb().collection('watchlist');
    if (await coll.findOne({ list, mtgoId: card.mtgoId })) {
      flash(req, 'error', `${card.name} (${card.set}) is already on this list.`);
      return back(res, `/mtgo/watch/${list}`);
    }
    await coll.insertOne({
      list,
      ...cardFields(card),
      note: text(req.body.note),
      alertPct: list === 'short' ? num(req.body.alertPct, { min: 0, max: 1000 }) : null,
      addedPrice: card.price,
      addedAt: new Date(),
    });
    await cards.seedHistory(card.mtgoId, card.price);
    search.invalidate();
    flash(req, 'ok', `Added ${card.name} (${card.set}).`);
    back(res, `/mtgo/watch/${list}`);
  } catch (err) {
    next(err);
  }
});

router.post('/watch/item/:id/move', async (req, res, next) => {
  try {
    const coll = getDb().collection('watchlist');
    const item = await coll.findOne({ _id: oid(req.params.id) });
    if (!item) return back(res, '/mtgo/watch/short');
    const to = WATCH[item.list].other;
    await coll.updateOne({ _id: item._id }, { $set: { list: to } });
    search.invalidate();
    flash(req, 'ok', `Moved ${item.name} to the ${to}-term list.`);
    back(res, `/mtgo/watch/${item.list}`);
  } catch (err) {
    next(err);
  }
});

router.post('/watch/item/:id/note', async (req, res, next) => {
  try {
    const coll = getDb().collection('watchlist');
    const item = await coll.findOne({ _id: oid(req.params.id) });
    if (!item) return back(res, '/mtgo/watch/short');
    const set = { note: text(req.body.note) };
    if (item.list === 'short' && 'alertPct' in req.body) set.alertPct = num(req.body.alertPct, { min: 0, max: 1000 });
    await coll.updateOne({ _id: item._id }, { $set: set });
    back(res, `/mtgo/watch/${item.list}`);
  } catch (err) {
    next(err);
  }
});

router.post('/watch/item/:id/delete', async (req, res, next) => {
  try {
    const coll = getDb().collection('watchlist');
    const item = await coll.findOneAndDelete({ _id: oid(req.params.id) });
    search.invalidate();
    if (item) flash(req, 'ok', `Removed ${item.name}.`);
    back(res, `/mtgo/watch/${item ? item.list : 'short'}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- price targets

/**
 * status: 'hit'   – target reached
 *         'near'  – within nearPct % of the target
 *         'far'   – everything else (or no price yet)
 */
function targetStatus(t, price) {
  if (price == null) return { status: 'far', distancePct: null };
  const hit = t.direction === 'above' ? price >= t.target : price <= t.target;
  const distancePct = t.direction === 'above' ? ((t.target - price) / t.target) * 100 : ((price - t.target) / t.target) * 100;
  if (hit) return { status: 'hit', distancePct };
  return { status: distancePct <= (t.nearPct ?? 10) ? 'near' : 'far', distancePct };
}

router.get('/targets', async (req, res, next) => {
  try {
    const items = await getDb().collection('targets').find().sort({ addedAt: -1 }).toArray();
    const ids = items.map((i) => i.mtgoId);
    const [prices, history, owned] = await Promise.all([cards.getPrices(ids), cards.getHistory(ids, 30), cards.getOwned(ids)]);
    const rows = items.map((t) => {
      const price = prices.get(t.mtgoId) ?? null;
      return { ...t, price, owned: owned.get(t.mtgoId) || 0, history: history.get(t.mtgoId) || [], ...targetStatus(t, price) };
    });
    const byDistance = (a, b) => (a.distancePct ?? Infinity) - (b.distancePct ?? Infinity);
    res.render('mtgo/targets', {
      title: 'Price targets',
      hit: rows.filter((r) => r.status === 'hit').sort(byDistance),
      near: rows.filter((r) => r.status === 'near').sort(byDistance),
      far: rows.filter((r) => r.status === 'far').sort(byDistance),
      flash: takeFlash(req),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/targets', async (req, res, next) => {
  try {
    const card = await cards.getCard(req.body.mtgoId);
    const target = num(req.body.target, { min: 0.001, max: 100000 });
    const direction = req.body.direction === 'above' ? 'above' : 'below';
    if (!card || target == null) {
      flash(req, 'error', !card ? 'Pick a card from the search results.' : 'Enter a target price in tix.');
      return back(res, '/mtgo/targets');
    }
    await getDb().collection('targets').insertOne({
      ...cardFields(card),
      target,
      direction,
      nearPct: num(req.body.nearPct, { min: 0, max: 1000 }) ?? 10,
      note: text(req.body.note),
      addedPrice: card.price,
      addedAt: new Date(),
      hit: false,
    });
    await cards.seedHistory(card.mtgoId, card.price);
    flash(req, 'ok', `Target set: ${direction === 'below' ? 'buy' : 'sell'} ${card.name} (${card.set}) at ${direction === 'below' ? '≤' : '≥'} ${target} tix.`);
    back(res, '/mtgo/targets');
  } catch (err) {
    next(err);
  }
});

router.post('/targets/:id', async (req, res, next) => {
  try {
    const set = {};
    const target = num(req.body.target, { min: 0.001, max: 100000 });
    if (target != null) set.target = target;
    const nearPct = num(req.body.nearPct, { min: 0, max: 1000 });
    if (nearPct != null) set.nearPct = nearPct;
    if ('note' in req.body) set.note = text(req.body.note);
    // Changing the target re-arms the Telegram alert
    if (set.target != null) Object.assign(set, { hit: false, hitAt: null, hitPrice: null });
    await getDb().collection('targets').updateOne({ _id: oid(req.params.id) }, { $set: set });
    back(res, '/mtgo/targets');
  } catch (err) {
    next(err);
  }
});

router.post('/targets/:id/delete', async (req, res, next) => {
  try {
    const t = await getDb().collection('targets').findOneAndDelete({ _id: oid(req.params.id) });
    if (t) flash(req, 'ok', `Removed target for ${t.name}.`);
    back(res, '/mtgo/targets');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- version swaps

router.get('/swaps', async (req, res, next) => {
  try {
    const items = await getDb().collection('swaps').find().sort({ addedAt: -1 }).toArray();
    const ids = items.flatMap((s) => [s.ownedId, s.wantedId]);
    const [prices, owned] = await Promise.all([cards.getPrices(ids), cards.getOwned(ids)]);
    const rows = items.map((s) => {
      const ownedPrice = prices.get(s.ownedId) ?? null;
      const wantedPrice = prices.get(s.wantedId) ?? null;
      const saving = ownedPrice != null && wantedPrice != null ? ownedPrice - wantedPrice : null;
      const good = saving != null && saving > 0 && saving >= (s.margin || 0);
      return { ...s, ownedPrice, wantedPrice, saving, good, ownedQty: owned.get(s.ownedId) || 0 };
    });
    rows.sort((a, b) => b.good - a.good || (b.saving ?? -Infinity) - (a.saving ?? -Infinity));
    res.render('mtgo/swaps', { title: 'Version swaps', rows, flash: takeFlash(req) });
  } catch (err) {
    next(err);
  }
});

router.post('/swaps', async (req, res, next) => {
  try {
    const [ownedCard, wantedCard] = await Promise.all([cards.getCard(req.body.ownedId), cards.getCard(req.body.wantedId)]);
    if (!ownedCard || !wantedCard) {
      flash(req, 'error', 'Pick both the version you own and the version you want.');
      return back(res, '/mtgo/swaps');
    }
    if (ownedCard.mtgoId === wantedCard.mtgoId) {
      flash(req, 'error', 'The two versions are the same printing.');
      return back(res, '/mtgo/swaps');
    }
    if (await getDb().collection('swaps').findOne({ ownedId: ownedCard.mtgoId, wantedId: wantedCard.mtgoId })) {
      flash(req, 'error', 'That swap is already on the list.');
      return back(res, '/mtgo/swaps');
    }
    const strip = (c) => ({ name: c.name, set: c.set, rarity: c.rarity, foil: c.foil });
    await getDb().collection('swaps').insertOne({
      ownedId: ownedCard.mtgoId,
      wantedId: wantedCard.mtgoId,
      ownedCard: strip(ownedCard),
      wantedCard: strip(wantedCard),
      qty: num(req.body.qty, { min: 1, max: 1000 }) ?? 1,
      margin: num(req.body.margin, { min: 0, max: 100000 }) ?? 0,
      note: text(req.body.note),
      addedAt: new Date(),
      good: false,
    });
    await Promise.all([cards.seedHistory(ownedCard.mtgoId, ownedCard.price), cards.seedHistory(wantedCard.mtgoId, wantedCard.price)]);
    flash(req, 'ok', `Watching ${ownedCard.name}: ${ownedCard.set}${ownedCard.foil ? ' foil' : ''} → ${wantedCard.set}${wantedCard.foil ? ' foil' : ''}.`);
    back(res, '/mtgo/swaps');
  } catch (err) {
    next(err);
  }
});

router.post('/swaps/:id', async (req, res, next) => {
  try {
    const set = {};
    const margin = num(req.body.margin, { min: 0, max: 100000 });
    if (margin != null) set.margin = margin;
    const qty = num(req.body.qty, { min: 1, max: 1000 });
    if (qty != null) set.qty = qty;
    if ('note' in req.body) set.note = text(req.body.note);
    if (margin != null) set.good = false; // re-arm the alert with the new margin
    await getDb().collection('swaps').updateOne({ _id: oid(req.params.id) }, { $set: set });
    back(res, '/mtgo/swaps');
  } catch (err) {
    next(err);
  }
});

router.post('/swaps/:id/delete', async (req, res, next) => {
  try {
    await getDb().collection('swaps').deleteOne({ _id: oid(req.params.id) });
    flash(req, 'ok', 'Swap removed.');
    back(res, '/mtgo/swaps');
  } catch (err) {
    next(err);
  }
});

module.exports = { router, targetStatus };
