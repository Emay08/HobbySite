/**
 * Reprint watch, using Scryfall's search API (MagicSpoiler blocks Azure behind Cloudflare).
 *
 * Hourly between 8 am and 8 pm Pacific, asks Scryfall for every reprint printing (paper or
 * MTGO) in sets released from two weeks ago onward — Scryfall adds preview cards as they're
 * revealed, with the set's future release date, so upcoming reprints show up here. Each
 * printing is remembered (`reprint_seen`); a printing not seen before whose name is in your
 * collection or on a watch list is sent in one Telegram message, saved as a highlight and
 * added to the short-term watch list.
 *
 * The first run only records what's already there (highlights, no Telegram, no watch-list
 * additions), so it doesn't flood you with every current reprint at once.
 */
const crypto = require('crypto');
const telegram = require('./telegram');
const names = require('./names');
const { recordFailure, successFields } = require('./health');

const STATE_ID = 'reprints';
const LABEL = 'Reprint watch (Scryfall)';
const PT = 'America/Los_Angeles';
const SEARCH = 'https://api.scryfall.com/cards/search';
const HEADERS = { Accept: 'application/json', 'User-Agent': 'VaultMTGOManager/1.0 (personal collection site)' };

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function inActiveHours(now = new Date(), spec = process.env.SPOILER_HOURS || '8-20', tz = process.env.SPOILER_TZ || PT) {
  const [from, to] = String(spec).split('-').map(Number);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now));
  return hour >= from && hour <= to;
}

const query = (since) => `is:reprint (game:paper or game:mtgo) date>=${since}`;
const searchUrl = (since) => `${SEARCH}?${new URLSearchParams({ q: query(since), unique: 'prints', order: 'spoiled', dir: 'desc' })}`;

/** Scryfall answers 404 with an error object when nothing matches. */
async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
  if (res.status === 404) return { data: [], has_more: false };
  if (!res.ok) throw new Error(`Scryfall: HTTP ${res.status} for ${url}`);
  return res.json();
}

async function runReprints(
  db,
  { now = new Date(), force = false, fetcher = fetchJson, notify = true, delayMs = 150, lookbackDays = 14, maxPages = 40, log = () => {} } = {}
) {
  const stateColl = db.collection('monitor_state');
  const state = (await stateColl.findOne({ _id: STATE_ID })) || {};
  if (!force) {
    if (!inActiveHours(now)) return { skipped: 'outside active hours' };
    if (state.lastAttempt && now - new Date(state.lastAttempt) < 50 * 60000) return { skipped: 'ran less than an hour ago' };
  }
  const since = new Date(now.getTime() - lookbackDays * 86400000).toISOString().slice(0, 10);
  const firstUrl = searchUrl(since);
  const browseUrl = `https://scryfall.com/search?${new URLSearchParams({ q: query(since), unique: 'prints', order: 'spoiled' })}`;
  if (notify) {
    await stateColl.updateOne({ _id: STATE_ID }, { $set: { label: LABEL, url: browseUrl, lastAttempt: now } }, { upsert: true });
    // the MagicSpoiler watcher this replaces
    await stateColl.deleteOne({ _id: 'spoilers' });
  }

  try {
    const cards = [];
    let url = firstUrl;
    for (let page = 0; url && page < maxPages; page++) {
      if (page) await sleep(delayMs);
      const body = await fetcher(url);
      for (const c of body.data || []) {
        cards.push({
          id: c.id,
          name: c.name,
          set: String(c.set || '').toUpperCase(),
          setName: c.set_name || c.set || '',
          released: c.released_at || '',
          url: c.scryfall_uri || '',
        });
      }
      url = body.has_more ? body.next_page : null;
    }

    const seenColl = db.collection('reprint_seen');
    const seen = new Set();
    for (let i = 0; i < cards.length; i += 1000) {
      const ids = cards.slice(i, i + 1000).map((c) => c.id);
      for (const d of await seenColl.find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray()) seen.add(d._id);
    }
    const fresh = cards.filter((c) => !seen.has(c.id));
    const firstRun = !state.lastChecked;

    const index = await names.loadInterestIndex(db);
    const found = [];
    const foundNames = new Set();
    for (const c of fresh) {
      const m = names.lookup(index, c.name);
      if (!m) continue;
      const k = `${c.setName}|${names.normalizeName(m.name)}`;
      if (foundNames.has(k)) continue; // several printings of the card in one set: one line
      foundNames.add(k);
      found.push({ card: c, match: m });
    }
    log(`Scryfall: ${cards.length} reprint printings since ${since}, ${fresh.length} new, ${found.length} of your cards${firstRun ? ' (first run: no Telegram)' : ''}`);

    let autoAdded = [];
    let notified = false;
    if (found.length && notify) {
      const bySet = new Map();
      for (const f of found) {
        const key = `${f.card.setName}|${f.card.set}`;
        if (!bySet.has(key)) bySet.set(key, []);
        bySet.get(key).push(f);
      }
      if (!firstRun) {
        for (const items of bySet.values()) {
          autoAdded.push(...(await names.addToShortWatch(db, items.map((i) => i.match), `Auto-added: reprint in ${items[0].card.setName}`)));
        }
        const e = telegram.escapeHtml;
        const lines = ['♻️ <b>Reprints of cards you own or watch</b>'];
        for (const items of bySet.values()) {
          const c = items[0].card;
          lines.push('', `<b>${e(c.setName)}</b> (${e(c.set)}${c.released ? `, ${e(c.released)}` : ''}) — https://scryfall.com/sets/${e(c.set.toLowerCase())}`);
          for (const i of items) lines.push(`• ${names.describeMatch(i.match, e)}`);
        }
        if (autoAdded.length) lines.push('', `<i>Added to your short-term watch list: ${autoAdded.length}</i>`);
        try {
          const sent = await telegram.sendLong(lines.join('\n'));
          notified = !(sent[0] && sent[0].skipped);
        } catch (err) {
          log(`Telegram failed: ${err.message}`);
        }
      }
      for (const f of found) {
        await db.collection('highlights').updateOne(
          { _id: sha1(`${STATE_ID}|${f.card.set}|${names.normalizeName(f.match.name)}`) },
          {
            $setOnInsert: {
              source: 'Scryfall',
              monitorId: STATE_ID,
              title: `${f.match.name} reprinted in ${f.card.setName}`,
              url: f.card.url || `https://scryfall.com/sets/${f.card.set.toLowerCase()}`,
              category: 'reprint',
              summary: `${f.card.set}${f.card.released ? ` · releases ${f.card.released}` : ''} · ${names.describeMatch(f.match).replace(/<[^>]+>/g, '')}`,
              detectedAt: now,
              notified,
            },
          },
          { upsert: true }
        );
      }
    }

    if (notify) {
      if (fresh.length) {
        await seenColl.bulkWrite(
          fresh.map((c) => ({ updateOne: { filter: { _id: c.id }, update: { $setOnInsert: { name: c.name, set: c.set, seenAt: now } }, upsert: true } })),
          { ordered: false }
        );
      }
      await stateColl.updateOne(
        { _id: STATE_ID },
        { $set: { label: LABEL, url: browseUrl, lastChecked: now, printings: cards.length, ...successFields(now) } },
        { upsert: true }
      );
    }
    return { printings: cards.length, fresh: fresh.length, found: found.map((f) => ({ set: f.card.setName, card: f.match.name })), autoAdded, notified, firstRun };
  } catch (err) {
    if (notify) await recordFailure(db, STATE_ID, LABEL, err, { now, afterMs: 6 * 3600000 });
    throw err;
  }
}

module.exports = { runReprints, inActiveHours, searchUrl, query, STATE_ID };
