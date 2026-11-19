/**
 * Turns hand-typed card names ("dockside", "temporal manip", "undergound sea",
 * "mantle ancients") into real MTGO card names.
 *
 * Match quality, best first:
 *   0 exact (ignoring case, accents and punctuation)
 *   1 the full name starts with what was typed
 *   2 every typed word starts a word of the name, in order, starting at the first word
 *   3 every typed word starts a word of the name, in order
 *   4 one or two typos (edit distance) from the full name
 * Ties are broken by preference: cards you've traded, watch lists, your collection, the rest.
 */
const { norm } = require('./search');

const simp = (s) =>
  norm(s)
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function makeEntries(sources) {
  // sources: [{ name, tier }] — lower tier = preferred
  const best = new Map();
  for (const { name, tier } of sources) {
    if (!name) continue;
    const s = simp(name);
    if (!s) continue;
    const cur = best.get(s);
    if (!cur || tier < cur.tier) {
      const alt = s.startsWith('the ') ? s.slice(4) : null; // "meathook massacre" → The Meathook Massacre
      best.set(s, { name: cur ? cur.name : name, s, words: s.split(' '), alt, altWords: alt && alt.split(' '), tier });
    }
  }
  return [...best.values()];
}

function wordsInOrder(qWords, words) {
  let j = 0;
  for (const w of qWords) {
    while (j < words.length && !words[j].startsWith(w)) j++;
    if (j === words.length) return false;
    j++;
  }
  return true;
}

function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Returns { status: 'ok' | 'check' | 'none', name, candidates: [{ name, quality, tier }] }
 *   ok    – one clear best match
 *   check – a best guess, but other cards match about as well
 *   none  – nothing found
 */
function resolve(entries, text) {
  const q = simp(text);
  if (!q) return { status: 'none', name: null, candidates: [] };
  const qWords = q.split(' ');
  const hits = [];
  const maxTypos = q.length >= 12 ? 2 : q.length >= 6 ? 1 : 0;
  const quality = (str, words) => {
    if (str === q) return 0;
    if (str.startsWith(q) && (str.length === q.length || str[q.length] === ' ' || qWords.length > 1 || q.length >= 4)) return 1;
    if (words[0].startsWith(qWords[0]) && wordsInOrder(qWords, words)) return 2;
    if (qWords.length > 1 && wordsInOrder(qWords, words)) return 3;
    if (maxTypos && lev(q, str, maxTypos) <= maxTypos) return 4;
    return null;
  };
  for (const e of entries) {
    let best = quality(e.s, e.words);
    if (e.alt && best !== 0) {
      const a = quality(e.alt, e.altWords);
      if (a !== null && (best === null || a < best)) best = a;
    }
    if (best !== null) hits.push({ e, quality: best });
  }
  if (!hits.length) return { status: 'none', name: null, candidates: [] };
  hits.sort(
    (a, b) =>
      a.quality - b.quality ||
      a.e.tier - b.e.tier ||
      a.e.words.length - b.e.words.length ||
      a.e.s.length - b.e.s.length ||
      a.e.s.localeCompare(b.e.s)
  );
  const [top, second] = hits;
  const clear =
    top.quality === 0 ||
    !second ||
    second.quality > top.quality ||
    (second.e.tier > top.e.tier && top.e.tier <= 2); // a card you've traded, watch or own beats a namesake you don't
  return {
    status: clear ? 'ok' : 'check',
    name: top.e.name,
    quality: top.quality,
    candidates: hits.slice(0, 6).map((h) => ({ name: h.e.name, quality: h.quality, tier: h.e.tier })),
  };
}

module.exports = { simp, makeEntries, resolve, lev, wordsInOrder };
