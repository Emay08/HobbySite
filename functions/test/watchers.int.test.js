// End-to-end tests for the Treasure Chest and reprint watchers against a real MongoDB,
// with Telegram faked. Skipped unless TEST_MONGODB_URI is set.
const test = require('node:test');
const assert = require('node:assert');
const { MongoClient } = require('mongodb');
const { tcHtml } = require('./fixtures/tcPage');

const URI = process.env.TEST_MONGODB_URI;

function fakeTelegram() {
  const sent = [];
  const real = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.telegram.org')) {
      sent.push(JSON.parse(opts.body).text);
      return Response.json({ ok: true, result: {} });
    }
    throw new Error('unexpected fetch ' + url);
  };
  return { sent, restore: () => (global.fetch = real) };
}

async function seed(db) {
  await db.collection('collection').insertMany([
    { _id: '1001', mtgoId: '1001', name: 'Force of Will', set: 'ALL', qty: 4, foil: false },
    { _id: '1002', mtgoId: '1002', name: 'Force of Will', set: 'EMA', qty: 1, foil: false },
    { _id: '2001', mtgoId: '2001', name: 'Ancestral Recall', set: 'VMA', qty: 1, foil: false },
    { _id: '3001', mtgoId: '3001', name: 'Crucible of Worlds', set: '5DN', qty: 2, foil: false },
    { _id: '4001', mtgoId: '4001', name: 'Võx, Child of the Collective', set: 'TRC', qty: 1, foil: false },
  ]);
  await db.collection('prices').insertMany([
    { _id: '1001', price: 18.4 }, { _id: '1002', price: 12.1 }, { _id: '2001', price: 7.5 },
    { _id: '3001', price: 5.25 }, { _id: '5001', price: 0.9 }, { _id: '6001', price: 3.3 }, { _id: '4001', price: 0.2 },
  ]);
  await db.collection('watchlist').insertMany([
    { list: 'long', mtgoId: '5001', name: 'Lightning Bolt', set: 'M10', foil: false, addedAt: new Date() },
    { list: 'long', mtgoId: '6001', name: 'Return of the Wildspeaker', set: 'IKO', foil: false, addedAt: new Date() },
  ]);
}

test('Treasure Chest watcher end to end', { skip: !URI && 'TEST_MONGODB_URI not set' }, async () => {
  const client = await new MongoClient(URI).connect();
  const db = client.db('mtgo_tc_test');
  await db.dropDatabase();
  await seed(db);
  process.env.TELEGRAM_BOT_TOKEN = 'T';
  process.env.TELEGRAM_CHAT_ID = '1';
  const tg = fakeTelegram();
  const { runTreasureChest } = require('../src/lib/treasureChest');
  const t0 = new Date('2026-11-19T17:00:00Z');
  const at = (mins) => new Date(t0.getTime() + mins * 60000);

  const curatedNov = [['Mox Diamond', 'TPR', '', 1], ['Wasteland', 'TPR', '', 2]];
  const debut = [['Borg Cube', 'TRK', 'Extended Art', 1]];
  try {
    // 1. First check: baseline only, no message
    let r = await runTreasureChest(db, { now: t0, html: tcHtml({ slots: { 'CURATED SLOT': curatedNov, 'SET DEBUT SLOT': debut }, changelist: [['Mox Diamond', 'TPR', '', 1, 1], ['Wasteland', 'TPR', '', 2, 2]] }) });
    assert.strictEqual(r.firstRun, true);
    assert.strictEqual(tg.sent.length, 0);
    let state = await db.collection('monitor_state').findOne({ _id: 'treasure-chest' });
    assert.strictEqual(state.mode, 'daily'); // Dec 9 is more than 7 days away
    assert.strictEqual(state.nextUpdate.toISOString(), '2026-12-09T18:00:00.000Z');

    // 2. Not due again for a day
    r = await runTreasureChest(db, { now: at(1) });
    assert.strictEqual(r.skipped, true);

    // 3. December update, CHANGELIST correct. Force of Will (owned) and Lightning Bolt (watched) added.
    const curatedDec = [['Mox Diamond', 'TPR', '', 1], ['Force of Will', 'SOA', 'Japanese Mystical Archive', 1], ['Lightning Bolt', 'PRM', 'Retro Frame', 2]];
    const newSlot = [['Võx, Child of the Collective', 'TRC', 'Extended Art Commander', 1]];
    const decCL = [
      ['Force of Will', 'SOA', 'Japanese Mystical Archive', 1, 1],
      ['Lightning Bolt', 'PRM', 'Retro Frame', 2, 2],
      ['Wasteland', 'TPR', '', 0, -2],
      ['Borg Cube', 'TRK', 'Extended Art', 0, -1],
      ['Vox, Child of the Collective', 'TRC', 'Extended Art Commander', 1, 1],
    ];
    const decSlots = { 'CURATED SLOT': curatedDec, 'TRC SLOT': newSlot };
    r = await runTreasureChest(db, {
      now: at(60 * 24 * 20),
      force: true,
      html: tcHtml({ date: 'December 9', nextUpdate: 'January 13, 10 a.m.', lastUpdated: '12/8/2026 1 p.m. PT', slots: decSlots, changelist: decCL }),
    });
    // "Vox" vs "Võx" in the CHANGELIST: accents are ignored when matching
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(tg.sent.length, 1);
    let msg = tg.sent[0];
    assert.match(msg, /Treasure Chest page updated<\/b> — December 9/);
    assert.match(msg, /3 added · 2 removed · 0 odds changes/);
    assert.match(msg, /New slot table: TRC SLOT/);
    assert.match(msg, /Slot table gone: SET DEBUT SLOT/);
    assert.match(msg, /Next update: January 13, 10 a\.m\./);
    assert.match(msg, /✅ CHANGELIST matches the slot tables/);
    assert.doesNotMatch(msg, /odds \/ play point tables changed/);
    assert.match(msg, /<b>Force of Will<\/b> — own 5 · 18\.40 tix \(ALL\), 12\.10 tix \(EMA\)/);
    assert.match(msg, /<b>Lightning Bolt<\/b> — 0\.90 tix · on long-term watch list/);
    assert.match(msg, /<b>Võx, Child of the Collective<\/b> — own 1/);
    assert.match(msg, /Added to your short-term watch list: 3/);
    const short = await db.collection('watchlist').find({ list: 'short' }).sort({ name: 1 }).toArray();
    assert.deepStrictEqual(short.map((s) => [s.name, s.mtgoId, s.note]), [
      ['Force of Will', '1001', 'Auto-added: Treasure Chest December 9'],
      ['Lightning Bolt', '5001', 'Auto-added: Treasure Chest December 9'],
      ['Võx, Child of the Collective', '4001', 'Auto-added: Treasure Chest December 9'],
    ]);
    state = await db.collection('monitor_state').findOne({ _id: 'treasure-chest' });
    assert.strictEqual(state.lastStatus, 'ok');

    // 4. Same page again → nothing new
    r = await runTreasureChest(db, { now: at(60 * 24 * 20 + 1), force: true, html: tcHtml({ date: 'December 9', nextUpdate: 'January 13, 10 a.m.', lastUpdated: '12/8/2026 1 p.m. PT', slots: decSlots, changelist: decCL }) });
    assert.strictEqual(r.changed, false);
    assert.strictEqual(tg.sent.length, 1);

    // 5. MTGO fixes the typo: still checked against November, so it still matches
    const fixedCL = decCL.map((row) => (row[0] === 'Vox, Child of the Collective' ? ['Võx, Child of the Collective', ...row.slice(1)] : row));
    r = await runTreasureChest(db, { now: at(60 * 24 * 20 + 2), force: true, html: tcHtml({ date: 'December 9', nextUpdate: 'January 13, 10 a.m.', lastUpdated: '12/8/2026 1 p.m. PT', slots: decSlots, changelist: fixedCL }) });
    assert.strictEqual(r.status, 'ok');
    assert.match(tg.sent[1], /CHANGELIST was edited; it still matches/);
    assert.doesNotMatch(tg.sent[1], /Added cards you own/);

    // 6. January: slots change but the CHANGELIST is left as December's
    const janSlots = { 'CURATED SLOT': [...curatedDec, ['Ancestral Recall', 'VMA', '', 1]], 'TRC SLOT': newSlot };
    r = await runTreasureChest(db, { now: at(60 * 24 * 55), force: true, html: tcHtml({ date: 'January 13', nextUpdate: 'February 10, 10 a.m.', lastUpdated: '1/12/2027 1 p.m. PT', slots: janSlots, changelist: fixedCL }) });
    assert.strictEqual(r.status, 'stale');
    msg = tg.sent[2];
    assert.match(msg, /The CHANGELIST was not updated/);
    assert.match(msg, /<b>Ancestral Recall<\/b> — own 1 · 7\.50 tix \(VMA\)/);
    assert.match(msg, /Added to your short-term watch list: 1/);

    // 7. …then the CHANGELIST catches up (checked against December, not against step 6)
    r = await runTreasureChest(db, { now: at(60 * 24 * 55 + 30), force: true, html: tcHtml({ date: 'January 13', nextUpdate: 'February 10, 10 a.m.', lastUpdated: '1/12/2027 1 p.m. PT', slots: janSlots, changelist: [['Ancestral Recall', 'VMA', '', 1, 1]] }) });
    assert.strictEqual(r.status, 'ok');
    assert.match(tg.sent[3], /CHANGELIST has now been updated and matches/);

    // 8. February: CHANGELIST gets the wrong number for a card, and lists one that didn't change
    const febSlots = { 'CURATED SLOT': [['Force of Will', 'SOA', 'Japanese Mystical Archive', 1], ['Lightning Bolt', 'PRM', 'Retro Frame', 2], ['Ancestral Recall', 'VMA', '', 1]], 'TRC SLOT': newSlot };
    r = await runTreasureChest(db, { now: at(60 * 24 * 85), force: true, html: tcHtml({ date: 'February 10', nextUpdate: 'March 10, 10 a.m.', lastUpdated: '2/9/2027 1 p.m. PT', slots: febSlots, changelist: [['Mox Diamond', 'TPR', '', 0, -2], ['Sol Ring', 'C21', '', 0, -1]] }) });
    assert.strictEqual(r.status, 'mismatch');
    assert.match(tg.sent[4], /Mox Diamond \(TPR\): listed -2, actually -1/);
    assert.match(tg.sent[4], /Sol Ring \(C21\): listed \(-1\) but the slot tables didn't change/);
    assert.strictEqual(tg.sent.length, 5);

    const highlights = await db.collection('highlights').find({ category: 'treasure-chest' }).toArray();
    assert.strictEqual(highlights.length, 6);

    // every update is recorded in tc_history (same documents the website's history pages use)
    const hist = await db.collection('tc_history').find().sort({ date: 1 }).toArray();
    assert.deepStrictEqual(hist.map((h) => h.date), ['2026-12-08', '2027-01-12', '2027-02-09']);
    assert.ok(hist[0].contents.some((c) => c.name === 'Võx, Child of the Collective' && c.slots === 1));
    assert.ok(hist[1].changes.some((c) => c.name === 'Ancestral Recall' && c.change === 1));
    assert.ok(hist[2].changes.some((c) => c.name === 'Mox Diamond' && c.slots === 0));
    assert.ok(hist.every((h) => h.source === 'watcher'));

    // daily prices for every printing of every chest card
    const { recordChestPrices, chestCardIds } = require('../src/lib/chestPrices');
    const ids = await chestCardIds(db);
    assert.ok(ids.has('1001')); // Force of Will (owned / chest)
    const n = await recordChestPrices(db, new Map([['1001', 18.4], ['999999', 1]]), { date: '2027-02-10' });
    assert.strictEqual(n, 1);
    assert.deepStrictEqual((await db.collection('price_daily').findOne({ _id: '2027-02-10' })).prices, { 1001: 18.4 });
  } finally {
    tg.restore();
    await db.dropDatabase();
    await client.close();
  }
});

test('reprint watcher (Scryfall) end to end', { skip: !URI && 'TEST_MONGODB_URI not set' }, async () => {
  const client = await new MongoClient(URI).connect();
  const db = client.db('mtgo_reprint_test');
  await db.dropDatabase();
  await seed(db);
  const tg = fakeTelegram();
  const { runReprints, inActiveHours, searchUrl } = require('../src/lib/reprints');
  const card = (id, name, set, setName) => ({ id, name, set, set_name: setName, released_at: '2026-12-05', scryfall_uri: `https://scryfall.com/card/${set}/${id}` });

  let pages;
  const urls = [];
  const fetcher = async (url) => {
    urls.push(url);
    const i = url.includes('page=2') ? 1 : 0;
    return pages[i];
  };
  const now = new Date('2026-11-20T18:00:00Z');
  pages = [
    { data: [card('a1', 'Crucible of Worlds', 'nau', 'Nauctis'), card('a2', 'Shock', 'nau', 'Nauctis')], has_more: true, next_page: 'https://api.scryfall.com/cards/search?page=2' },
    { data: [card('b1', 'Lightning Bolt', 'sld', 'Secret Lair Drop'), card('b2', 'Lightning Bolt', 'sld', 'Secret Lair Drop')], has_more: false },
  ];

  try {
    // First run: records everything, highlights only
    let r = await runReprints(db, { now, force: true, fetcher, delayMs: 0 });
    assert.strictEqual(r.firstRun, true);
    assert.strictEqual(r.printings, 4);
    assert.deepStrictEqual(r.found.map((f) => f.card).sort(), ['Crucible of Worlds', 'Lightning Bolt']); // two Bolt printings → one entry
    assert.strictEqual(tg.sent.length, 0);
    assert.strictEqual(await db.collection('watchlist').countDocuments({ list: 'short' }), 0);
    assert.strictEqual(await db.collection('highlights').countDocuments({ category: 'reprint', source: 'Scryfall' }), 2);
    assert.match(urls[0], /is%3Areprint.*date%3E%3D2026-11-06/);
    assert.match(searchUrl('2026-11-06'), /order=spoiled/);

    // Nothing new → nothing sent
    urls.length = 0;
    r = await runReprints(db, { now, force: true, fetcher, delayMs: 0 });
    assert.deepStrictEqual([r.fresh, r.found.length], [0, 0]);

    // A newly previewed reprint of an owned card
    pages = [{ data: [card('c1', 'Force of Will', 'nau', 'Nauctis'), card('a1', 'Crucible of Worlds', 'nau', 'Nauctis')], has_more: false }];
    r = await runReprints(db, { now, force: true, fetcher, delayMs: 0 });
    assert.deepStrictEqual(r.found, [{ set: 'Nauctis', card: 'Force of Will' }]);
    assert.strictEqual(tg.sent.length, 1);
    assert.match(tg.sent[0], /Reprints of cards you own or watch/);
    assert.match(tg.sent[0], /<b>Nauctis<\/b> \(NAU, 2026-12-05\)[\s\S]*<b>Force of Will<\/b> — own 5/);
    assert.ok(await db.collection('watchlist').findOne({ list: 'short', name: 'Force of Will', note: 'Auto-added: reprint in Nauctis' }));

    // Scryfall answers 404 when nothing matches
    pages = [{ data: [], has_more: false }];
    r = await runReprints(db, { now, force: true, fetcher, delayMs: 0 });
    assert.strictEqual(r.printings, 0);

    // Throttle + active hours
    r = await runReprints(db, { now: new Date('2026-11-20T18:20:00Z'), fetcher, delayMs: 0 });
    assert.ok(r.skipped);
    assert.strictEqual(inActiveHours(new Date('2026-11-19T15:30:00Z')), false); // 7:30 PST
    assert.strictEqual(inActiveHours(new Date('2026-11-19T16:05:00Z')), true); // 8:05
    assert.strictEqual(inActiveHours(new Date('2026-11-20T05:05:00Z')), false); // 21:05
    const st = await db.collection('monitor_state').findOne({ _id: 'reprints' });
    assert.strictEqual(st.lastError, null);
  } finally {
    tg.restore();
    await db.dropDatabase();
    await client.close();
  }
});

test('Player Reward Pack watcher end to end', { skip: !URI && 'TEST_MONGODB_URI not set' }, async () => {
  const client = await new MongoClient(URI).connect();
  const db = client.db('mtgo_prp_test');
  await db.dropDatabase();
  await seed(db);
  const tg = fakeTelegram();
  const { runRewardPacks } = require('../src/lib/rewardPacks');
  const { prpHtml } = require('./fixtures/prpPage');
  let html = prpHtml([['Refute Destiny', 'FRA', 'FOIL Braintwister', '1'], ['Shock', 'M21', '', '1']]);
  const fetcher = async () => html;
  try {
    let r = await runRewardPacks(db, { force: true, fetcher });
    assert.deepStrictEqual([r.firstRun, r.changed, r.cards], [true, false, 2]);
    assert.strictEqual(tg.sent.length, 0);

    r = await runRewardPacks(db, { force: true, fetcher });
    assert.strictEqual(r.changed, false);

    html = prpHtml([['Shock', 'M21', '', '1'], ['Crucible of Worlds', '5DN', 'FOIL', '1'], ['Opt', 'XLN', '', '2']], 'December 1, 2026');
    r = await runRewardPacks(db, { force: true, fetcher });
    assert.deepStrictEqual([r.changed, r.added.map((c) => c.name), r.removed.map((c) => c.name)], [true, ['Crucible of Worlds', 'Opt'], ['Refute Destiny']]);
    assert.deepStrictEqual(r.autoAdded, ['Crucible of Worlds']);
    assert.strictEqual(tg.sent.length, 1);
    assert.match(tg.sent[0], /Player Reward Packs changed<\/b> \(Last Updated: December 1, 2026\)/);
    assert.match(tg.sent[0], /<b>Crucible of Worlds<\/b> — own 2[^\n]*— 5DN FOIL/);
    assert.match(tg.sent[0], /Removed \(1\)<\/b>\n• Refute Destiny/);
    const h = await db.collection('highlights').findOne({ category: 'reward-pack' });
    assert.match(h.summary, /Yours: Crucible of Worlds/);
    assert.strictEqual(await db.collection('prp_snapshots').countDocuments(), 2);

    // The change closes this month's window: lazy (every 6 h) until a week before the next 1st
    const st = await db.collection('monitor_state').findOne({ _id: 'reward-packs' });
    assert.strictEqual(st.mode, 'idle');
    r = await runRewardPacks(db, { fetcher });
    assert.ok(r.skipped);

    // A broken page records the failure
    html = '<html><body>maintenance</body></html>';
    await assert.rejects(runRewardPacks(db, { force: true, fetcher }), /No card table/);
    assert.match((await db.collection('monitor_state').findOne({ _id: 'reward-packs' })).lastError, /No card table/);
  } finally {
    tg.restore();
    await db.dropDatabase();
    await client.close();
  }
});

test('banlist watcher: schedule from the next announcement date', { skip: !URI && 'TEST_MONGODB_URI not set' }, async () => {
  const client = await new MongoClient(URI).connect();
  const db = client.db('mtgo_banlist_test');
  await db.dropDatabase();
  const tg = fakeTelegram();
  const { runBanlist, SEED_ARTICLE } = require('../src/lib/banlist');
  const link = (slug, title) => `<a data-navigation-type="server-side" href="/en/news/announcements/${slug}"><h3 class="css-mbeyN">${title}</h3></a>`;
  let list = [link('mtg-arena-patch', 'MTG Arena Patch Notes'), link('magic-online-schedule', 'Magic Online Schedule')];
  const articles = {
    [SEED_ARTICLE]: '<article><p>Changes effective as of October 12, 2026.</p><p>Next announcement: November 30, 2026</p></article>',
    'https://magic.wizards.com/en/news/announcements/banned-and-restricted-november-30-2026':
      '<article><p>Brainstorm is banned in Legacy.</p><p>Next announcement: January 18, 2027</p></article>',
  };
  const fetched = [];
  const fetcher = async (url) => {
    fetched.push(url);
    if (url === 'https://magic.wizards.com/en/news/announcements') return `<html><body><main>${list.join('')}</main></body></html>`;
    if (articles[url]) return `<html><body>${articles[url]}</body></html>`;
    throw new Error('HTTP 404 for ' + url);
  };
  await db.collection('monitor_state').insertOne({ _id: 'reddit-mtgo', label: 'r/mtgo' });
  await db.collection('highlights').insertOne({ _id: 'old', monitorId: 'mtgo-news', title: 'noise' });
  try {
    // First run: nothing banned on the page → next date learned from the seed article
    let r = await runBanlist(db, { now: new Date('2026-11-20T20:00:00Z'), fetcher });
    assert.strictEqual(r.kept, 0);
    let st = await db.collection('monitor_state').findOne({ _id: 'banlist' });
    assert.strictEqual(st.nextAnnouncement.toISOString(), '2026-11-30T08:00:00.000Z');
    assert.deepStrictEqual([st.mode, st.windowStart.toISOString()], ['idle', '2026-11-29T08:00:00.000Z']); // 1 day before
    assert.strictEqual(await db.collection('monitor_state').countDocuments({ _id: 'reddit-mtgo' }), 0);
    assert.strictEqual(await db.collection('highlights').countDocuments({ monitorId: 'mtgo-news' }), 0);

    // Lazy: not due an hour later; due inside the window, every tick
    assert.ok((await runBanlist(db, { now: new Date('2026-11-20T21:00:00Z'), fetcher })).skipped);
    assert.ok((await runBanlist(db, { now: new Date('2026-11-27T20:00:00Z'), fetcher })).mode === 'idle'); // Friday: not yet
    // Sunday Nov 29 is inside the window but a weekend: every 6 hours
    r = await runBanlist(db, { now: new Date('2026-11-29T18:00:00Z'), fetcher });
    assert.ok(!r.skipped);
    r = await runBanlist(db, { now: new Date('2026-11-29T18:00:30Z'), fetcher });
    assert.deepStrictEqual([r.skipped, r.mode], [true, 'weekend']);
    // Monday: every tick
    r = await runBanlist(db, { now: new Date('2026-11-30T09:00:00Z'), fetcher });
    assert.strictEqual(r.mode, 'watching');
    r = await runBanlist(db, { now: new Date('2026-11-30T09:00:30Z'), fetcher });
    assert.ok(!r.skipped);
    assert.strictEqual(tg.sent.length, 0);

    // The announcement appears → Telegram, highlight, next date moves to January, back to lazy
    list = [link('banned-and-restricted-november-30-2026', 'Banned and Restricted Announcement — November 30, 2026'), ...list];
    r = await runBanlist(db, { now: new Date('2026-11-30T17:00:00Z'), fetcher });
    assert.strictEqual(r.kept, 1);
    assert.strictEqual(tg.sent.length, 1);
    assert.match(tg.sent[0], /🔨 <b>Banned and Restricted Announcement — November 30, 2026<\/b>/);
    st = await db.collection('monitor_state').findOne({ _id: 'banlist' });
    assert.deepStrictEqual([st.nextAnnouncement.toISOString(), st.mode], ['2027-01-18T08:00:00.000Z', 'idle']);
    assert.ok((await runBanlist(db, { now: new Date('2026-11-30T17:00:30Z'), fetcher })).skipped);
    assert.ok(await db.collection('highlights').findOne({ category: 'banlist' }));

    // Page broken → error recorded
    list = [];
    await assert.rejects(runBanlist(db, { now: new Date('2026-12-01T00:00:00Z'), fetcher }), /No announcements found/);
    assert.match((await db.collection('monitor_state').findOne({ _id: 'banlist' })).lastError, /No announcements/);
  } finally {
    tg.restore();
    await db.dropDatabase();
    await client.close();
  }
});

