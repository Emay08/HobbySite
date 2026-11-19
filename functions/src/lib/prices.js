const AdmZip = require('adm-zip');
const telegram = require('./telegram');

const { downloadFirst } = require('./goatbotsDownload');

const DEFAULT_URLS = ['https://www.goatbots.com/download/prices/price-history.zip', 'https://www.goatbots.com/download/price-history.zip'];

/**
 * Downloads GoatBots' daily price file. The zip holds one JSON text file that maps
 * MTGO catalog ID → price in tix, e.g. {"12345": 0.03, "67890": 41.2}.
 * MTGO catalog IDs are the same numbers as the "ID #" column in the MTGO CSV export.
 */
async function downloadPrices(urls = [process.env.GOATBOTS_PRICES_URL, ...DEFAULT_URLS]) {
  return parsePriceZip(await downloadFirst([].concat(urls), 'Price'));
}

function parsePriceZip(buf) {
  const zip = new AdmZip(buf);
  const entry = zip.getEntries().find((e) => !e.isDirectory && /\.(txt|json)$/i.test(e.entryName));
  if (!entry) throw new Error('Price zip contained no .txt/.json file');
  const json = JSON.parse(entry.getData().toString('utf8'));
  return { prices: normalisePrices(json), file: entry.entryName };
}

function normalisePrices(json) {
  const out = new Map();
  for (const [id, v] of Object.entries(json)) {
    const price = typeof v === 'number' ? v : typeof v === 'object' && v ? Number(v.price ?? v.sell ?? v.p) : Number(v);
    if (Number.isFinite(price) && price >= 0) out.set(String(id), price);
  }
  if (out.size === 0) throw new Error('Price file parsed but no prices found');
  return out;
}

/**
 * Upserts prices, keeping the previous value in prevPrice so day-over-day
 * moves can be detected. Only owned cards' previous prices matter for alerts,
 * but storing all keeps the collection browser's lookup simple.
 */
async function storePrices(db, prices) {
  const coll = db.collection('prices');
  const now = new Date();
  const ops = [];
  let written = 0;
  for (const [id, price] of prices) {
    ops.push({
      updateOne: {
        filter: { _id: id },
        update: [{ $set: { prevPrice: { $ifNull: ['$price', price] }, price, updatedAt: now } }],
        upsert: true,
      },
    });
    if (ops.length === 5000) {
      await coll.bulkWrite(ops.splice(0), { ordered: false });
      written += 5000;
    }
  }
  if (ops.length) {
    written += ops.length;
    await coll.bulkWrite(ops, { ordered: false });
  }
  await db.collection('meta').updateOne({ _id: 'priceSync' }, { $set: { updatedAt: now, count: written } }, { upsert: true });
  return written;
}

/** Same valuation the website uses: owned qty × latest price, Event Tickets = 1. */
async function recordCollectionValue(db) {
  const [t] = await db
    .collection('collection')
    .aggregate([
      { $lookup: { from: 'prices', localField: 'mtgoId', foreignField: '_id', as: 'p' } },
      {
        $project: {
          qty: 1,
          v: {
            $multiply: [
              '$qty',
              { $cond: [{ $eq: ['$mtgoId', '1'] }, 1, { $ifNull: [{ $arrayElemAt: ['$p.price', 0] }, 0] }] },
            ],
          },
        },
      },
      { $group: { _id: null, totalValue: { $sum: '$v' }, totalCards: { $sum: '$qty' } } },
    ])
    .toArray();
  const date = new Date().toISOString().slice(0, 10);
  const doc = { date, totalValue: t?.totalValue || 0, totalCards: t?.totalCards || 0, at: new Date() };
  await db.collection('value_history').updateOne({ date }, { $set: doc }, { upsert: true });
  return doc;
}

/** Owned cards whose price moved a lot since the previous sync. */
async function findMovers(db, { minPct = 25, minTix = 2 } = {}) {
  return db
    .collection('collection')
    .aggregate([
      { $match: { mtgoId: { $nin: [null, '1'] } } },
      { $lookup: { from: 'prices', localField: 'mtgoId', foreignField: '_id', as: 'p' } },
      { $unwind: '$p' },
      { $match: { 'p.prevPrice': { $gt: 0 } } },
      {
        $project: {
          name: 1, set: 1, foil: 1, qty: 1,
          price: '$p.price', prev: '$p.prevPrice',
          pct: { $multiply: [{ $divide: [{ $subtract: ['$p.price', '$p.prevPrice'] }, '$p.prevPrice'] }, 100] },
        },
      },
      {
        $match: {
          $expr: {
            $and: [
              { $gte: [{ $abs: '$pct' }, minPct] },
              { $gte: [{ $max: ['$price', '$prev'] }, minTix] },
            ],
          },
        },
      },
      { $sort: { pct: -1 } },
      { $limit: 20 },
    ])
    .toArray();
}

async function sendMoversAlert(movers, valueToday, valueYesterday) {
  if (!movers.length) return null;
  const e = telegram.escapeHtml;
  const fmt = (n) => n.toFixed(2);
  const lines = movers.map(
    (m) => `${m.pct >= 0 ? '📈' : '📉'} ${e(m.name)}${m.foil ? ' ✦' : ''} (${e(m.set)}) ${fmt(m.prev)} → <b>${fmt(m.price)}</b> (${m.pct >= 0 ? '+' : ''}${m.pct.toFixed(0)}%) ×${m.qty}`
  );
  let header = '<b>Price movers in your collection</b>';
  if (valueYesterday) {
    const d = valueToday.totalValue - valueYesterday.totalValue;
    header += `\nCollection: ${fmt(valueToday.totalValue)} tix (${d >= 0 ? '+' : ''}${fmt(d)})`;
  }
  return telegram.sendMessage(`${header}\n\n${lines.join('\n')}`, { disablePreview: true });
}

module.exports = { downloadPrices, parsePriceZip, normalisePrices, storePrices, recordCollectionValue, findMovers, sendMoversAlert };
