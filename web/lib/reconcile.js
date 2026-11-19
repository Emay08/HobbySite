/**
 * Unconfirmed buys / sells.
 *
 * When a new collection export is uploaded, every version whose quantity changed
 * since the previous upload becomes a "pending change": bought (+n) or sold (−n) at
 * an unknown price, some time between the previous upload and this one.
 *
 * A pending change is explained by trades with a known date inside that window
 * (GoatBots imports, or entries you add by hand): the net quantity of those trades
 * for the same MTGO ID is subtracted. Fully explained → resolved automatically.
 * Whatever is left stays on the Trades page to fill in or dismiss.
 */
const { ObjectId } = require('mongodb');

const TZ = process.env.DISPLAY_TIMEZONE || 'America/Vancouver';
const EVENT_TICKET_ID = '1';
const localDate = (d) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/**
 * Records pending changes for one upload. `changes` = [{ mtgoId, name, set, foil, from, to }].
 * `windowStart` = previous upload time (null if unknown), `windowEnd` = this upload.
 */
async function recordPendingChanges(db, changes, { windowStart, windowEnd, uploadId }) {
  const docs = changes
    .filter((c) => c.mtgoId && c.mtgoId !== EVENT_TICKET_ID && c.to !== c.from)
    .map((c) => {
      const change = c.to - c.from;
      return {
        uploadId,
        mtgoId: c.mtgoId,
        name: c.name,
        nameLower: c.name.toLowerCase(),
        set: c.set || '',
        foil: !!c.foil,
        direction: change > 0 ? 'buy' : 'sell',
        qty: Math.abs(change),
        remaining: Math.abs(change),
        windowStart: windowStart || null,
        windowEnd,
        status: 'open',
        createdAt: new Date(),
      };
    });
  if (!docs.length) return { created: 0, resolved: 0 };
  const coll = db.collection('pending_changes');
  await coll.createIndex({ status: 1, windowEnd: -1 });
  await coll.createIndex({ nameLower: 1 });
  const { insertedIds } = await coll.insertMany(docs);
  const res = await reconcile(db, { _id: { $in: Object.values(insertedIds) } });
  return { created: docs.length, ...res };
}

/** Trades with a known date inside a pending change's window, for its MTGO ID. */
function tradesInWindowFilter(p) {
  const timeRange = { $lte: p.windowEnd };
  if (p.windowStart) timeRange.$gt = p.windowStart;
  const dateRange = { $lte: localDate(p.windowEnd) };
  if (p.windowStart) dateRange.$gte = localDate(p.windowStart);
  return {
    mtgoId: p.mtgoId,
    $or: [
      { at: timeRange }, // imported trades have an exact time
      { at: { $exists: false }, date: dateRange }, // hand-logged trades only have a day
      { fromPending: p._id }, // filled in from this entry, whatever date was given
    ],
  };
}

/** Whether a trade falls inside a pending change's window (same rules as tradesInWindowFilter). */
function inWindow(t, p) {
  if (t.fromPending && String(t.fromPending) === String(p._id)) return true;
  if (t.at) {
    const at = new Date(t.at);
    return at <= p.windowEnd && (!p.windowStart || at > p.windowStart);
  }
  if (!t.date) return false;
  return t.date <= localDate(p.windowEnd) && (!p.windowStart || t.date >= localDate(p.windowStart));
}

/**
 * Re-checks open pending changes (optionally filtered) against the trade log.
 * Returns how many were fully resolved.
 *
 * Three database round trips however many entries there are: the open entries, every
 * trade for their MTGO IDs, and one bulk write. (One query per entry took minutes from
 * Azure once there were thousands of entries, and the request timed out.)
 */
async function reconcile(db, filter = {}) {
  const coll = db.collection('pending_changes');
  const trades = db.collection('trades');
  await trades.createIndex({ mtgoId: 1, at: 1 });
  const open = await coll.find({ status: 'open', ...filter }).toArray();
  if (!open.length) return { checked: 0, resolved: 0 };

  const ids = [...new Set(open.map((p) => p.mtgoId))];
  const byId = new Map();
  for (let i = 0; i < ids.length; i += 5000) {
    const rows = await trades
      .find({ mtgoId: { $in: ids.slice(i, i + 5000) } }, { projection: { mtgoId: 1, direction: 1, qty: 1, at: 1, date: 1, fromPending: 1 } })
      .toArray();
    for (const t of rows) {
      if (!byId.has(t.mtgoId)) byId.set(t.mtgoId, []);
      byId.get(t.mtgoId).push(t);
    }
  }

  let resolved = 0;
  const now = new Date();
  const ops = [];
  for (const p of open) {
    const matches = (byId.get(p.mtgoId) || []).filter((t) => inWindow(t, p));
    const net = matches.reduce((n, t) => n + (t.direction === 'buy' ? t.qty : -t.qty), 0);
    const wanted = p.direction === 'buy' ? p.qty : -p.qty;
    // Trades explain the change if they point the same way; whatever they don't cover remains
    const explained = Math.sign(net) === Math.sign(wanted) ? Math.min(Math.abs(net), Math.abs(wanted)) : 0;
    const remaining = p.qty - explained;
    const set = { remaining, matchedTrades: matches.map((m) => m._id), checkedAt: now };
    if (remaining === 0) {
      Object.assign(set, { status: 'resolved', resolvedBy: 'trades', resolvedAt: now });
      resolved++;
    }
    ops.push({ updateOne: { filter: { _id: p._id }, update: { $set: set } } });
  }
  for (let i = 0; i < ops.length; i += 1000) await coll.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
  return { checked: open.length, resolved };
}

/** Turns a pending change into a hand-entered trade (price/date you supply). */
async function resolveManually(db, id, { qty, price, date, counterparty, note }) {
  const coll = db.collection('pending_changes');
  const p = await coll.findOne({ _id: new ObjectId(id), status: 'open' });
  if (!p) return null;
  const n = Math.min(Math.max(1, qty || p.remaining), p.remaining);
  const tradeDate = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : localDate(p.windowEnd);
  const { insertedId } = await db.collection('trades').insertOne({
    name: p.name,
    nameLower: p.nameLower,
    mtgoId: p.mtgoId,
    set: p.set,
    foil: p.foil,
    direction: p.direction,
    qty: n,
    price: price ?? null,
    counterparty: counterparty || '',
    note: note || '',
    date: tradeDate,
    source: 'manual',
    fromPending: p._id,
    createdAt: new Date(),
  });
  const remaining = p.remaining - n;
  await coll.updateOne(
    { _id: p._id },
    {
      $set: { remaining, ...(remaining === 0 ? { status: 'resolved', resolvedBy: 'manual', resolvedAt: new Date() } : {}) },
      $push: { matchedTrades: insertedId },
    }
  );
  return { remaining };
}

async function dismiss(db, ids, reason = '') {
  const objectIds = ids.filter((i) => ObjectId.isValid(i)).map((i) => new ObjectId(i));
  const r = await db
    .collection('pending_changes')
    .updateMany({ _id: { $in: objectIds }, status: 'open' }, { $set: { status: 'dismissed', reason, resolvedAt: new Date() } });
  return r.modifiedCount;
}

module.exports = { recordPendingChanges, reconcile, resolveManually, dismiss, localDate };
