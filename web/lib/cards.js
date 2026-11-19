const { getDb } = require('./db');
const scryfall = require('./scryfall');

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/**
 * Card search for the pickers. Uses the `cards` collection (every MTGO printing,
 * filled daily by the price sync) and falls back to your own collection if that
 * hasn't been populated yet. Each result includes current price and owned qty.
 */
async function search({ q = '', name = '', ownedOnly = false, limit = 25 }) {
  const db = getDb();
  const useCatalog = !ownedOnly && (await db.collection('cards').estimatedDocumentCount()) > 0;

  let rows;
  if (useCatalog) {
    const filter = name
      ? { nameLower: name.toLowerCase() }
      : { nameLower: { $regex: escapeRegex(q.toLowerCase()) } };
    rows = await db
      .collection('cards')
      .find(filter)
      .limit(name ? 200 : 400)
      .toArray();
    rows = rows.map((c) => ({ mtgoId: c._id, name: c.name, set: c.set, rarity: c.rarity, foil: c.foil }));
  } else {
    const filter = name ? { name } : { name: { $regex: escapeRegex(q), $options: 'i' } };
    filter.mtgoId = { $nin: [null, '1'] };
    rows = (await db.collection('collection').find(filter).limit(200).toArray()).map((c) => ({
      mtgoId: c.mtgoId, name: c.name, set: c.set, rarity: c.rarity, foil: c.foil,
    }));
  }

  const ids = rows.map((r) => r.mtgoId);
  // versions of one card (picker step 2): add Scryfall's label + images to tell them apart
  const [priceMap, ownedMap, info] = await Promise.all([getPrices(ids), getOwned(ids), name ? scryfall.versionInfo(db, ids) : new Map()]);
  for (const r of rows) {
    r.price = priceMap.get(r.mtgoId) ?? null;
    r.owned = ownedMap.get(r.mtgoId) || 0;
    if (name) {
      const i = info.get(r.mtgoId);
      r.label = i ? i.label : '';
      r.collector = i ? i.collector : '';
      r.imgSmall = (i && i.img.small) || null;
      r.imgLarge = (i && i.img.large) || scryfall.fallbackImage(r.mtgoId, 'large');
    }
  }

  // Rank: exact name, then name starts with query, then owned, then price
  const ql = (q || name).toLowerCase();
  rows.sort(
    (a, b) =>
      (b.name.toLowerCase() === ql) - (a.name.toLowerCase() === ql) ||
      b.name.toLowerCase().startsWith(ql) - a.name.toLowerCase().startsWith(ql) ||
      a.name.localeCompare(b.name) ||
      (b.owned > 0) - (a.owned > 0) ||
      (b.price ?? -1) - (a.price ?? -1)
  );
  return rows.slice(0, name ? 200 : limit);
}

/** Looks up one card by MTGO ID in the catalog, then in your collection. */
async function getCard(mtgoId) {
  const id = String(mtgoId || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const db = getDb();
  const c = (await db.collection('cards').findOne({ _id: id })) || (await db.collection('collection').findOne({ mtgoId: id }));
  if (!c) return null;
  const price = (await getPrices([id])).get(id) ?? null;
  return { mtgoId: id, name: c.name, set: c.set || '', rarity: c.rarity || '', foil: Boolean(c.foil), price };
}

async function getPrices(ids) {
  if (!ids.length) return new Map();
  const docs = await getDb().collection('prices').find({ _id: { $in: ids } }, { projection: { price: 1, prevPrice: 1 } }).toArray();
  const m = new Map(docs.map((d) => [d._id, d.price]));
  m.prev = new Map(docs.map((d) => [d._id, d.prevPrice]));
  return m;
}

async function getOwned(ids) {
  if (!ids.length) return new Map();
  const docs = await getDb().collection('collection').find({ mtgoId: { $in: ids } }, { projection: { mtgoId: 1, qty: 1 } }).toArray();
  return new Map(docs.map((d) => [d.mtgoId, d.qty]));
}

/** Map mtgoId → [{date, price}] ascending, for the last `days` days. */
async function getHistory(ids, days) {
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const docs = await getDb()
    .collection('price_history')
    .find({ mtgoId: { $in: ids }, date: { $gte: isoDaysAgo(days) } })
    .sort({ date: 1 })
    .toArray();
  for (const d of docs) out.get(d.mtgoId)?.push({ date: d.date, price: d.price });
  return out;
}

/** Price on (or the closest recorded day before) `days` ago. */
function priceDaysAgo(history, days) {
  const cutoff = isoDaysAgo(days);
  let found = null;
  for (const p of history) {
    if (p.date <= cutoff) found = p.price;
    else break;
  }
  return found;
}

function pctChange(now, before) {
  if (now == null || !before) return null;
  return ((now - before) / before) * 100;
}

/** Seeds today's price point so a newly tracked card's chart starts immediately. */
async function seedHistory(mtgoId, price) {
  if (price == null) return;
  const date = new Date().toISOString().slice(0, 10);
  await getDb()
    .collection('price_history')
    .updateOne({ _id: `${mtgoId}|${date}` }, { $setOnInsert: { mtgoId, date, price } }, { upsert: true });
}

module.exports = { search, getCard, getPrices, getOwned, getHistory, priceDaysAgo, pctChange, seedHistory };
