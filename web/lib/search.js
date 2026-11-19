/**
 * Card-name autocomplete for the nav bar.
 *
 * All names are held in memory (≈30k unique MTGO card names), each tagged with the
 * best tier it belongs to:
 *   0 short-term watch list · 1 long-term watch list · 2 your collection · 3 everything else
 * A query is a linear scan with cheap string tests, a few milliseconds per keystroke.
 * The index is rebuilt in the background when it's older than 10 minutes, or right
 * away after the watch lists / collection change (invalidate()).
 */
const { getDb } = require('./db');

const TTL_MS = 10 * 60 * 1000;
const TIER_LABELS = ['short', 'long', 'owned', ''];

let index = null; // { builtAt, entries: [{ name, norm, words, tier }] }
let building = null;
let dirty = false;

const norm = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

async function build() {
  const db = getDb();
  const [all, owned, watch] = await Promise.all([
    db.collection('cards').distinct('name'),
    db.collection('collection').distinct('name', { mtgoId: { $ne: '1' } }),
    db.collection('watchlist').find({}, { projection: { name: 1, list: 1 } }).toArray(),
  ]);
  const tiers = new Map();
  const put = (name, tier) => {
    if (!name) return;
    const k = norm(name);
    const cur = tiers.get(k);
    if (!cur || tier < cur.tier) tiers.set(k, { name: cur ? cur.name : name, tier });
  };
  for (const w of watch) put(w.name, w.list === 'short' ? 0 : 1);
  for (const n of owned) put(n, 2);
  for (const n of all) put(n, 3);
  const entries = [...tiers.entries()].map(([k, v]) => ({ name: v.name, norm: k, words: k.split(/[\s,/-]+/), tier: v.tier }));
  entries.sort((a, b) => a.tier - b.tier || a.norm.length - b.norm.length || a.norm.localeCompare(b.norm));
  index = { builtAt: Date.now(), entries };
  dirty = false;
  return index;
}

async function getIndex() {
  const stale = !index || dirty || Date.now() - index.builtAt > TTL_MS;
  if (stale && !building) {
    building = build().finally(() => (building = null));
  }
  // Wait for the rebuild when there's no index yet or your lists just changed (so a card
  // you just added ranks correctly); a merely old index is refreshed in the background.
  if (building && (!index || dirty)) await building;
  return index;
}

function invalidate() {
  dirty = true;
}

/**
 * Best matches for `q`. Ranking: tier first (watch lists, then collection, then all),
 * then how well it matches (exact, starts with, a word starts with, contains anywhere,
 * all typed words found), then shorter names.
 */
function rank(entries, q, limit = 10) {
  const nq = norm(q);
  if (nq.length < 2) return [];
  const qWords = nq.split(/[\s,/-]+/).filter(Boolean);
  const hits = [];
  for (const e of entries) {
    let quality;
    if (e.norm === nq) quality = 0;
    else if (e.norm.startsWith(nq)) quality = 1;
    else if (e.words.some((w) => w.startsWith(nq))) quality = 2;
    else if (e.norm.includes(nq)) quality = 3;
    else if (qWords.length > 1 && qWords.every((w) => e.words.some((x) => x.startsWith(w)))) quality = 4;
    else continue;
    hits.push({ e, score: e.tier * 10 + quality });
  }
  hits.sort((a, b) => a.score - b.score || a.e.norm.length - b.e.norm.length || a.e.norm.localeCompare(b.e.norm));
  return hits.slice(0, limit).map(({ e }) => ({ name: e.name, tier: e.tier, label: TIER_LABELS[e.tier] }));
}

async function suggest(q, limit = 10) {
  const idx = await getIndex();
  return rank(idx.entries, q, limit);
}

module.exports = { suggest, rank, invalidate, getIndex, norm };
