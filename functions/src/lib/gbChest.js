/**
 * GoatBots' own view of the Treasure Chest (https://www.goatbots.com/card/treasure-chest-booster),
 * read once a day after the price sync. Its "Top 100 Curated Cards" list names each card's
 * exact variant ("Force of Will (Japanese)", set SOA), which the official page's Treatment
 * column doesn't always pin down. GoatBots usually updates it a day or two after a chest change.
 *
 * Only names, variants, sets and foil are read; GoatBots draws its prices as images on
 * purpose, and they aren't used. robots.txt allows /card/ pages (crawl delay 3 s; this is
 * one request a day).
 *
 * Stored in `gb_chest` (_id 'current'): { fetchedAt, changedAt, entries: [{ name, variant, set, foil }] }.
 */
const crypto = require('crypto');
const { parseHTML } = require('linkedom');

const URL = 'https://www.goatbots.com/card/treasure-chest-booster';

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function parseGbChest(html) {
  const { document } = parseHTML(html);
  const heading = [...document.querySelectorAll('h1, h2, h3')].find((h) => /top 100 curated/i.test(h.textContent));
  let list = null;
  for (let n = heading && heading.nextElementSibling; n && !list; n = n.nextElementSibling) {
    if (n.tagName === 'UL') list = n;
  }
  if (!list) list = document.querySelector('ul.price-list.curated');
  if (!list) throw new Error('GoatBots Treasure Chest page: "Top 100 Curated Cards" list not found');

  const entries = [];
  for (const li of list.querySelectorAll('li')) {
    if (li.classList.contains('header')) continue;
    const a = li.querySelector('a[href^="/card/"]');
    const nameEl = li.querySelector('.name');
    if (!a || !nameEl) continue;
    const foil = li.getAttribute('data-foil') === '1';
    let label = clean(nameEl.textContent);
    if (foil) label = label.replace(/^Foil\s+/, '');
    const m = label.match(/^(.*?)\s*\(([^()]+)\)$/);
    const name = m ? m[1] : label;
    const variant = m ? m[2] : '';
    const rarity = li.querySelector('.rarity');
    const hover = rarity ? rarity.getAttribute('data-hover') || '' : '';
    const icon = rarity && rarity.querySelector('use');
    const fromHover = (hover.match(/\(([A-Z0-9]{2,6})\)\s*$/) || [])[1];
    const fromIcon = icon ? ((icon.getAttribute('href') || '').match(/cardset-([a-z0-9]+)/i) || [])[1] : null;
    const set = String(fromHover || fromIcon || '').toUpperCase();
    const chance = clean((li.querySelector('.chance') || {}).textContent);
    entries.push({ name, variant, set, foil, chance, slug: a.getAttribute('href') });
  }
  if (!entries.length) throw new Error('GoatBots Treasure Chest page: the curated list was empty');
  return entries;
}

async function runGbChest(db, { fetchImpl = fetch, now = new Date(), log = console.log } = {}) {
  const res = await fetchImpl(URL, {
    headers: { 'User-Agent': 'personal MTGO collection tracker (one request a day)', Accept: 'text/html' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`GoatBots Treasure Chest page: HTTP ${res.status}`);
  const entries = parseGbChest(await res.text());
  const hash = crypto
    .createHash('sha1')
    .update(JSON.stringify(entries.map((e) => [e.name, e.variant, e.set, e.foil])))
    .digest('hex');
  const coll = db.collection('gb_chest');
  const prev = await coll.findOne({ _id: 'current' }, { projection: { hash: 1, changedAt: 1 } });
  const changed = !prev || prev.hash !== hash;
  await coll.updateOne(
    { _id: 'current' },
    { $set: { fetchedAt: now, entries, hash, ...(changed ? { changedAt: now } : {}) } },
    { upsert: true }
  );
  log(`GoatBots Treasure Chest list: ${entries.length} cards${changed ? ' (changed)' : ''}`);
  return { count: entries.length, changed };
}

module.exports = { runGbChest, parseGbChest, URL };
