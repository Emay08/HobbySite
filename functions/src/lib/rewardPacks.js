/**
 * Player Reward Pack contents (https://www.mtgo.com/player-rewards).
 *
 * The page has the same layout as the Treasure Chest page: a "Last Updated" line and a
 * "Card Name | Set | Treatment | Slots" table, so it's read with the same parser. Checked
 * every 6 hours (the contents change about once a month). When the table changes, the
 * added and removed cards are saved as a highlight and sent by Telegram (NOTIFY_REWARD_PACKS
 * = false turns the message off); added cards you own or watch are put on the short-term
 * watch list. Every version of the contents is kept in `prp_snapshots`.
 *
 * The first check only records the page.
 */
const crypto = require('crypto');
const { parseHTML } = require('linkedom');
const { parseTreasureChest, cardKey } = require('./tcParse');
const telegram = require('./telegram');
const names = require('./names');
const { recordFailure, successFields } = require('./health');

const URL = 'https://www.mtgo.com/player-rewards';
const STATE_ID = 'reward-packs';
const LABEL = 'Player Reward Packs';
const INTERVAL = 6 * 3600000;

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

async function fetchPage(url = URL) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (personal MTGO collection tracker)', Accept: 'text/html', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

/** All card rows on the page, slots summed per version (name + set + treatment). */
function parseRewards(html) {
  const { document } = parseHTML(html);
  const parsed = parseTreasureChest(document);
  const totals = new Map();
  for (const t of parsed.slots) {
    for (const c of t.cards) {
      const k = cardKey(c);
      const cur = totals.get(k);
      if (cur) cur.slots += c.slots || 0;
      else totals.set(k, { name: c.name, set: c.set, treatment: c.treatment, slots: c.slots || 0 });
    }
  }
  if (!totals.size) throw new Error('No card table found on the Player Rewards page — the layout may have changed');
  return { lastUpdatedText: parsed.lastUpdatedText, effectiveText: parsed.effectiveText, cards: [...totals.values()] };
}

function diff(before, after) {
  const b = new Map(before.map((c) => [cardKey(c), c]));
  const a = new Map(after.map((c) => [cardKey(c), c]));
  return {
    added: after.filter((c) => !b.has(cardKey(c))),
    removed: before.filter((c) => !a.has(cardKey(c))),
    changed: after.filter((c) => b.has(cardKey(c)) && b.get(cardKey(c)).slots !== c.slots).map((c) => ({ ...c, from: b.get(cardKey(c)).slots })),
  };
}

const version = (c) => `${c.set}${c.treatment ? ` ${c.treatment}` : ''}`;

async function runRewardPacks(db, { now = new Date(), force = false, fetcher = fetchPage, notify = true, log = () => {} } = {}) {
  const stateColl = db.collection('monitor_state');
  const state = (await stateColl.findOne({ _id: STATE_ID })) || {};
  if (!force && state.lastAttempt && now - new Date(state.lastAttempt) < INTERVAL) return { skipped: 'checked less than 6 hours ago' };
  if (notify) await stateColl.updateOne({ _id: STATE_ID }, { $set: { label: LABEL, url: URL, lastAttempt: now } }, { upsert: true });

  try {
    const page = parseRewards(await fetcher(URL));
    const snaps = db.collection('prp_snapshots');
    const prev = await snaps.find().sort({ takenAt: -1 }).limit(1).next();
    const sig = sha1(JSON.stringify(page.cards.map((c) => [cardKey(c), c.slots]).sort()));
    let result = { firstRun: !prev, changed: false, added: [], removed: [], notified: false, autoAdded: [] };

    if (!prev || prev.sig !== sig) {
      if (notify) await snaps.insertOne({ takenAt: now, sig, ...page });
      if (prev) {
        const d = diff(prev.cards, page.cards);
        const index = await names.loadInterestIndex(db);
        const mine = d.added.map((c) => ({ c, m: names.lookup(index, c.name) })).filter((x) => x.m);
        result = { ...result, changed: true, added: d.added, removed: d.removed };
        if (notify) {
          result.autoAdded = await names.addToShortWatch(db, mine.map((x) => x.m), 'Auto-added: in Player Reward Packs');
          const e = telegram.escapeHtml;
          const lines = [`🎁 <b>Player Reward Packs changed</b>${page.lastUpdatedText ? ` (Last Updated: ${e(page.lastUpdatedText)})` : ''}`];
          if (d.added.length) {
            lines.push('', `<b>Added (${d.added.length})</b>`);
            for (const c of d.added) {
              const m = mine.find((x) => x.c === c);
              lines.push(`• ${m ? names.describeMatch(m.m, e) : `<b>${e(c.name)}</b>`} — ${e(version(c))}${c.slots > 1 ? ` ×${c.slots}` : ''}`);
            }
          }
          if (d.removed.length) lines.push('', `<b>Removed (${d.removed.length})</b>`, ...d.removed.map((c) => `• ${e(c.name)} — ${e(version(c))}`));
          if (d.changed.length) lines.push('', `<b>Slots changed</b>`, ...d.changed.map((c) => `• ${e(c.name)} — ${e(version(c))}: ${c.from} → ${c.slots}`));
          if (result.autoAdded.length) lines.push('', `<i>Added to your short-term watch list: ${result.autoAdded.length}</i>`);
          lines.push('', URL);
          if (process.env.NOTIFY_REWARD_PACKS !== 'false') {
            try {
              const sent = await telegram.sendLong(lines.join('\n'));
              result.notified = !(sent[0] && sent[0].skipped);
            } catch (err) {
              log(`Telegram failed: ${err.message}`);
            }
          }
          await db.collection('highlights').insertOne({
            _id: sha1(`${STATE_ID}|${sig}`),
            source: LABEL,
            monitorId: STATE_ID,
            title: `Player Reward Packs changed: ${d.added.length} added, ${d.removed.length} removed`,
            url: URL,
            category: 'reward-pack',
            summary: [
              d.added.length ? `Added: ${d.added.map((c) => `${c.name} (${version(c)})`).join(', ')}` : '',
              d.removed.length ? `Removed: ${d.removed.map((c) => c.name).join(', ')}` : '',
              mine.length ? `Yours: ${mine.map((x) => x.c.name).join(', ')}` : '',
            ]
              .filter(Boolean)
              .join(' · ')
              .slice(0, 1500),
            detectedAt: now,
            notified: result.notified,
          });
        }
      }
    }
    log(`Player Reward Packs: ${page.cards.length} cards${result.firstRun ? ' (first check: recorded)' : result.changed ? ` — changed: +${result.added.length} −${result.removed.length}` : ', no change'}`);
    if (notify) {
      await stateColl.updateOne(
        { _id: STATE_ID },
        { $set: { label: LABEL, url: URL, lastChecked: now, cards: page.cards.length, lastUpdatedText: page.lastUpdatedText, ...successFields(now) } },
        { upsert: true }
      );
    }
    return { ...result, cards: page.cards.length };
  } catch (err) {
    if (notify) await recordFailure(db, STATE_ID, LABEL, err, { now, afterMs: 24 * 3600000 });
    throw err;
  }
}

module.exports = { runRewardPacks, parseRewards, diff, URL, STATE_ID };
