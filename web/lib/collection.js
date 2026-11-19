const { getDb, getClient } = require('./db');

/**
 * Event Tickets (MTGO ID 1) are worth exactly 1 tix each; they are kept out of
 * "most valuable card" lists but counted in total value.
 */
const EVENT_TICKET_ID = '1';

/** Pipeline stage that joins each collection entry to its latest price. */
const PRICE_LOOKUP = [
  {
    $lookup: {
      from: 'prices',
      localField: 'mtgoId',
      foreignField: '_id',
      as: 'p',
    },
  },
  {
    $addFields: {
      price: {
        $cond: [
          { $eq: ['$mtgoId', EVENT_TICKET_ID] },
          1,
          { $ifNull: [{ $arrayElemAt: ['$p.price', 0] }, null] },
        ],
      },
    },
  },
  { $addFields: { value: { $multiply: [{ $ifNull: ['$price', 0] }, '$qty'] } } },
  { $project: { p: 0 } },
];

async function getSummary() {
  const db = getDb();
  const [totals] = await db
    .collection('collection')
    .aggregate([
      ...PRICE_LOOKUP,
      {
        $group: {
          _id: null,
          totalValue: { $sum: '$value' },
          totalCards: { $sum: '$qty' },
          uniqueCards: { $sum: 1 },
          unpriced: { $sum: { $cond: [{ $eq: ['$price', null] }, 1, 0] } },
          foilValue: { $sum: { $cond: ['$foil', '$value', 0] } },
        },
      },
    ])
    .toArray();

  const lastUpload = await db.collection('uploads').find().sort({ uploadedAt: -1 }).limit(1).next();
  const priceMeta = await db.collection('meta').findOne({ _id: 'priceSync' });

  return {
    totalValue: totals?.totalValue || 0,
    totalCards: totals?.totalCards || 0,
    uniqueCards: totals?.uniqueCards || 0,
    unpriced: totals?.unpriced || 0,
    foilValue: totals?.foilValue || 0,
    lastUpload,
    pricesUpdatedAt: priceMeta?.updatedAt || null,
  };
}

async function getTopCards({ limit = 25, by = 'value' } = {}) {
  const sortField = by === 'price' ? 'price' : 'value';
  return getDb()
    .collection('collection')
    .aggregate([
      { $match: { mtgoId: { $ne: EVENT_TICKET_ID } } },
      ...PRICE_LOOKUP,
      { $match: { price: { $ne: null } } },
      { $sort: { [sortField]: -1 } },
      { $limit: limit },
    ])
    .toArray();
}

async function getBreakdown(field) {
  return getDb()
    .collection('collection')
    .aggregate([
      ...PRICE_LOOKUP,
      {
        $group: {
          _id: `$${field}`,
          value: { $sum: '$value' },
          cards: { $sum: '$qty' },
        },
      },
      { $sort: { value: -1 } },
    ])
    .toArray();
}

async function searchCards({ q = '', set = '', sort = 'value', page = 1, pageSize = 50 }) {
  const match = {};
  if (q) match.name = { $regex: escapeRegex(q), $options: 'i' };
  if (set) match.set = set.toUpperCase();
  const sortMap = {
    value: { value: -1 },
    price: { price: -1 },
    name: { name: 1 },
    qty: { qty: -1 },
  };
  const skip = (Math.max(1, page) - 1) * pageSize;

  const [result] = await getDb()
    .collection('collection')
    .aggregate([
      { $match: match },
      ...PRICE_LOOKUP,
      { $sort: sortMap[sort] || sortMap.value },
      {
        $facet: {
          rows: [{ $skip: skip }, { $limit: pageSize }],
          count: [{ $count: 'n' }],
        },
      },
    ])
    .toArray();

  return { rows: result.rows, total: result.count[0]?.n || 0 };
}

async function getValueHistory(days = 180) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return getDb()
    .collection('value_history')
    .find({ date: { $gte: since } })
    .sort({ date: 1 })
    .toArray();
}

/**
 * Replaces the stored collection with the uploaded export, inside a
 * transaction when the cluster supports it (Atlas does).
 * Returns a diff summary versus the previous collection.
 */
async function replaceCollection(cards, meta) {
  const db = getDb();
  const coll = db.collection('collection');

  const previous = await coll.find({}, { projection: { qty: 1, name: 1 } }).toArray();
  const prevMap = new Map(previous.map((c) => [c._id, c]));
  const nextMap = new Map(cards.map((c) => [c._id, c]));

  const diff = { added: [], removed: [], changed: [] };
  for (const c of cards) {
    const p = prevMap.get(c._id);
    if (!p) diff.added.push({ name: c.name, qty: c.qty });
    else if (p.qty !== c.qty) diff.changed.push({ name: c.name, from: p.qty, to: c.qty });
  }
  for (const p of previous) {
    if (!nextMap.has(p._id)) diff.removed.push({ name: p.name, qty: p.qty });
  }

  const now = new Date();
  const docs = cards.map((c) => ({ ...c, updatedAt: now }));

  const session = getClient().startSession();
  try {
    await session.withTransaction(async () => {
      await coll.deleteMany({}, { session });
      if (docs.length) await coll.insertMany(docs, { session });
    });
  } catch (err) {
    // Standalone servers don't support transactions; fall back to non-atomic replace.
    if (/Transaction numbers are only allowed|replica set/i.test(err.message)) {
      await coll.deleteMany({});
      if (docs.length) await coll.insertMany(docs);
    } else {
      throw err;
    }
  } finally {
    await session.endSession();
  }

  await db.collection('uploads').insertOne({
    uploadedAt: now,
    filename: meta.filename,
    uniqueCards: cards.length,
    totalCards: cards.reduce((s, c) => s + c.qty, 0),
    added: diff.added.length,
    removed: diff.removed.length,
    changed: diff.changed.length,
  });

  await recordTodayValue();
  return diff;
}

/** Upserts today's total collection value into value_history. */
async function recordTodayValue() {
  const { totalValue, totalCards } = await getSummary();
  const date = new Date().toISOString().slice(0, 10);
  await getDb()
    .collection('value_history')
    .updateOne({ date }, { $set: { date, totalValue, totalCards, at: new Date() } }, { upsert: true });
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  getSummary,
  getTopCards,
  getBreakdown,
  searchCards,
  getValueHistory,
  replaceCollection,
  recordTodayValue,
};
