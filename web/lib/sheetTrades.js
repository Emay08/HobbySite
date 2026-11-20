/**
 * One-time import of the hand-kept buy/sell spreadsheet.
 *
 * The sheet has three columns (rebought, recently bought, sold), each oldest-first,
 * with card names as typed, an optional "(f)" for foil, "x4" for quantity and a price
 * per card — but no dates.
 *
 *   sheet_trades  the entries as imported (one per sheet cell), with the resolved card name
 *   trades        the per-card trade log; entries that GoatBots doesn't already have are
 *                 written here with source 'sheet', no date, and a date range
 *
 * Matching against GoatBots trades walks each column in order: an entry matches a GoatBots
 * trade of the same card, direction and price (to the cent) that isn't earlier than the
 * previous match in that column. Matched entries are duplicates and aren't written to
 * `trades`; unmatched ones get the range between their nearest matched neighbours.
 * syncSheetTrades() is re-run after every GoatBots upload, so older histories uploaded
 * later still remove duplicates and narrow the ranges.
 */
const nameMatch = require('./nameMatch');
const search = require('./search');
const { localDate } = require('./reconcile');

const DAY = 86400000;
const SLACK = 3 * DAY;
const PRICE_EPS = 0.0151;
const COLUMN_LABELS = { rebought: 'Rebought', bought: 'Recently bought', sold: 'Sold' };

const entryId = (e) => `sheet|${e.column}|${e.seq}`;

/** Card names to match against, best-preferred first: traded, watch lists, collection, everything. */
async function nameEntries(db) {
  const [idx, traded] = await Promise.all([search.getIndex(), db.collection('trades').distinct('name', { source: 'goatbots' })]);
  return nameMatch.makeEntries([...traded.map((name) => ({ name, tier: -1 })), ...idx.entries.map((e) => ({ name: e.name, tier: e.tier }))]);
}

/** Resolves every entry's card name. Pure apart from the name list. */
function resolveEntries(entries, names) {
  return entries.map((t) => {
    const r = nameMatch.resolve(names, t.text);
    return {
      _id: entryId(t),
      column: t.column,
      seq: t.seq,
      direction: t.direction === 'sell' ? 'sell' : 'buy',
      raw: t.raw,
      text: t.text,
      qty: Number.isFinite(t.qty) && t.qty > 0 ? t.qty : 1,
      price: Number.isFinite(t.price) ? t.price : null,
      foil: !!t.foil,
      hints: t.hints || '',
      match: r.status, // ok | check | none
      name: r.name,
      candidates: r.candidates.map((c) => c.name),
    };
  });
}

/**
 * Pure matching. entries: [{ _id, column, seq, nameLower, direction, qty, price }]
 * gb: [{ _id, nameLower, direction, qty, price, at: Date }]
 * Returns Map(entryId → { matched: [gbIds], at, from, to }) — from/to are Dates or null.
 */
function plan(entries, gb, { end = new Date() } = {}) {
  const byKey = new Map();
  for (const g of gb) {
    const k = `${g.nameLower}|${g.direction}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push({ ...g, t: new Date(g.at).getTime() });
  }
  for (const list of byKey.values()) list.sort((a, b) => a.t - b.t);

  const out = new Map();
  const columns = new Map();
  for (const e of entries) {
    if (!columns.has(e.column)) columns.set(e.column, []);
    columns.get(e.column).push(e);
  }
  for (const col of columns.values()) col.sort((a, b) => a.seq - b.seq);
  const day = (t) => Math.floor(t / DAY);

  // Each column is aligned separately; one GoatBots trade may explain entries in two
  // columns (a purchase noted under both "rebought" and "recently bought" is still one trade).
  const take = (e, first, list, claimed) => {
    const ids = [first._id];
    let q = first.qty || 1;
    claimed.add(first._id);
    for (const g of list) {
      if (q >= e.qty) break;
      if (claimed.has(g._id) || g.t < first.t || g.t - first.t > SLACK || Math.abs((g.price ?? -1) - (first.price ?? -1)) > PRICE_EPS) continue;
      ids.push(g._id);
      q += g.qty || 1;
      claimed.add(g._id);
    }
    out.set(e._id, { matched: ids, at: new Date(first.t), from: null, to: null });
  };

  // pass 1: priced entries. Longest chain of matches whose dates never go backwards
  // (to the day) as you go down the column — one stray match can't derail the rest.
  for (const col of columns.values()) {
    const nodes = []; // { i, g, d, len, prev }
    const byEntry = col.map(() => []);
    col.forEach((e, i) => {
      if (!e.nameLower || e.price == null) return;
      for (const g of byKey.get(`${e.nameLower}|${e.direction}`) || []) {
        if (Math.abs((g.price ?? -1) - e.price) >= PRICE_EPS) continue;
        const n = { i, g, d: day(g.t), len: 1, prev: null };
        for (let j = 0; j < i; j++) {
          for (const m of byEntry[j]) {
            if (m.d <= n.d && (m.len + 1 > n.len || (m.len + 1 === n.len && n.prev && m.d > n.prev.d))) {
              n.len = m.len + 1;
              n.prev = m;
            }
          }
        }
        byEntry[i].push(n);
        nodes.push(n);
      }
    });
    let best = null;
    for (const n of nodes) if (!best || n.len > best.len || (n.len === best.len && n.d < best.d)) best = n;
    const chain = [];
    for (let n = best; n; n = n.prev) chain.unshift(n);
    const claimed = new Set();
    for (const n of chain) {
      const e = col[n.i];
      let first = n.g;
      if (claimed.has(first._id)) {
        // same trade picked twice (e.g. "x8" written as two lines): use the next free one that day
        first = (byKey.get(`${e.nameLower}|${e.direction}`) || []).find(
          (g) => !claimed.has(g._id) && day(g.t) === n.d && Math.abs((g.price ?? -1) - e.price) < PRICE_EPS
        );
        if (!first) continue;
      }
      take(e, first, byKey.get(`${e.nameLower}|${e.direction}`) || [], claimed);
    }
    col.claimed = claimed;
  }

  // neighbouring matches give every other entry a date range
  const ranges = (col) => {
    const res = new Map();
    let prev = null;
    for (const e of col) {
      const m = out.get(e._id);
      if (m) prev = m.at.getTime();
      else res.set(e._id, { from: prev });
    }
    let next = null;
    for (let i = col.length - 1; i >= 0; i--) {
      const m = out.get(col[i]._id);
      if (m) next = m.at.getTime();
      else res.get(col[i]._id).to = next;
    }
    return res;
  };

  // pass 2: entries without a price — same card and direction, inside that range
  for (const col of columns.values()) {
    const r = ranges(col);
    for (const e of col) {
      if (out.has(e._id) || !e.nameLower || e.price != null) continue;
      const { from, to } = r.get(e._id);
      const list = byKey.get(`${e.nameLower}|${e.direction}`) || [];
      const first = list.find((g) => !col.claimed.has(g._id) && (from == null || g.t >= from - SLACK) && (to == null || g.t <= to + SLACK));
      if (first) take(e, first, list, col.claimed);
    }
  }

  for (const col of columns.values()) {
    const r = ranges(col);
    for (const [id, { from, to }] of r) {
      let a = from;
      let b = to == null ? new Date(end).getTime() : to;
      if (a != null && a > b) [a, b] = [b, a]; // neighbours a few days out of order
      out.set(id, { matched: [], at: null, from: a == null ? null : new Date(a), to: new Date(b) });
    }
  }
  return out;
}

// --------------------------------------------------------------- staging & review

async function stage(db, payload, { filename = '' } = {}) {
  if (!payload || payload.kind !== 'vault-sheet-import') {
    const err = new Error('This is not a spreadsheet import file (vault-import.json).');
    err.expose = true;
    throw err;
  }
  const tc = require('./tcHistory').prepareSheetUpdates(payload.tcUpdates);
  const names = await nameEntries(db);
  const trades = resolveEntries(payload.trades || [], names);
  const doc = {
    _id: 'sheet',
    filename,
    stagedAt: new Date(),
    sheetCreatedAt: payload.createdAt ? new Date(payload.createdAt) : new Date(),
    source: payload.source || '',
    tc,
    trades,
  };
  await db.collection('import_staging').replaceOne({ _id: 'sheet' }, doc, { upsert: true });
  return doc;
}

async function gbItems(db) {
  return db
    .collection('trades')
    .find({ source: 'goatbots' }, { projection: { nameLower: 1, direction: 1, qty: 1, price: 1, at: 1 } })
    .toArray();
}

/** Dry run of the matching for the review page. */
async function preview(db, staged) {
  const gb = await gbItems(db);
  const usable = staged.trades.filter((t) => t.name).map((t) => ({ ...t, nameLower: t.name.toLowerCase() }));
  const p = plan(usable, gb, { end: staged.sheetCreatedAt });
  const first = gb.length ? new Date(Math.min(...gb.map((g) => new Date(g.at).getTime()))) : null;
  const last = gb.length ? new Date(Math.max(...gb.map((g) => new Date(g.at).getTime()))) : null;
  const rows = staged.trades.map((t) => {
    const m = p.get(t._id);
    return {
      ...t,
      duplicate: !!(m && m.matched.length),
      matchedAt: m && m.at,
      from: m && m.from,
      to: m && m.to,
    };
  });
  const count = (f) => rows.filter(f).length;
  return {
    rows,
    gb: { items: gb.length, first, last },
    totals: {
      entries: rows.length,
      duplicates: count((r) => r.duplicate),
      toImport: count((r) => r.name && !r.duplicate),
      check: count((r) => r.match === 'check'),
      none: count((r) => r.match === 'none'),
      noPrice: count((r) => r.price == null),
    },
  };
}

// --------------------------------------------------------------- confirm, sync, fix, undo

/**
 * The real MTGO card name for what was typed, ignoring case, accents and punctuation
 * (’ vs ', commas, hyphens). Checked against the same names as the nav search: GoatBots'
 * card definitions, your collection and watch lists.
 */
const exactIndex = new WeakMap();
async function cardExists(db, name) {
  const key = nameMatch.simp(name);
  if (!key) return null;
  const idx = await search.getIndex();
  if (!exactIndex.has(idx)) exactIndex.set(idx, new Map(idx.entries.map((e) => [nameMatch.simp(e.name), e.name])));
  return exactIndex.get(idx).get(key) || null;
}

/** How many card names the import can match against (for error messages). */
async function knownNames() {
  const idx = await search.getIndex();
  return idx.entries.length;
}

/**
 * Writes the reviewed entries to sheet_trades. fixes: { [entryId]: 'Card Name' },
 * skips: Set(entryId). Entries still without a card name are kept (status 'unresolved')
 * so they can be fixed later on the import page.
 */
async function confirmTrades(db, staged, { fixes = {}, skips = new Set() } = {}) {
  const now = new Date();
  const problems = [];
  const docs = [];
  for (const t of staged.trades) {
    let name = t.name;
    const fix = (fixes[t._id] || '').trim();
    if (fix && fix !== t.name) {
      const real = await cardExists(db, fix);
      if (real) name = real;
      else problems.push(`“${fix}” (for “${t.raw}”) isn't in the ${(await knownNames()).toLocaleString('en-US')} card names known to the site — left unresolved.`);
    }
    const status = skips.has(t._id) ? 'skipped' : name ? 'resolved' : 'unresolved';
    docs.push({
      _id: t._id,
      column: t.column,
      seq: t.seq,
      direction: t.direction,
      raw: t.raw,
      text: t.text,
      qty: t.qty,
      price: t.price,
      foil: t.foil,
      hints: t.hints,
      name: name || null,
      nameLower: name ? name.toLowerCase() : null,
      candidates: t.candidates,
      reviewed: !!fix || t.match === 'ok',
      status,
      importedAt: now,
      sheetCreatedAt: staged.sheetCreatedAt,
    });
  }
  const coll = db.collection('sheet_trades');
  await coll.bulkWrite(
    docs.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })),
    { ordered: false }
  );
  await coll.createIndex({ status: 1 });
  return { written: docs.length, problems };
}

/** Re-matches all sheet entries against GoatBots trades and rewrites their trade-log rows. */
async function syncSheetTrades(db) {
  const coll = db.collection('sheet_trades');
  const entries = await coll.find().toArray();
  if (!entries.length) return null;
  const gb = await gbItems(db);
  const active = entries.filter((e) => e.status === 'resolved');
  const end = entries.reduce((m, e) => (e.sheetCreatedAt && e.sheetCreatedAt > m ? e.sheetCreatedAt : m), new Date(0));
  const p = plan(active, gb, { end: end.getTime() ? end : new Date() });

  const tradeOps = [];
  const entryOps = [];
  const stats = { imported: 0, duplicates: 0, unresolved: 0, skipped: 0 };
  // the single MTGO version each entry can refer to (only one printing with that foil-ness), in one query
  const wantedNames = [...new Set(entries.filter((e) => e.status === 'resolved').map((e) => e.nameLower))];
  const versions = new Map();
  for (let i = 0; i < wantedNames.length; i += 2000) {
    const defs = await db
      .collection('cards')
      .find({ nameLower: { $in: wantedNames.slice(i, i + 2000) } }, { projection: { nameLower: 1, set: 1, foil: 1 } })
      .toArray();
    for (const d of defs) {
      const k = `${d.nameLower}|${!!d.foil}`;
      versions.set(k, versions.has(k) ? null : { mtgoId: d._id, set: d.set }); // null = more than one
    }
  }
  for (const e of entries) {
    const m = p.get(e._id);
    const dup = !!(m && m.matched.length);
    if (e.status !== 'resolved' || dup) {
      tradeOps.push({ deleteOne: { filter: { _id: e._id } } });
      if (dup) stats.duplicates++;
      else if (e.status === 'skipped') stats.skipped++;
      else stats.unresolved++;
    } else {
      stats.imported++;
      const v = versions.get(`${e.nameLower}|${!!e.foil}`) || null;
      tradeOps.push({
        replaceOne: {
          filter: { _id: e._id },
          replacement: {
            _id: e._id,
            source: 'sheet',
            name: e.name,
            nameLower: e.nameLower,
            mtgoId: v ? v.mtgoId : null,
            set: v ? v.set : '',
            foil: e.foil,
            direction: e.direction,
            qty: e.qty,
            price: e.price,
            counterparty: '',
            note: `Spreadsheet (${COLUMN_LABELS[e.column] || e.column}): “${e.raw}”`,
            date: null,
            at: null,
            dateFrom: m && m.from ? localDate(m.from) : null,
            dateTo: m && m.to ? localDate(m.to) : null,
            createdAt: e.importedAt,
          },
          upsert: true,
        },
      });
    }
    entryOps.push({
      updateOne: {
        filter: { _id: e._id },
        update: {
          $set: {
            duplicateOf: dup ? m.matched : [],
            matchedAt: dup ? m.at : null,
            dateFrom: m && m.from ? m.from : null,
            dateTo: m && m.to ? m.to : null,
            syncedAt: new Date(),
          },
        },
      },
    });
  }
  if (tradeOps.length) await db.collection('trades').bulkWrite(tradeOps, { ordered: false });
  if (entryOps.length) await coll.bulkWrite(entryOps, { ordered: false });
  return stats;
}

async function fixEntry(db, id, name, { skip = false } = {}) {
  const coll = db.collection('sheet_trades');
  const e = await coll.findOne({ _id: id });
  if (!e) return { ok: false, message: 'Unknown spreadsheet entry.' };
  if (skip) {
    await coll.updateOne({ _id: id }, { $set: { status: 'skipped' } });
  } else {
    const real = await cardExists(db, name);
    if (!real) {
      const n = await knownNames();
      return {
        ok: false,
        message: `“${name}” isn't in the ${n.toLocaleString('en-US')} card names known to the site (GoatBots' card list + your collection).${n < 20000 ? ' That list looks incomplete — has the daily price sync run successfully?' : ''}`,
      };
    }
    await coll.updateOne({ _id: id }, { $set: { name: real, nameLower: real.toLowerCase(), status: 'resolved', reviewed: true } });
  }
  await syncSheetTrades(db);
  return { ok: true };
}

async function summary(db) {
  const coll = db.collection('sheet_trades');
  const n = await coll.estimatedDocumentCount();
  if (!n) return null;
  const [groups, open] = await Promise.all([
    coll
      .aggregate([
        { $group: { _id: { status: '$status', dup: { $gt: [{ $size: { $ifNull: ['$duplicateOf', []] } }, 0] } }, n: { $sum: 1 } } },
      ])
      .toArray(),
    coll.find({ status: 'unresolved' }).sort({ column: 1, seq: 1 }).toArray(),
  ]);
  const c = (status, dup) => groups.filter((g) => g._id.status === status && (dup === undefined || g._id.dup === dup)).reduce((s, g) => s + g.n, 0);
  return {
    total: n,
    imported: c('resolved', false),
    duplicates: c('resolved', true),
    unresolved: c('unresolved'),
    skipped: c('skipped'),
    open,
  };
}

async function undo(db) {
  const [t, s, h] = await Promise.all([
    db.collection('trades').deleteMany({ source: 'sheet' }),
    db.collection('sheet_trades').deleteMany({}),
    db.collection('tc_history').deleteMany({ source: 'sheet' }),
  ]);
  // updates the watcher also recorded keep their own data; just drop what the sheet added
  await db.collection('tc_history').updateMany({ sheetImportedAt: { $exists: true } }, { $unset: { sheetImportedAt: '', tab: '', excludedRows: '' } });
  return { trades: t.deletedCount, entries: s.deletedCount, updates: h.deletedCount };
}

module.exports = {
  COLUMN_LABELS,
  entryId,
  nameEntries,
  resolveEntries,
  plan,
  stage,
  preview,
  confirmTrades,
  syncSheetTrades,
  fixEntry,
  summary,
  undo,
};
