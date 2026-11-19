const telegram = require('./telegram');

const e = telegram.escapeHtml;
const t = (n) => (n == null ? '—' : Number(n).toFixed(2));
const label = (c) => `${e(c.name)}${c.foil ? ' ✦' : ''} (${e(c.set || '?')})`;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Telegram for these alerts is OFF unless turned on with an app setting
 * (NOTIFY_PRICE_TARGETS / NOTIFY_SWAPS / NOTIFY_SHORT_WATCH = true).
 * The checks still run every day so the website shows hits, ready swaps, etc.
 */
const enabled = (name) => String(process.env[name] || '').toLowerCase() === 'true';

/** Every MTGO ID referenced by a watch list, a price target or a version swap. */
async function trackedIds(db) {
  const [w, tg, s] = await Promise.all([
    db.collection('watchlist').distinct('mtgoId'),
    db.collection('targets').distinct('mtgoId'),
    db.collection('swaps').find({}, { projection: { ownedId: 1, wantedId: 1 } }).toArray(),
  ]);
  const ids = new Set([...w, ...tg]);
  for (const x of s) ids.add(x.ownedId).add(x.wantedId);
  ids.delete(null);
  ids.delete(undefined);
  return [...ids];
}

/**
 * Daily price points for tracked cards only (keeps the database small while
 * still giving the watch lists real 1/7/30/90-day changes and sparklines).
 */
async function recordTrackedHistory(db, priceMap) {
  const ids = await trackedIds(db);
  const date = today();
  const ops = ids
    .filter((id) => priceMap.has(id))
    .map((id) => ({
      updateOne: {
        filter: { _id: `${id}|${date}` },
        update: { $set: { mtgoId: id, date, price: priceMap.get(id) } },
        upsert: true,
      },
    }));
  if (ops.length) await db.collection('price_history').bulkWrite(ops, { ordered: false });
  await db.collection('price_history').createIndex({ mtgoId: 1, date: 1 });
  return ops.length;
}

/** Price targets: notify once when a target is reached; re-arm if the price moves back. */
async function checkTargets(db, priceMap) {
  const coll = db.collection('targets');
  const targets = await coll.find().toArray();
  const hits = [];
  for (const tg of targets) {
    const price = priceMap.get(tg.mtgoId);
    if (price == null) continue;
    const hit = tg.direction === 'above' ? price >= tg.target : price <= tg.target;
    const set = { lastPrice: price, checkedAt: new Date() };
    if (hit && !tg.hit) {
      Object.assign(set, { hit: true, hitAt: new Date(), hitPrice: price });
      hits.push({ ...tg, price });
    } else if (!hit && tg.hit) {
      Object.assign(set, { hit: false, hitAt: null, hitPrice: null });
    }
    await coll.updateOne({ _id: tg._id }, { $set: set });
  }
  if (hits.length && enabled('NOTIFY_PRICE_TARGETS')) {
    const lines = hits.map(
      (h) => `${h.direction === 'above' ? '📈 Sell' : '🛒 Buy'} ${label(h)} — now <b>${t(h.price)}</b> (target ${h.direction === 'above' ? '≥' : '≤'} ${t(h.target)})`
    );
    await telegram.sendMessage(`🎯 <b>Price target${hits.length > 1 ? 's' : ''} reached</b>\n\n${lines.join('\n')}`, { disablePreview: true });
  }
  return hits.length;
}

/**
 * Version swaps: notify when the wanted printing becomes cheaper than the owned
 * one by at least `margin` tix (default: any amount). Notifies on the transition
 * only, so you get one message per opportunity rather than one per day.
 */
async function checkSwaps(db, priceMap) {
  const coll = db.collection('swaps');
  const swaps = await coll.find().toArray();
  const opened = [];
  for (const s of swaps) {
    const owned = priceMap.get(s.ownedId);
    const wanted = priceMap.get(s.wantedId);
    if (owned == null || wanted == null) continue;
    const saving = owned - wanted;
    const good = saving > 0 && saving >= (s.margin || 0);
    const set = { lastOwnedPrice: owned, lastWantedPrice: wanted, checkedAt: new Date(), good };
    if (good && !s.good) {
      set.goodSince = new Date();
      opened.push({ ...s, owned, wanted, saving });
    } else if (!good) {
      set.goodSince = null;
    }
    await coll.updateOne({ _id: s._id }, { $set: set });
  }
  if (opened.length && enabled('NOTIFY_SWAPS')) {
    const lines = opened.map(
      (s) =>
        `🔁 ${label(s.ownedCard)} <b>${t(s.owned)}</b>\n   → ${label(s.wantedCard)} <b>${t(s.wanted)}</b>  (save ${t(s.saving)} tix${s.qty > 1 ? ` each, ×${s.qty}` : ''})`
    );
    await telegram.sendMessage(`<b>Version swap${opened.length > 1 ? 's' : ''} now in your favour</b>\n\n${lines.join('\n\n')}`, { disablePreview: true });
  }
  return opened.length;
}

/** Short-term watch list: daily digest of items that moved more than their alert threshold. */
async function checkShortWatch(db, priceMap) {
  if (!enabled('NOTIFY_SHORT_WATCH')) return 0;
  const defaultPct = Number(process.env.WATCH_ALERT_PCT || 15);
  const items = await db.collection('watchlist').find({ list: 'short' }).toArray();
  if (!items.length) return 0;
  const prev = new Map(
    (await db.collection('prices').find({ _id: { $in: items.map((i) => i.mtgoId) } }, { projection: { prevPrice: 1 } }).toArray()).map(
      (p) => [p._id, p.prevPrice]
    )
  );
  const movers = [];
  for (const i of items) {
    const now = priceMap.get(i.mtgoId);
    const before = prev.get(i.mtgoId);
    if (now == null || !before) continue;
    const pct = ((now - before) / before) * 100;
    const threshold = i.alertPct ?? defaultPct;
    if (threshold > 0 && Math.abs(pct) >= threshold) movers.push({ ...i, now, before, pct });
  }
  if (movers.length) {
    movers.sort((a, b) => b.pct - a.pct);
    const lines = movers.map((m) => `${m.pct >= 0 ? '📈' : '📉'} ${label(m)} ${t(m.before)} → <b>${t(m.now)}</b> (${m.pct >= 0 ? '+' : ''}${m.pct.toFixed(0)}%)`);
    await telegram.sendMessage(`👀 <b>Short-term watch list</b>\n\n${lines.join('\n')}`, { disablePreview: true });
  }
  return movers.length;
}

module.exports = { trackedIds, recordTrackedHistory, checkTargets, checkSwaps, checkShortWatch };
