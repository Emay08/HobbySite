/**
 * Daily prices kept for later Treasure Chest analysis.
 *
 * GoatBots' price file only holds today's prices, so history has to be collected as it
 * happens. Every day this stores one compact document in `price_daily`:
 *   { _id: 'YYYY-MM-DD', date, count, prices: { <mtgoId>: price, … } }
 * for every printing of every card that has ever appeared in the Treasure Chest, plus
 * everything you own. (A few thousand IDs ≈ 60–100 KB a day; all ~90k MTGO IDs would be
 * over 1 MB a day, too much for a free Atlas cluster.)
 */
const keyPart = (s) =>
  String(s == null ? '' : s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').toLowerCase();

async function chestCardIds(db) {
  const [inContents, inChanges, allNames, owned] = await Promise.all([
    db.collection('tc_history').distinct('contents.nameKey'),
    db.collection('tc_history').distinct('changes.nameKey'),
    db.collection('cards').distinct('name'),
    db.collection('collection').distinct('mtgoId'),
  ]);
  const wanted = new Set([...inContents, ...inChanges]);
  const names = allNames.filter((n) => wanted.has(keyPart(n))).map((n) => n.toLowerCase());
  const ids = new Set(owned.filter(Boolean).map(String));
  for (let i = 0; i < names.length; i += 2000) {
    const docs = await db.collection('cards').find({ nameLower: { $in: names.slice(i, i + 2000) } }, { projection: { _id: 1 } }).toArray();
    for (const d of docs) ids.add(String(d._id));
  }
  ids.delete('1'); // Event Tickets
  return ids;
}

async function recordChestPrices(db, priceMap, { date = new Date().toISOString().slice(0, 10) } = {}) {
  const ids = await chestCardIds(db);
  const prices = {};
  let count = 0;
  for (const id of ids) {
    const p = priceMap.get(id);
    if (p == null) continue;
    prices[id] = p;
    count++;
  }
  await db.collection('price_daily').replaceOne({ _id: date }, { _id: date, date, count, prices, at: new Date() }, { upsert: true });
  return count;
}

module.exports = { recordChestPrices, chestCardIds };
