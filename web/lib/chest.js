/**
 * The current Treasure Chest, from the watcher's page snapshots (`tc_snapshots`), the
 * update history (`tc_history`) and daily prices (`price_daily`, `prices`).
 *
 *  - recordedAt: when the watcher first saw the chest's current contents (not the
 *    "Last Updated" date printed on the page)
 *  - added: versions newly added to the first table of the curated section this update
 *    (whole sets ignored), each matched to an MTGO ID, with prices per day since then
 *  - mine: cards on your watch lists or in your collection that are in any curated slot
 *    table now, matched by name, with sales since the update was recorded
 */
const tc = require('./tcHistory');
const scryfall = require('./scryfall');
const { localDate } = require('./reconcile');

const OFFICIAL_URL = 'https://www.mtgo.com/news/mtgo-treasure-chest-info';
const DAY = 86400000;

/** One string describing the slot contents, to tell whether two snapshots hold the same chest. */
function contentsSig(parsed) {
  return [...tc.snapshotTotals(parsed)].map(([k, v]) => `${k}=${v.slots}`).sort().join('\n');
}

/** The tables in the curated section (snapshots taken before sections were recorded: all tables). */
function curatedTables(parsed) {
  const slots = (parsed && parsed.slots) || [];
  const curated = slots.filter((s) => !s.section || /curated/i.test(s.section));
  return curated.length ? curated : slots;
}

/** The newest snapshot, and when its contents were first seen. */
async function currentSnapshot(db) {
  const snaps = await db.collection('tc_snapshots').find({}, { projection: { parsed: 1, takenAt: 1 } }).sort({ takenAt: -1 }).limit(40).toArray();
  if (!snaps.length) return null;
  const sig = contentsSig(snaps[0].parsed);
  let first = snaps[0];
  let sinceWatcherStart = true;
  for (const s of snaps.slice(1)) {
    if (contentsSig(s.parsed) !== sig) {
      sinceWatcherStart = false;
      break;
    }
    first = s;
  }
  return { parsed: snaps[0].parsed, latestAt: snaps[0].takenAt, recordedAt: first.takenAt, sinceWatcherStart };
}

const STOP = new Set(['foil', 'the', 'and', 'of', 'mystical', 'archive', 'frame', 'art', 'sos', 'soa']);
const words = (t) =>
  String(t || '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

/** Candidates whose Scryfall label (or set name) contains any of the words. */
function byWords(pool, ws, info) {
  if (!ws.length) return [];
  return pool.filter((c) => {
    const i = info.get(c._id);
    const text = `${(i && i.label) || ''} ${(i && i.setName) || ''}`.toLowerCase();
    return ws.some((w) => text.includes(w));
  });
}

/**
 * Picks the MTGO ID for one chest version (name, set, treatment). GoatBots' card list has
 * name, set and foil but no treatment, so when a set has several printings of the card:
 *   1. GoatBots' own Treasure Chest list names the variant ("Japanese", "Retro", or none
 *      for the regular printing) — matched against Scryfall's version labels   → 'goatbots'
 *   2. the official page's Treatment text, matched the same way                → 'treatment'
 *   3. no treatment: the printing Scryfall calls "Regular"                    → 'regular'
 *   4. otherwise the cheapest printing                                        → 'guess'
 */
function pickVersion(cands, row, info, price, gbEntry) {
  if (!cands.length) return { mtgoId: null, via: 'none' };
  const foil = /foil/i.test(row.treatment || '') || !!row.foil;
  let pool = cands.filter((c) => !!c.foil === foil);
  if (!pool.length) pool = cands;
  if (pool.length === 1) return { mtgoId: pool[0]._id, via: 'single' };
  if (gbEntry) {
    const hit = gbEntry.variant ? byWords(pool, words(gbEntry.variant), info) : pool.filter((c) => (info.get(c._id) || {}).label === 'Regular');
    if (hit.length === 1) return { mtgoId: hit[0]._id, via: 'goatbots' };
    if (hit.length) pool = hit;
  }
  const tw = words(row.treatment);
  if (tw.length) {
    const hit = byWords(pool, tw, info);
    if (hit.length === 1) return { mtgoId: hit[0]._id, via: 'treatment' };
    if (hit.length) pool = hit;
  } else {
    const regular = pool.filter((c) => (info.get(c._id) || {}).label === 'Regular');
    if (regular.length === 1) return { mtgoId: regular[0]._id, via: 'regular' };
  }
  const cheapest = [...pool].sort((a, b) => (price.get(a._id) ?? Infinity) - (price.get(b._id) ?? Infinity))[0];
  return { mtgoId: cheapest._id, via: 'guess' };
}

/** GoatBots' entry for a chest version: same name, set and foil; among several, the variant matching the treatment. */
function gbEntryFor(row, gbEntries) {
  const foil = /foil/i.test(row.treatment || '');
  const same = gbEntries.filter((e) => tc.keyPart(e.name) === tc.keyPart(row.name) && e.set === String(row.set).toUpperCase() && e.foil === foil);
  if (same.length <= 1) return same[0] || null;
  const tw = words(row.treatment);
  if (!tw.length) return same.find((e) => !e.variant) || null;
  return same.find((e) => words(e.variant).some((w) => tw.includes(w))) || null;
}

const VIA_RANK = { none: 0, guess: 1, regular: 2, treatment: 3, goatbots: 4, single: 5 };

/**
 * Resolves chest rows to MTGO IDs and remembers the answer per update in `tc_versions`.
 * A better-grounded answer (e.g. GoatBots' list appearing a day or two after the update)
 * replaces a weaker one, with a notice on the Highlights page; a weaker one never
 * overwrites a stronger one.
 */
async function resolveVersions(db, rows, { pageDate }) {
  const names = [...new Set(rows.map((r) => r.name.toLowerCase()))];
  const [cards, gbDoc] = await Promise.all([
    names.length
      ? db.collection('cards').find({ nameLower: { $in: names } }, { projection: { nameLower: 1, set: 1, foil: 1, firstSeen: 1, collector: 1 } }).toArray()
      : [],
    db.collection('gb_chest').findOne({ _id: 'current' }, { projection: { entries: 1, fetchedAt: 1 } }),
  ]);
  const gbEntries = (gbDoc && gbDoc.entries) || [];
  const candsFor = (r) => cards.filter((c) => c.nameLower === r.name.toLowerCase() && String(c.set).toUpperCase() === String(r.set).toUpperCase());
  const ambiguousIds = [...new Set(rows.flatMap((r) => { const c = candsFor(r); return c.length > 1 ? c.map((x) => x._id) : []; }))];
  const [info, prices] = await Promise.all([
    scryfall.versionInfo(db, ambiguousIds), // fetched (and cached) only where several printings compete
    db.collection('prices').find({ _id: { $in: cards.map((c) => c._id) } }, { projection: { price: 1 } }).toArray(),
  ]);
  const priceMap = new Map(prices.map((p) => [p._id, p.price]));
  const firstSeen = new Map(cards.map((c) => [c._id, c.firstSeen || null]));

  const coll = db.collection('tc_versions');
  const keys = rows.map((r) => `${pageDate || 'current'}|${tc.versionKey(r)}`);
  const stored = new Map((await coll.find({ _id: { $in: keys } }).toArray()).map((d) => [d._id, d]));
  const out = new Map();
  const ops = [];
  const notices = [];
  rows.forEach((r, i) => {
    const key = keys[i];
    const fresh = pickVersion(candsFor(r), r, info, priceMap, gbEntryFor(r, gbEntries));
    const old = stored.get(key);
    let use = fresh;
    // "only printing" stops being true when GoatBots lists another one, so it doesn't stick
    if (old && old.mtgoId && old.via !== 'single' && VIA_RANK[old.via] > VIA_RANK[fresh.via]) use = { mtgoId: old.mtgoId, via: old.via };
    out.set(tc.versionKey(r), use);
    if (!old || old.mtgoId !== use.mtgoId || old.via !== use.via) {
      stored.set(key, { ...use });
      ops.push({ replaceOne: { filter: { _id: key }, replacement: { _id: key, ...use, name: r.name, set: r.set, treatment: r.treatment, at: new Date() }, upsert: true } });
      if (old && old.mtgoId && old.via !== 'single' && use.mtgoId && old.mtgoId !== use.mtgoId) notices.push({ r, from: old.mtgoId, to: use.mtgoId, via: use.via });
    }
  });
  if (ops.length) await coll.bulkWrite(ops, { ordered: false });
  for (const n of notices) {
    const i = info.get(n.to) || {};
    await db.collection('highlights').updateOne(
      { _id: `tc-version|${pageDate}|${tc.versionKey(n.r)}|${n.to}` },
      {
        $setOnInsert: {
          source: 'Treasure Chest',
          category: 'treasure-chest',
          title: `Treasure Chest version corrected: ${n.r.name}`,
          summary: `${n.r.set}${n.r.treatment ? ` · ${n.r.treatment}` : ''} is MTGO #${n.to}${i.label ? ` (${i.label}${i.collector ? ` #${i.collector}` : ''})` : ''}, not #${n.from}${n.via === 'goatbots' ? " — confirmed by GoatBots' Treasure Chest list" : ''}.`,
          url: '/mtgo/chest',
          detectedAt: new Date(),
          notified: false,
        },
      },
      { upsert: true }
    );
  }
  return { versions: out, priceMap, firstSeen, gbFetchedAt: gbDoc && gbDoc.fetchedAt };
}

const NEW_WINDOW = 2 * DAY;

/**
 * A printing GoatBots only started listing around this update. Its early prices are rough
 * guesses that swing until enough copies have traded, so it's kept out of the average.
 * Printings already listed in the very first card sync (or stored before firstSeen was
 * recorded) existed before tracking began, so they're never "new".
 */
function isNewPrinting(firstSeen, recordedAt, firstSyncAt) {
  if (!firstSeen) return false;
  const t = new Date(firstSeen).getTime();
  if (firstSyncAt && t - new Date(firstSyncAt).getTime() < 6 * 3600000) return false;
  return t >= new Date(recordedAt).getTime() - NEW_WINDOW;
}

/** Average price of the given MTGO IDs per day since `since`, from price_daily (+ today's prices). */
async function dailyAverages(db, ids, since, priceMap) {
  if (!ids.length) return [];
  const start = localDate(since);
  const docs = await db
    .collection('price_daily')
    .find({ _id: { $gte: start } }, { projection: Object.fromEntries([['date', 1], ...ids.map((id) => [`prices.${id}`, 1])]) })
    .sort({ _id: 1 })
    .toArray();
  const points = docs.map((d) => {
    const vals = ids.map((id) => d.prices && d.prices[id]).filter((v) => typeof v === 'number');
    return { date: d._id, n: vals.length, avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null };
  });
  // today's prices if the daily snapshot for today isn't there yet
  const today = localDate(new Date());
  if (!points.length || points[points.length - 1].date < today) {
    const vals = ids.map((id) => priceMap.get(id)).filter((v) => typeof v === 'number');
    if (vals.length) points.push({ date: today, n: vals.length, avg: vals.reduce((a, b) => a + b, 0) / vals.length, live: true });
  }
  const t0 = new Date(`${start}T00:00:00Z`).getTime();
  return points
    .filter((p) => p.avg !== null)
    .map((p) => ({ ...p, day: Math.round((new Date(`${p.date}T00:00:00Z`).getTime() - t0) / DAY) }));
}

/**
 * Per MTGO ID since `since`: the first recorded price (the baseline for "change since the
 * update") and the lowest price, from price_daily plus today's price.
 */
async function priceStats(db, ids, since, priceMap) {
  const out = new Map();
  if (!ids.length) return out;
  const docs = await db
    .collection('price_daily')
    .find({ _id: { $gte: localDate(since) } }, { projection: Object.fromEntries(ids.map((id) => [`prices.${id}`, 1])) })
    .sort({ _id: 1 })
    .toArray();
  for (const id of ids) {
    const series = docs.map((d) => d.prices && d.prices[id]).filter((v) => typeof v === 'number');
    const now = priceMap.get(id);
    if (typeof now === 'number') series.push(now);
    if (!series.length) continue;
    out.set(id, { base: series[0], baseDate: docs.find((d) => d.prices && typeof d.prices[id] === 'number')?._id || null, low: Math.min(...series) });
  }
  return out;
}

async function currentChest(db) {
  const snap = await currentSnapshot(db);
  if (!snap) return null;
  const { parsed, recordedAt } = snap;
  const tables = curatedTables(parsed);
  const first = tables[0] || { name: 'CURATED SLOT', cards: [] };

  // ---- newly added to the first curated table this update
  const date = tc.pageDate(parsed.lastUpdatedText);
  const hist = date ? await db.collection('tc_history').findOne({ _id: date }, { projection: { changes: 1 } }) : null;
  const addedKeys = new Set(
    ((hist && hist.changes) || []).filter((r) => r.slots > 0 && r.slots - (r.change || 0) <= 0).map((r) => tc.versionKey(r))
  );
  const added = first.cards.filter((c) => !tc.isProduct(c.name) && addedKeys.has(tc.versionKey(c)));
  const [map, syncMeta] = await Promise.all([resolveVersions(db, added, { pageDate: date }), db.collection('meta').findOne({ _id: 'cardSync' }, { projection: { firstSyncAt: 1 } })]);
  for (const a of added) {
    const v = map.versions.get(tc.versionKey(a));
    a.mtgoId = v.mtgoId;
    a.via = v.via;
    a.price = a.mtgoId ? map.priceMap.get(a.mtgoId) ?? null : null;
    // left out of the graph: new printings (volatile early prices) and ones GoatBots doesn't list yet
    a.newPrinting = !a.mtgoId || isNewPrinting(map.firstSeen.get(a.mtgoId), recordedAt, syncMeta && syncMeta.firstSyncAt);
  }
  added.sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
  const graphed = added.filter((a) => !a.newPrinting);
  const series = await dailyAverages(db, graphed.map((a) => a.mtgoId), recordedAt, map.priceMap);

  // ---- your cards in any curated table, by name
  const inChest = new Map(); // nameKey → { name, rows: [{ table, set, treatment, slots }] }
  for (const t of tables) {
    for (const c of t.cards) {
      if (tc.isProduct(c.name)) continue;
      const k = tc.keyPart(c.name);
      if (!inChest.has(k)) inChest.set(k, { name: c.name, rows: [] });
      inChest.get(k).rows.push({ table: t.name, set: c.set, treatment: c.treatment, slots: c.slots, name: c.name });
    }
  }
  const [owned, watch] = await Promise.all([
    db.collection('collection').aggregate([{ $group: { _id: { $toLower: '$name' }, name: { $first: '$name' }, qty: { $sum: '$qty' } } }]).toArray(),
    db.collection('watchlist').find({}, { projection: { name: 1, list: 1, mtgoId: 1, set: 1, foil: 1 } }).toArray(),
  ]);
  const ownedBy = new Map(owned.map((o) => [tc.keyPart(o.name), o]));
  const watchBy = new Map();
  for (const w of watch) {
    const k = tc.keyPart(w.name);
    if (!watchBy.has(k)) watchBy.set(k, []);
    watchBy.get(k).push(w);
  }
  const mineKeys = [...inChest.keys()].filter((k) => ownedBy.has(k) || watchBy.has(k));
  const mineRows = mineKeys.flatMap((k) => inChest.get(k).rows);
  const map2 = await resolveVersions(db, mineRows, { pageDate: date });

  // sales since the update was recorded: trades (GoatBots or logged) and unconfirmed collection drops
  const lowers = mineKeys.map((k) => inChest.get(k).name.toLowerCase());
  const [sales, drops] = await Promise.all([
    db
      .collection('trades')
      .find(
        { nameLower: { $in: lowers }, direction: 'sell', $or: [{ at: { $gte: recordedAt } }, { at: null, date: { $gte: localDate(recordedAt) } }] },
        { projection: { nameLower: 1, qty: 1, at: 1, date: 1, source: 1 } }
      )
      .toArray(),
    db
      .collection('pending_changes')
      .find({ nameLower: { $in: lowers }, direction: 'sell', status: 'open', windowEnd: { $gte: recordedAt } }, { projection: { nameLower: 1, remaining: 1, windowEnd: 1 } })
      .toArray(),
  ]);
  const soldBy = new Map();
  for (const s of sales) {
    const k = tc.keyPart(s.nameLower);
    const cur = soldBy.get(k) || { qty: 0, last: null, unconfirmed: 0 };
    cur.qty += s.qty || 0;
    const when = s.at || s.date;
    if (!cur.last || String(when) > String(cur.last)) cur.last = when;
    soldBy.set(k, cur);
  }
  for (const d of drops) {
    const k = tc.keyPart(d.nameLower);
    const cur = soldBy.get(k) || { qty: 0, last: null, unconfirmed: 0 };
    cur.unconfirmed += d.remaining || 0;
    soldBy.set(k, cur);
  }

  const mineVersions = new Map(
    mineKeys.map((k) => [
      k,
      inChest.get(k).rows.map((r) => {
        const { mtgoId, via } = map2.versions.get(tc.versionKey(r));
        return { ...r, mtgoId, via, price: mtgoId ? map2.priceMap.get(mtgoId) ?? null : null };
      }),
    ])
  );
  const stats = await priceStats(
    db,
    [...new Set([...mineVersions.values()].flat().map((v) => v.mtgoId).filter(Boolean))],
    recordedAt,
    map2.priceMap
  );

  const mine = mineKeys.map((k) => {
    const c = inChest.get(k);
    const versions = mineVersions.get(k);
    // the card's price = its most expensive chest version; change and low follow that version
    const top = versions.filter((v) => v.price != null).sort((a, b) => b.price - a.price)[0] || null;
    const st = top && stats.get(top.mtgoId);
    return {
      name: (ownedBy.get(k) && ownedBy.get(k).name) || c.name,
      versions,
      price: top ? top.price : null,
      basePrice: st ? st.base : null,
      baseDate: st ? st.baseDate : null,
      change: st && st.base > 0 && top ? (top.price / st.base - 1) * 100 : null,
      low: st ? st.low : null,
      owned: ownedBy.has(k) ? ownedBy.get(k).qty : 0,
      watch: watchBy.get(k) || [],
      sold: soldBy.get(k) || null,
    };
  });
  mine.sort((a, b) => (b.price ?? -1) - (a.price ?? -1) || a.name.localeCompare(b.name));

  return {
    officialUrl: OFFICIAL_URL,
    recordedAt,
    sinceWatcherStart: snap.sinceWatcherStart,
    checkedAt: snap.latestAt,
    pageDate: date,
    lastUpdatedText: parsed.lastUpdatedText,
    nextUpdateText: parsed.nextUpdateText,
    effectiveText: parsed.effectiveText,
    tables: tables.map((t) => ({ name: t.name, cards: t.cards.length, slots: t.cards.reduce((n, c) => n + (c.slots || 0), 0) })),
    firstTable: first.name,
    hasHistory: !!hist,
    added,
    gbFetchedAt: map2.gbFetchedAt || map.gbFetchedAt || null,
    graphedCount: graphed.length,
    series,
    mine,
  };
}

module.exports = { currentChest, priceStats, pickVersion, gbEntryFor, resolveVersions, isNewPrinting, curatedTables, contentsSig, OFFICIAL_URL };
