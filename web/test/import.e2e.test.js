// Spreadsheet import end to end (Treasure Chest history + spreadsheet trades) against a
// real MongoDB. Skipped unless TEST_MONGODB_URI is set.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const { MongoClient } = require('mongodb');

const URI = process.env.TEST_MONGODB_URI;
const DB = 'mtgo_import_e2e_test';
const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;

const GB_HEADER = 'timestamp,time_cet,bot,get_value,give_value,credits_before,credits_after,method,itemID,name,cardset,rarity,foil,quantity,price';
const ts = (iso) => Math.floor(new Date(`${iso}T12:00:00Z`).getTime() / 1000);
const gbRow = (iso, method, id, name, price, qty = 1) =>
  `${ts(iso)},"${iso} 13:00:00",GoatBots1,${price},${price},0,0,${method},${id},"${name}",EMA,Mythic,0,${qty},${price}`;

test('spreadsheet import end to end', { skip: !URI && 'TEST_MONGODB_URI not set' }, async (t) => {
  const client = await new MongoClient(URI).connect();
  const db = client.db(DB);
  await db.dropDatabase();

  await db.collection('cards').insertMany([
    { _id: '50000', name: 'Force of Will', nameLower: 'force of will', set: 'EMA', rarity: 'Mythic', foil: false },
    { _id: '60000', name: 'Grim Monolith', nameLower: 'grim monolith', set: 'ULG', rarity: 'Rare', foil: false },
    { _id: '70000', name: 'Mox Opal', nameLower: 'mox opal', set: 'SOM', rarity: 'Mythic', foil: false },
    { _id: '80000', name: 'Ancient Tomb', nameLower: 'ancient tomb', set: 'UMA', rarity: 'Rare', foil: false },
    { _id: '80001', name: 'Ancient Tomb', nameLower: 'ancient tomb', set: 'VMA', rarity: 'Rare', foil: false },
    { _id: '90000', name: 'Dockside Extortionist', nameLower: 'dockside extortionist', set: 'C19', rarity: 'Rare', foil: false },
  ]);
  // the watcher's newest page snapshot: after the Mar 1 update
  await db.collection('tc_snapshots').insertOne({
    takenAt: new Date('2026-03-05T00:00:00Z'),
    hash: 'x',
    parsed: {
      lastUpdatedText: 'Last Updated: 3/1/2026 1 p.m. PT',
      slots: [
        { name: 'CURATED SLOT', cards: [
          { name: 'Ancient Tomb', set: 'UMA', treatment: '', slots: 2 },
          { name: 'Mox Opal', set: 'SOM', treatment: 'Retro Frame', slots: 1 },
          { name: 'Bloomburrow Set', set: 'BLB', treatment: '', slots: 1 },
        ] },
      ],
    },
  });

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      MONGODB_URI: URI,
      MONGODB_DB: DB,
      ADMIN_USERNAME: 'me',
      ADMIN_PASSWORD_HASH: bcrypt.hashSync('pw', 4),
      SESSION_SECRET: 'test-secret',
      NODE_ENV: 'test',
      VENDOR_LIVE_DISABLED: '1',
      SCRYFALL_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  t.after(async () => {
    server.kill();
    await db.dropDatabase();
    await client.close();
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }

  let cookie = '';
  const req = async (p, opts = {}) => {
    const res = await fetch(BASE + p, { redirect: 'manual', ...opts, headers: { cookie, ...(opts.headers || {}) } });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    // Read the whole response before going on: express-session sends the headers before
    // the session is saved, so starting the next request on headers alone can overtake it.
    const body = await res.arrayBuffer();
    return new Response(body, { status: res.status, headers: res.headers });
  };
  const form = (p, data) => req(p, { method: 'POST', body: new URLSearchParams(data), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const html = async (p) => {
    const r = await req(p);
    assert.equal(r.status, 200, `${p} → ${r.status}\n${serverLog.slice(-2000)}`);
    return r.text();
  };
  const uploadFile = (p, name, content, type) => {
    const body = new FormData();
    body.append('file', new Blob([content], { type }), name);
    return req(p, { method: 'POST', body, headers: { accept: 'application/json' } });
  };

  await form('/login', { username: 'me', password: 'pw' });

  // GoatBots history covering part of the sheet's period
  let r = await uploadFile(
    '/mtgo/trades/upload',
    'gb.csv',
    [GB_HEADER, gbRow('2025-05-10', 'get', 50000, 'Force of Will', 9.08), gbRow('2025-06-01', 'get', 70000, 'Mox Opal', 11.67)].join('\n'),
    'text/csv'
  );
  assert.equal(r.status, 200, await r.text());

  const payload = {
    kind: 'vault-sheet-import',
    version: 1,
    createdAt: '2026-11-19T18:00:00Z',
    tcUpdates: [
      { date: '2026-01-16', tab: 'Jan 16 2025', hasTreatment: true, rows: [
        { name: 'Ancient Tomb', set: 'UMA', treatment: '', slots: 1, change: 1 },
        { name: 'Grim Monolith', set: 'ULG', treatment: '', slots: 0, change: -1 },
      ] },
      { date: '2026-03-01', tab: 'Mar 1 2026', hasTreatment: true, rows: [
        { name: 'Ancient Tomb', set: 'UMA', treatment: '', slots: 2, change: 1 },
        { name: 'Mox Opal', set: 'SOM', treatment: 'Retro Frame', slots: 1, change: 1 },
      ] },
    ],
    trades: [
      { column: 'bought', seq: 0, direction: 'buy', raw: 'force of will', text: 'force of will', qty: 1, foil: false, hints: '', price: 9.08 },
      { column: 'bought', seq: 1, direction: 'buy', raw: 'grim monolith', text: 'grim monolith', qty: 1, foil: false, hints: '', price: 6.66 },
      { column: 'bought', seq: 2, direction: 'buy', raw: 'mox opal', text: 'mox opal', qty: 1, foil: false, hints: '', price: 11.67 },
      { column: 'bought', seq: 3, direction: 'buy', raw: 'dockside', text: 'dockside', qty: 2, foil: false, hints: '', price: 4.01 },
      { column: 'sold', seq: 0, direction: 'sell', raw: 'zzz unknown card', text: 'zzz unknown card', qty: 1, foil: false, hints: '', price: 1 },
    ],
  };

  r = await uploadFile('/mtgo/import/upload', 'vault-import.json', JSON.stringify(payload), 'application/json');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).redirect, '/mtgo/import');

  let page = await html('/mtgo/import');
  assert.match(page, /Entries to check/);
  assert.match(page, /zzz unknown card/);
  assert.match(page, /Already in GoatBots/);

  // confirm, fixing nothing
  r = await form('/mtgo/import/confirm', { 'fix:sheet|sold|0': '' });
  assert.equal(r.status, 303);
  page = await html('/mtgo/import');
  assert.match(page, /Entries without a card/);

  // duplicates skipped; grim monolith gets the range between its matched neighbours
  const sheetTrades = await db.collection('trades').find({ source: 'sheet' }).sort({ _id: 1 }).toArray();
  assert.deepEqual(sheetTrades.map((x) => x.name).sort(), ['Dockside Extortionist', 'Grim Monolith']);
  const grim = sheetTrades.find((x) => x.name === 'Grim Monolith');
  assert.equal(grim.dateFrom, '2025-05-10');
  assert.equal(grim.dateTo, '2025-06-01');
  assert.equal(grim.mtgoId, '60000'); // only one version

  // Treasure Chest contents rebuilt backwards from the snapshot
  const jan = await db.collection('tc_history').findOne({ _id: '2026-01-16' });
  assert.deepEqual(jan.contents.map((c) => `${c.name}:${c.slots}`).sort(), ['Ancient Tomb:1', 'Bloomburrow Set:1']);
  assert.equal(jan.issues.length, 0);

  page = await html('/mtgo/tc');
  assert.match(page, /Treasure Chest history/);
  page = await html('/mtgo/tc/2026-03-01');
  assert.match(page, /Mox Opal/);
  assert.match(page, /Bloomburrow Set/);

  page = await html(`/mtgo/card/${encodeURIComponent('Ancient Tomb')}`);
  assert.match(page, /id="chest"/);
  assert.match(page, /In the chest now/);
  page = await html(`/mtgo/card/${encodeURIComponent('Grim Monolith')}`);
  assert.match(page, /Spreadsheet/);
  assert.match(page, /May 10, 2025/);

  // fix the unknown entry later
  r = await form('/mtgo/import/fix', { id: 'sheet|sold|0', name: 'force of will' });
  assert.equal(r.status, 303);
  assert.equal(await db.collection('trades').countDocuments({ _id: 'sheet|sold|0' }), 1);

  // an older GoatBots history that has the Dockside purchase removes that duplicate
  r = await uploadFile('/mtgo/trades/upload', 'gb-old.csv', [GB_HEADER, gbRow('2025-07-01', 'get', 90000, 'Dockside Extortionist', 4.01, 2)].join('\n'), 'text/csv');
  const gbRes = await r.json();
  assert.equal(gbRes.sheetRemoved, 1);
  assert.equal(await db.collection('trades').countDocuments({ source: 'sheet', name: 'Dockside Extortionist' }), 0);

  // removing a spreadsheet trade from the card page sticks across re-syncs
  r = await form(`/mtgo/card/${encodeURIComponent('Grim Monolith')}/trades/${encodeURIComponent('sheet|bought|1')}/delete`, {});
  assert.equal(r.status, 303);
  assert.equal(await db.collection('trades').countDocuments({ _id: 'sheet|bought|1' }), 0);
  assert.equal((await db.collection('sheet_trades').findOne({ _id: 'sheet|bought|1' })).status, 'skipped');

  // a GoatBots trade file dropped on the collection page is refused; the collection is untouched
  await db.collection('collection').insertOne({ _id: '70000', mtgoId: '70000', name: 'Mox Opal', qty: 3, set: 'SOM', foil: false });
  r = await uploadFile('/mtgo/upload', 'gb.csv', [GB_HEADER, gbRow('2025-05-10', 'get', 50000, 'Force of Will', 9.08)].join('\n'), 'text/csv');
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Trades page/);
  assert.equal(await db.collection('collection').countDocuments(), 1);

  // "start fresh": no unconfirmed entries against the old (wrong) collection
  await db.collection('pending_changes').insertOne({ mtgoId: '1234', status: 'open', qty: 1, remaining: 1, direction: 'buy', windowEnd: new Date() });
  {
    const body = new FormData();
    body.append('fresh', '1');
    body.append('file', new Blob(['Card Name,Quantity,ID #,Rarity,Set,Collector #,Premium\n"Grim Monolith",2,60000,Rare,ULG,1,No\n'], { type: 'text/csv' }), 'c.csv');
    r = await req('/mtgo/upload', { method: 'POST', body, headers: { accept: 'application/json' } });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.fresh.pendingDismissed, 1);
    assert.equal(await db.collection('pending_changes').countDocuments({ status: 'open' }), 0);
    assert.equal(await db.collection('collection_changes').countDocuments(), 0);
  }

  // card-name suggestions (pickers): owned-only filter
  r = await req('/mtgo/api/suggest?q=grim&owned=1');
  assert.deepEqual((await r.json()).map((x) => x.name), ['Grim Monolith']);
  r = await req('/mtgo/api/suggest?q=mox&owned=1');
  assert.deepEqual(await r.json(), []);

  // version labels + images from (cached) Scryfall details; owned version is shown first
  await db.collection('scryfall_cards').insertOne({ _id: '60000', fetchedAt: new Date(), info: { label: 'Borderless · Showcase', collector: '365', setName: 'Urza', img: { small: 'https://cards.scryfall.io/small/x.jpg', normal: 'https://cards.scryfall.io/normal/x.jpg', large: 'https://cards.scryfall.io/large/x.jpg' } } });
  {
    const page = await html(`/mtgo/card/${encodeURIComponent('Grim Monolith')}`);
    assert.match(page, /Borderless · Showcase/);
    assert.match(page, /id="card-art" src="https:\/\/cards\.scryfall\.io\/normal\/x\.jpg" data-preview="https:\/\/cards\.scryfall\.io\/large\/x\.jpg"/);
    assert.match(page, /class="version-row row-owned selected"/);
    const versions = await (await req(`/mtgo/api/cards?name=${encodeURIComponent('Grim Monolith')}`)).json();
    assert.equal(versions[0].label, 'Borderless · Showcase');
    assert.equal(versions[0].imgLarge, 'https://cards.scryfall.io/large/x.jpg');
  }

  // static links carry a content version so browsers refetch after deploys
  assert.match(await html('/mtgo/tc'), /\/static\/style\.css\?v=[0-9a-f]{10}/);

  // current Treasure Chest page
  {
    const tomb = await db.collection('watchlist').insertOne({ list: 'short', mtgoId: '80000', name: 'Ancient Tomb', set: 'UMA', foil: false, addedAt: new Date() });
    await db.collection('trades').insertOne({ source: 'manual', name: 'Ancient Tomb', nameLower: 'ancient tomb', mtgoId: '80000', direction: 'sell', qty: 2, price: 30, at: new Date('2026-03-10T12:00:00Z'), date: '2026-03-10' });
    await db.collection('price_daily').insertMany([
      { _id: '2026-03-06', date: '2026-03-06', prices: { 70000: 10 } },
      { _id: '2026-03-08', date: '2026-03-08', prices: { 70000: 12 } },
    ]);
    const page = await html('/mtgo/chest');
    assert.match(page, /Current Treasure Chest/);
    assert.match(page, /mtgo-treasure-chest-info/);
    assert.match(page, /Mar 4, 2026/); // recorded = when the snapshot was taken (4 p.m. Vancouver), not the page date
    assert.match(page, /New in CURATED SLOT/);
    assert.match(page, /The 1 card added to the first curated table/); // Mox Opal: long-listed, so graphed
    assert.match(page, /class="chest-chart"/);
    assert.match(page, /12\.00 tix/); // latest average
    assert.match(page, /Ancient Tomb/);
    assert.match(page, /↘ sold/);
    // columns: Card, Price, Change, Low, You own, Watch lists, In the chest
    assert.match(page, /<th>Card<\/th>\s*<th class="num">Price<\/th>\s*<th class="num"[^>]*>Change<\/th>\s*<th class="num"[^>]*>Low<\/th>/);
    assert.doesNotMatch(page, /first check by the watcher/);
    assert.match(page, /short-term/);
    // a printing GoatBots only started listing at the update is left out of the graph
    await db.collection('meta').updateOne({ _id: 'cardSync' }, { $set: { firstSyncAt: new Date('2026-01-01T00:00:00Z') } }, { upsert: true });
    await db.collection('cards').updateOne({ _id: '70000' }, { $set: { firstSeen: new Date('2026-03-04T12:00:00Z') } });
    {
      const p2 = await html('/mtgo/chest');
      assert.match(p2, /The 0 cards added/);
      assert.match(p2, /1 new printing \(unsettled prices\) left out/);
      assert.match(p2, /new printing · not graphed/);
      assert.doesNotMatch(p2, /class="chest-chart"/);
    }
    await db.collection('cards').updateOne({ _id: '70000' }, { $unset: { firstSeen: '' } });
    r = await form(`/mtgo/watch/item/${tomb.insertedId}/move`, { back: '/mtgo/chest' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/mtgo/chest');
    assert.equal((await db.collection('watchlist').findOne({ _id: tomb.insertedId })).list, 'long');
  }

  // undo
  r = await form('/mtgo/import/undo', { confirm: 'yes' });
  assert.equal(r.status, 303);
  assert.equal(await db.collection('trades').countDocuments({ source: 'sheet' }), 0);
  assert.equal(await db.collection('tc_history').countDocuments(), 0);
});
