/**
 * Per-version card details from Scryfall, looked up by MTGO ID: image URLs, collector
 * number, and a short label telling look-alike versions apart ("Borderless · Showcase",
 * "Extended art", "Regular").
 *
 * One POST to /cards/collection per 75 IDs (Scryfall matches foil MTGO IDs too). Results
 * are cached in `scryfall_cards` for 30 days; IDs Scryfall doesn't know for 7 days.
 * Lookups fail soft: a page still renders without labels/images if Scryfall is slow or down.
 */
const API = 'https://api.scryfall.com/cards/collection';
const TTL = 30 * 86400000;
const MISS_TTL = 7 * 86400000;
const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'VaultMTGOManager/1.0 (personal collection site)' };

const FRAME_EFFECTS = {
  showcase: 'Showcase',
  extendedart: 'Extended art',
  etched: 'Etched',
  inverted: 'Inverted',
  shatteredglass: 'Shattered glass',
  fullart: 'Full art',
};
const PROMO_TYPES = {
  boosterfun: null, // too common to be useful
  textured: 'Textured',
  galaxyfoil: 'Galaxy foil',
  surgefoil: 'Surge foil',
  serialized: 'Serialized',
  doublerainbow: 'Double rainbow',
  halofoil: 'Halo foil',
  confettifoil: 'Confetti foil',
  neonink: 'Neon ink',
  stepandcompleat: 'Step-and-compleat foil',
  oilslick: 'Oil slick',
  japanshowcase: 'Japanese showcase',
  prerelease: 'Prerelease',
  promopack: 'Promo pack',
};

/** "Borderless · Showcase", "Retro frame", "Regular"… */
function variantLabel(c) {
  const parts = [];
  if (c.border_color === 'borderless') parts.push('Borderless');
  for (const fe of c.frame_effects || []) if (FRAME_EFFECTS[fe] && !parts.includes(FRAME_EFFECTS[fe])) parts.push(FRAME_EFFECTS[fe]);
  if (c.full_art && !parts.includes('Full art') && c.type_line && !/Basic Land/.test(c.type_line)) parts.push('Full art');
  if (c.frame === '1993' || c.frame === '1997') parts.push('Retro frame');
  for (const p of c.promo_types || []) if (PROMO_TYPES[p]) parts.push(PROMO_TYPES[p]);
  if (c.lang && c.lang !== 'en') parts.push(c.lang.toUpperCase());
  return parts.length ? parts.join(' · ') : 'Regular';
}

function imagesOf(c) {
  const iu = c.image_uris || (c.card_faces && c.card_faces[0] && c.card_faces[0].image_uris) || {};
  return { small: iu.small || null, normal: iu.normal || null, large: iu.large || iu.normal || null };
}

const toInfo = (c) => ({
  label: variantLabel(c),
  collector: c.collector_number || '',
  setName: c.set_name || '',
  img: imagesOf(c),
});

/** Image straight from Scryfall by MTGO ID (a redirect), for versions without cached details. */
const fallbackImage = (mtgoId, version = 'normal') => `https://api.scryfall.com/cards/mtgo/${encodeURIComponent(mtgoId)}?format=image&version=${version}`;

/** Maps Scryfall cards back onto the MTGO IDs asked for (regular or foil). */
function mapResults(ids, data) {
  const want = new Set(ids.map(String));
  const out = new Map();
  for (const c of (data && data.data) || []) {
    for (const id of [c.mtgo_id, c.mtgo_foil_id]) {
      if (id != null && want.has(String(id)) && !out.has(String(id))) out.set(String(id), toInfo(c));
    }
  }
  return out;
}

/**
 * Map(mtgoId → { label, collector, setName, img: { small, normal, large } }) for the IDs
 * Scryfall knows. Never throws.
 */
async function versionInfo(db, ids, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const unique = [...new Set(ids.map(String).filter((id) => /^\d+$/.test(id)))];
  const result = new Map();
  if (!unique.length) return result;
  const coll = db.collection('scryfall_cards');
  const now = Date.now();
  try {
    const cached = await coll.find({ _id: { $in: unique } }).toArray();
    const fresh = new Set();
    for (const d of cached) {
      const age = now - new Date(d.fetchedAt).getTime();
      if (d.missing ? age < MISS_TTL : age < TTL) {
        fresh.add(d._id);
        if (!d.missing) result.set(d._id, d.info);
      }
    }
    // SCRYFALL_DISABLED=1 (tests): cached details only, no requests
    const todo = process.env.SCRYFALL_DISABLED === '1' ? [] : unique.filter((id) => !fresh.has(id));
    for (let i = 0; i < todo.length; i += 75) {
      const batch = todo.slice(i, i + 75);
      const res = await fetchImpl(API, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ identifiers: batch.map((id) => ({ mtgo_id: Number(id) })) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) break; // try again next time
      const found = mapResults(batch, await res.json());
      const at = new Date();
      await coll.bulkWrite(
        batch.map((id) => ({
          replaceOne: {
            filter: { _id: id },
            replacement: found.has(id) ? { _id: id, info: found.get(id), fetchedAt: at } : { _id: id, missing: true, fetchedAt: at },
            upsert: true,
          },
        })),
        { ordered: false }
      );
      for (const [id, info] of found) result.set(id, info);
    }
  } catch (err) {
    console.warn('Scryfall lookup failed:', err.message);
  }
  return result;
}

module.exports = { versionInfo, variantLabel, mapResults, fallbackImage };
