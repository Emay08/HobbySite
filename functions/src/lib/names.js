/**
 * Name-only matching between scraped card names and your collection / watch lists,
 * plus auto-adding matches to the short-term watch list.
 */

function normalizeName(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // accents: Võx → Vox
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s*\/\/?\s*/g, ' // ') // Fire/Ice, Fire // Ice → "fire // ice"
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Front face of a split / double-faced name ("Delver of Secrets // Insectile Aberration" → "delver of secrets"). */
function frontFace(normalized) {
  const i = normalized.indexOf(' // ');
  return i === -1 ? normalized : normalized.slice(0, i);
}

/**
 * Index of everything you care about, keyed by normalized name:
 *   { name, owned: { qty, versions: [{ mtgoId, set, foil, qty, price }] }, watching: ['short'|'long'] }
 */
async function loadInterestIndex(db) {
  const [owned, watch] = await Promise.all([
    db.collection('collection').find({ mtgoId: { $nin: [null, '1'] } }, { projection: { name: 1, mtgoId: 1, set: 1, foil: 1, qty: 1 } }).toArray(),
    db.collection('watchlist').find({}, { projection: { name: 1, mtgoId: 1, set: 1, foil: 1, list: 1 } }).toArray(),
  ]);
  const ids = [...new Set([...owned, ...watch].map((c) => c.mtgoId).filter(Boolean))];
  const prices = new Map(
    (await db.collection('prices').find({ _id: { $in: ids } }, { projection: { price: 1 } }).toArray()).map((p) => [p._id, p.price])
  );

  const index = new Map();
  const entry = (name) => {
    const k = normalizeName(name);
    if (!index.has(k)) index.set(k, { name, owned: null, watching: [], watchIds: [] });
    return index.get(k);
  };
  for (const c of owned) {
    const e = entry(c.name);
    e.owned = e.owned || { qty: 0, versions: [] };
    e.owned.qty += c.qty || 0;
    e.owned.versions.push({ mtgoId: c.mtgoId, set: c.set, foil: !!c.foil, qty: c.qty, price: prices.get(c.mtgoId) ?? null });
  }
  for (const w of watch) {
    const e = entry(w.name);
    if (!e.watching.includes(w.list)) e.watching.push(w.list);
    e.watchIds.push({ mtgoId: w.mtgoId, set: w.set, foil: !!w.foil, price: prices.get(w.mtgoId) ?? null });
  }
  for (const e of index.values()) {
    if (e.owned) e.owned.versions.sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
  }
  // Also answer to the front face of multi-face names
  for (const [k, e] of [...index]) {
    const f = frontFace(k);
    if (f !== k && !index.has(f)) index.set(f, e);
  }
  return index;
}

function lookup(index, name) {
  const k = normalizeName(name);
  return index.get(k) || index.get(frontFace(k)) || null;
}

const tix = (n) => (n == null ? '—' : `${Number(n).toFixed(2)} tix`);

/** One Telegram line for a matched card, e.g. "Force of Will — own 4 · 18.40 tix (ALL), 12.10 tix (EMA)". */
function describeMatch(match, esc = (s) => s) {
  const parts = [];
  if (match.owned) {
    const v = match.owned.versions
      .slice(0, 3)
      .map((x) => `${tix(x.price)} (${esc(x.set || '?')}${x.foil ? ' ✦' : ''})`)
      .join(', ');
    parts.push(`own ${match.owned.qty} · ${v}${match.owned.versions.length > 3 ? ', …' : ''}`);
  }
  if (match.watching.length) {
    const w = match.watchIds[0];
    parts.push(`${match.owned ? '' : `${tix(w.price)} · `}on ${match.watching.join(' + ')}-term watch list`);
  }
  return `<b>${esc(match.name)}</b> — ${parts.join(' · ')}`;
}

/**
 * Adds each matched card to the short-term watch list unless a card with that name
 * is already there. Uses your most valuable owned version, else the watched version.
 * Returns the names that were added.
 */
async function addToShortWatch(db, matches, note) {
  const coll = db.collection('watchlist');
  const added = [];
  const seen = new Set();
  for (const m of matches) {
    const key = normalizeName(m.name);
    if (seen.has(key)) continue;
    seen.add(key);
    if (m.watching.includes('short')) continue;
    const v = (m.owned && m.owned.versions[0]) || m.watchIds[0];
    if (!v || !v.mtgoId) continue;
    const exists = await coll.findOne({ list: 'short', name: m.name });
    if (exists) continue;
    await coll.insertOne({
      list: 'short',
      mtgoId: v.mtgoId,
      name: m.name,
      set: v.set || '',
      foil: !!v.foil,
      rarity: '',
      note: String(note || '').slice(0, 200),
      alertPct: null,
      addedPrice: v.price ?? null,
      addedAt: new Date(),
      autoAdded: true,
    });
    if (v.price != null) {
      const date = new Date().toISOString().slice(0, 10);
      await db
        .collection('price_history')
        .updateOne({ _id: `${v.mtgoId}|${date}` }, { $setOnInsert: { mtgoId: v.mtgoId, date, price: v.price } }, { upsert: true });
    }
    added.push(m.name);
  }
  return added;
}

module.exports = { normalizeName, frontFace, loadInterestIndex, lookup, describeMatch, addToShortWatch, tix };
