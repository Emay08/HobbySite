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

  // undo
  r = await form('/mtgo/import/undo', { confirm: 'yes' });
  assert.equal(r.status, 303);
  assert.equal(await db.collection('trades').countDocuments({ source: 'sheet' }), 0);
  assert.equal(await db.collection('tc_history').countDocuments(), 0);
});
