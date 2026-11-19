/**
 * Treasure Chest history.
 *
 * `tc_history` holds one document per Treasure Chest update (_id = 'YYYY-MM-DD'):
 *   changes   – the update's CHANGELIST rows: { name, nameKey, set, treatment, slots, change }
 *               ("slots" is the card's total slots after the update, "change" the difference)
 *   contents  – the chest's full contents after the update: { name, nameKey, set, treatment, slots }
 *   issues    – CHANGELIST rows that disagree with the rebuilt contents
 *
 * Your spreadsheet only recorded CHANGELISTs, so cards that didn't change in an update
 * aren't in that update's tab. Full contents are rebuilt backwards from the newest page
 * snapshot the watcher has stored: contents before an update = contents after it, with
 * every changed card set back to (slots − change). Future updates are written by the
 * Azure watcher directly, contents and all.
 */

const keyPart = (s) =>
  String(s == null ? '' : s)
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase();

const versionKey = (r) => [r.name, r.set, r.treatment].map(keyPart).join('|');
const nameSetKey = (r) => [r.name, r.set].map(keyPart).join('|');

/** Sealed products and whole sets in the chest ("Bloomburrow Set", "Aetherdrift Golden Booster"). */
const isProduct = (name) => /\b(set|booster|boosters|bundle|pack|box)$/i.test(String(name || '').trim());

const rowOut = (r) => ({
  name: r.name,
  nameKey: keyPart(r.name),
  set: String(r.set || '').toUpperCase(),
  treatment: r.treatment || '',
  slots: r.slots,
  ...(r.change !== undefined ? { change: r.change } : {}),
});

// --------------------------------------------------------------- spreadsheet import

/**
 * Sorts the spreadsheet's updates and flags tabs that were mostly copied from the
 * previous tab (rows identical to the previous tab's rows when more than half match).
 */
function prepareSheetUpdates(updates) {
  const list = [...(updates || [])]
    .filter((u) => /^\d{4}-\d{2}-\d{2}$/.test(u.date) && Array.isArray(u.rows))
    .sort((a, b) => a.date.localeCompare(b.date));
  const sig = (r) => [keyPart(r.name), keyPart(r.set), r.slots, r.change].join('|');
  const out = [];
  let prevSigs = null;
  for (const u of list) {
    const rows = u.rows
      .filter((r) => r && r.name && Number.isFinite(r.slots))
      .map((r) => ({ name: String(r.name), set: String(r.set || ''), treatment: String(r.treatment || ''), slots: r.slots, change: Number.isFinite(r.change) ? r.change : null }));
    const copiedIdx = prevSigs ? rows.map((r, i) => (prevSigs.has(sig(r)) ? i : -1)).filter((i) => i >= 0) : [];
    const copied = copiedIdx.length > rows.length / 2 ? new Set(copiedIdx) : new Set();
    const kept = rows.filter((_, i) => !copied.has(i));
    const excluded = rows.filter((_, i) => copied.has(i));
    out.push({
      date: u.date,
      tab: u.tab || u.date,
      hasTreatment: u.hasTreatment !== false,
      rows: kept,
      excludedRows: excluded,
      added: kept.filter((r) => r.change > 0 && r.slots === r.change).length,
      removed: kept.filter((r) => r.slots === 0).length,
      noChange: kept.filter((r) => r.change === null).length,
    });
    prevSigs = new Set(rows.map(sig));
  }
  return out;
}

async function storeSheetUpdates(db, prepared, { includeExcluded = false } = {}) {
  const coll = db.collection('tc_history');
  let written = 0;
  for (const u of prepared) {
    const rows = includeExcluded ? [...u.rows, ...u.excludedRows] : u.rows;
    const existing = await coll.findOne({ _id: u.date }, { projection: { source: 1 } });
    await coll.updateOne(
      { _id: u.date },
      {
        $set: {
          date: u.date,
          tab: u.tab,
          hasTreatment: u.hasTreatment,
          changes: rows.filter((r) => r.change !== null).map(rowOut),
          excludedRows: includeExcluded ? [] : u.excludedRows.map(rowOut),
          sheetImportedAt: new Date(),
          source: existing && existing.source && existing.source !== 'sheet' ? existing.source : 'sheet',
        },
      },
      { upsert: true }
    );
    written++;
  }
  await coll.createIndex({ date: 1 });
  return written;
}

// --------------------------------------------------------------- snapshots

/** Total slots per card version across all slot tables of a parsed page (same as the watcher). */
function snapshotTotals(parsed) {
  const totals = new Map();
  for (const slot of (parsed && parsed.slots) || []) {
    for (const c of slot.cards || []) {
      const k = versionKey(c);
      const cur = totals.get(k);
      if (cur) cur.slots += c.slots || 0;
      else totals.set(k, { name: c.name, set: String(c.set || '').toUpperCase(), treatment: c.treatment || '', slots: c.slots || 0 });
    }
  }
  return totals;
}

/** "Last Updated: 11/9/2026 1 p.m. PT" → '2026-11-09' */
function pageDate(text) {
  const m = String(text || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

const toContents = (state) =>
  [...state.values()]
    .filter((v) => v.slots > 0)
    .map(rowOut)
    .sort((a, b) => a.nameKey.localeCompare(b.nameKey) || a.set.localeCompare(b.set) || a.treatment.localeCompare(b.treatment));

/**
 * Finds the state entry a CHANGELIST row refers to. Rows from tabs without a Treatment
 * column (before June 2024) only name the card and set; then the version whose slot
 * count matches is used, or an "unknown version" entry.
 */
function locate(state, row, used) {
  const exact = versionKey(row);
  if (row.treatment && state.has(exact)) return exact;
  const prefix = `${nameSetKey(row)}|`;
  const cands = [...state.keys()].filter((k) => k.startsWith(prefix) && !used.has(k));
  if (row.treatment) {
    // treatment spelled differently on the page vs. the sheet: accept a lone version
    return cands.length === 1 ? cands[0] : exact;
  }
  if (row.slots > 0) {
    const same = cands.find((k) => state.get(k).slots === row.slots);
    if (same) return same;
    if (cands.length) return cands[0];
  }
  return exact; // name|set| (unknown version)
}

/**
 * Rebuilds `contents` for every update up to the newest page snapshot.
 * Returns { ok, anchor, rebuilt, issues } or { ok: false, reason }.
 */
async function rebuildContents(db) {
  const snap = await db.collection('tc_snapshots').find().sort({ takenAt: -1 }).limit(1).next();
  if (!snap) return { ok: false, reason: 'The Treasure Chest watcher has not stored a snapshot of the page yet.' };
  const snapDate = pageDate(snap.parsed && snap.parsed.lastUpdatedText) || snap.takenAt.toISOString().slice(0, 10);

  const coll = db.collection('tc_history');
  const docs = await coll.find({}, { projection: { date: 1, changes: 1, source: 1 } }).sort({ date: 1 }).toArray();
  let anchor = -1;
  for (let i = 0; i < docs.length; i++) if (docs[i].date <= snapDate) anchor = i;
  if (anchor < 0) return { ok: false, reason: `No recorded update on or before the snapshot's date (${snapDate}).` };

  const results = new Map(); // date → { contents, issues }
  let state = new Map([...snapshotTotals(snap.parsed)].map(([k, v]) => [k, { ...v }]));
  let issueCount = 0;

  for (let i = anchor; i >= 0; i--) {
    const doc = docs[i];
    const issues = [];
    const used = new Set();
    // the rows describe the state after this update: check them against it…
    const located = (doc.changes || []).map((r) => {
      const k = locate(state, r, used);
      used.add(k);
      const found = state.has(k) ? state.get(k).slots : 0;
      if (found !== r.slots) issues.push({ name: r.name, set: r.set, treatment: r.treatment, expected: r.slots, found });
      return { r, k };
    });
    results.set(doc.date, { contents: toContents(state), issues });
    issueCount += issues.length;
    // …then undo them to get the state before it (= after the previous update)
    const before = new Map([...state].map(([k, v]) => [k, { ...v }]));
    for (const { r, k } of located) {
      const prev = r.slots - (r.change || 0);
      if (prev > 0) {
        const cur = before.get(k);
        before.set(k, cur ? { ...cur, slots: prev } : { name: r.name, set: String(r.set || '').toUpperCase(), treatment: r.treatment || '', slots: prev });
      } else before.delete(k);
    }
    state = before;
  }

  const now = new Date();
  const ops = [...results].map(([date, v]) => ({
    updateOne: {
      filter: { _id: date },
      update: { $set: { contents: v.contents, issues: v.issues, contentsSource: { snapshotId: snap._id, snapshotDate: snapDate, rebuiltAt: now } } },
    },
  }));
  if (ops.length) await coll.bulkWrite(ops, { ordered: false });
  await db.collection('meta').updateOne(
    { _id: 'tcHistoryRebuild' },
    { $set: { at: now, snapshotId: snap._id, snapshotDate: snapDate, anchor: docs[anchor].date, rebuilt: ops.length, issues: issueCount } },
    { upsert: true }
  );
  return { ok: true, anchor: docs[anchor].date, snapshotDate: snapDate, rebuilt: ops.length, issues: issueCount };
}

// --------------------------------------------------------------- reading

function classify(changes) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const r of changes || []) {
    const from = r.slots - (r.change || 0);
    const item = { ...r, from, to: r.slots };
    if (from <= 0 && r.slots > 0) added.push(item);
    else if (r.slots <= 0) removed.push(item);
    else changed.push(item);
  }
  return { added, removed, changed };
}

async function listUpdates(db) {
  const docs = await db
    .collection('tc_history')
    .aggregate([
      { $sort: { date: -1 } },
      {
        $project: {
          date: 1,
          tab: 1,
          source: 1,
          changes: 1,
          contentsCount: { $size: { $ifNull: ['$contents', []] } },
          totalSlots: { $sum: { $ifNull: ['$contents.slots', []] } },
          issuesCount: { $size: { $ifNull: ['$issues', []] } },
          excludedCount: { $size: { $ifNull: ['$excludedRows', []] } },
        },
      },
    ])
    .toArray();
  return docs.map((d) => {
    const c = classify(d.changes);
    return { ...d, changes: undefined, added: c.added.length, removed: c.removed.length, changed: c.changed.length };
  });
}

async function getUpdate(db, date) {
  const coll = db.collection('tc_history');
  const doc = await coll.findOne({ _id: date });
  if (!doc) return null;
  const [prev, next] = await Promise.all([
    coll.find({ date: { $lt: date } }, { projection: { date: 1 } }).sort({ date: -1 }).limit(1).next(),
    coll.find({ date: { $gt: date } }, { projection: { date: 1 } }).sort({ date: 1 }).limit(1).next(),
  ]);
  return { ...doc, ...classify(doc.changes), prevDate: prev && prev.date, nextDate: next && next.date };
}

/**
 * When a card was in the chest: periods per version (from the rebuilt contents) and
 * every CHANGELIST row that mentions it.
 */
async function cardPresence(db, name) {
  const key = keyPart(name);
  const docs = await db
    .collection('tc_history')
    .aggregate([
      { $sort: { date: 1 } },
      {
        $project: {
          date: 1,
          hasContents: { $gt: [{ $size: { $ifNull: ['$contents', []] } }, 0] },
          rows: { $filter: { input: { $ifNull: ['$contents', []] }, cond: { $eq: ['$$this.nameKey', key] } } },
          chg: { $filter: { input: { $ifNull: ['$changes', []] }, cond: { $eq: ['$$this.nameKey', key] } } },
        },
      },
    ])
    .toArray();

  const events = [];
  for (const d of docs) for (const r of d.chg) events.push({ date: d.date, set: r.set, treatment: r.treatment, from: r.slots - (r.change || 0), to: r.slots });

  const withContents = docs.filter((d) => d.hasContents);
  const open = new Map();
  const periods = [];
  for (const d of withContents) {
    const present = new Map(d.rows.map((r) => [`${r.set}|${keyPart(r.treatment)}`, r]));
    for (const [k, p] of open) {
      if (!present.has(k)) {
        p.to = d.date;
        periods.push(p);
        open.delete(k);
      }
    }
    for (const [k, r] of present) {
      const p = open.get(k);
      if (p) p.maxSlots = Math.max(p.maxSlots, r.slots);
      else open.set(k, { set: r.set, treatment: r.treatment, from: d.date, to: null, maxSlots: r.slots, updates: 0 });
      open.get(k).updates++;
    }
  }
  periods.push(...open.values());
  periods.sort((a, b) => b.from.localeCompare(a.from));
  return {
    periods,
    events: events.reverse(),
    rebuilt: withContents.length > 0,
    current: periods.filter((p) => !p.to),
    firstRecorded: docs.length ? docs[0].date : null,
  };
}

module.exports = {
  keyPart,
  versionKey,
  isProduct,
  prepareSheetUpdates,
  storeSheetUpdates,
  snapshotTotals,
  pageDate,
  rebuildContents,
  classify,
  listUpdates,
  getUpdate,
  cardPresence,
};
