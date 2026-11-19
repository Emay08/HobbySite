const crypto = require('crypto');
const { parseHTML } = require('linkedom');
const { discoverPages, extractCards, findMentions } = require('./spoilerParse');
const { zonedParts, PT } = require('./time');
const names = require('./names');
const telegram = require('./telegram');
const { recordFailure, successFields } = require('./health');

const HOME = process.env.SPOILER_HOME_URL || 'https://www.magicspoiler.com/';
const STATE_ID = 'spoilers';
const LABEL = 'Reprint watch (MagicSpoiler)';
const MAX_PAGES_PER_SET = 25;

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Active hours in Pacific time, e.g. "8-20" = 8:00 to 20:59. */
function inActiveHours(now = new Date(), spec = process.env.SPOILER_HOURS || '8-20', tz = process.env.SPOILER_TZ || PT) {
  const [from, to] = spec.split('-').map((n) => parseInt(n, 10));
  const { hour } = zonedParts(now, tz);
  return hour >= from && hour <= to;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(25000),
  });
  const body = await res.text();
  if (res.status === 403 || res.status === 503 || /<title>Just a moment/i.test(body)) {
    throw new Error(`Blocked by Cloudflare (HTTP ${res.status}) at ${url}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return body;
}

/**
 * All card names on one nav page, following /page/N/ pagination. On news posts,
 * names of cards you own/watch that are mentioned in the text are included too
 * (some posts only show their cards as images).
 */
async function crawlPage(url, fetcher, delayMs, interestNames = []) {
  const all = new Map();
  let text = '';
  const queue = [url];
  const visited = new Set();
  while (queue.length && visited.size < MAX_PAGES_PER_SET) {
    const u = queue.shift();
    if (visited.has(u)) continue;
    visited.add(u);
    if (visited.size > 1 && delayMs) await sleep(delayMs);
    const { document } = parseHTML(await fetcher(u));
    const { cards, pages, text: pageText } = extractCards(document, url);
    if (visited.size === 1) text = pageText;
    for (const c of cards) if (!all.has(c.name.toLowerCase())) all.set(c.name.toLowerCase(), c);
    for (const p of pages) if (!visited.has(p)) queue.push(p);
  }
  if (/\/mtg-news\//.test(url)) {
    for (const name of findMentions(text, interestNames)) {
      if (!all.has(name.toLowerCase())) all.set(name.toLowerCase(), { name, url, mentioned: true });
    }
  }
  return [...all.values()];
}

/**
 * One run: discover the nav pages, find cards not seen before on each page, and
 * report the ones you own or watch. Options:
 *   force   – ignore active hours / hourly throttle
 *   fetcher – (url) => html, for tests
 *   notify  – false for dry runs (no Telegram, no auto-add, no state saved)
 */
async function runSpoilers(db, { now = new Date(), force = false, fetcher = fetchHtml, notify = true, delayMs = 1500, log = () => {} } = {}) {
  const stateColl = db.collection('monitor_state');
  const state = (await stateColl.findOne({ _id: STATE_ID })) || {};
  if (!force) {
    if (!inActiveHours(now)) return { skipped: 'outside active hours' };
    if (state.lastAttempt && now - new Date(state.lastAttempt) < 50 * 60000) return { skipped: 'ran less than an hour ago' };
  }
  if (notify) await stateColl.updateOne({ _id: STATE_ID }, { $set: { label: LABEL, url: HOME, lastAttempt: now } }, { upsert: true });

  try {
    const { document } = parseHTML(await fetcher(HOME));
    const pages = discoverPages(document, HOME);
    if (!pages.length) throw new Error('No set pages found in the navigation bar — the site layout may have changed');

    const pageColl = db.collection('spoiler_pages');
    const index = await names.loadInterestIndex(db);
    const interestNames = [...new Set([...index.values()].map((m) => m.name))];
    const found = []; // { page, card, match }
    const summary = [];

    for (const page of pages) {
      await sleep(delayMs);
      let cards;
      try {
        cards = await crawlPage(page.url, fetcher, delayMs, interestNames);
      } catch (err) {
        log(`  ${page.label}: ${err.message}`);
        summary.push({ page: page.label, error: err.message });
        if (/Cloudflare/.test(err.message)) throw err;
        continue;
      }
      const doc = (await pageColl.findOne({ _id: page.url })) || { seen: [] };
      const seen = new Set(doc.seen);
      const fresh = cards.filter((c) => !seen.has(sha1(c.name.toLowerCase())));
      for (const c of fresh) {
        const m = names.lookup(index, c.name);
        if (m) found.push({ page, card: c, match: m });
      }
      summary.push({ page: page.label, cards: cards.length, new: fresh.length });
      log(`  ${page.label}: ${cards.length} cards, ${fresh.length} new`);
      if (notify) {
        await pageColl.updateOne(
          { _id: page.url },
          {
            $set: { label: page.label, lastChecked: now, cardCount: cards.length, seen: [...new Set([...doc.seen, ...cards.map((c) => sha1(c.name.toLowerCase()))])] },
            $setOnInsert: { firstSeenAt: now },
          },
          { upsert: true }
        );
      }
    }

    let autoAdded = [];
    let notified = false;
    if (found.length && notify) {
      const bySet = new Map();
      for (const f of found) {
        if (!bySet.has(f.page.label)) bySet.set(f.page.label, []);
        bySet.get(f.page.label).push(f);
      }
      for (const [label, items] of bySet) {
        autoAdded.push(...(await names.addToShortWatch(db, items.map((i) => i.match), `Auto-added: reprint in ${label}`)));
      }
      const e = telegram.escapeHtml;
      const lines = ['♻️ <b>Reprints spotted of cards you own or watch</b>'];
      for (const [label, items] of bySet) {
        lines.push('', `<b>${e(label)}</b> — ${e(items[0].page.url)}`);
        for (const i of items) lines.push(`• ${names.describeMatch(i.match, e)}`);
      }
      if (autoAdded.length) lines.push('', `<i>Added to your short-term watch list: ${autoAdded.length}</i>`);
      try {
        const sent = await telegram.sendLong(lines.join('\n'));
        notified = !(sent[0] && sent[0].skipped);
      } catch (err) {
        log(`Telegram failed: ${err.message}`);
      }
      for (const f of found) {
        await db.collection('highlights').updateOne(
          { _id: sha1(`${STATE_ID}|${f.page.url}|${f.card.name.toLowerCase()}`) },
          {
            $setOnInsert: {
              source: 'MagicSpoiler',
              monitorId: STATE_ID,
              title: `${f.card.name} spotted in ${f.page.label}`,
              url: /^https?:/.test(f.card.url || '') ? f.card.url : f.page.url,
              category: 'reprint',
              summary: names.describeMatch(f.match).replace(/<[^>]+>/g, ''),
              detectedAt: now,
              notified,
            },
          },
          { upsert: true }
        );
      }
    }

    if (notify) {
      await stateColl.updateOne(
        { _id: STATE_ID },
        { $set: { label: LABEL, url: HOME, lastChecked: now, pages: summary, ...successFields(now) } },
        { upsert: true }
      );
    }
    return { pages: summary, found: found.map((f) => ({ page: f.page.label, card: f.card.name })), autoAdded, notified };
  } catch (err) {
    if (notify) await recordFailure(db, STATE_ID, LABEL, err, { now, afterMs: 6 * 3600000 });
    throw err;
  }
}

module.exports = { runSpoilers, inActiveHours, crawlPage, fetchHtml, HOME };
