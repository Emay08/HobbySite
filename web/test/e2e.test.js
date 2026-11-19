// End-to-end test against a real MongoDB. Skipped unless TEST_MONGODB_URI is set, e.g.
//   TEST_MONGODB_URI="mongodb://127.0.0.1:27017/?directConnection=true" npm test
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const { MongoClient } = require('mongodb');

const URI = process.env.TEST_MONGODB_URI;
const DB = 'mtgo_e2e_test';
const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;

const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

test('website end to end', { skip: !URI && 'TEST_MONGODB_URI not set' }, async (t) => {
  const client = await new MongoClient(URI).connect();
  const db = client.db(DB);
  await db.dropDatabase();

  // --- seed catalog + prices + history (what the Azure function would write)
  await db.collection('cards').insertMany([
    { _id: '90542', name: 'Ragavan, Nimble Pilferer', nameLower: 'ragavan, nimble pilferer', set: 'MH2', rarity: 'Mythic', foil: false },
    { _id: '90543', name: 'Ragavan, Nimble Pilferer', nameLower: 'ragavan, nimble pilferer', set: 'MH2', rarity: 'Mythic', foil: true },
    { _id: '99001', name: 'Ragavan, Nimble Pilferer', nameLower: 'ragavan, nimble pilferer', set: 'MH2R', rarity: 'Mythic', foil: false },
    { _id: '50000', name: 'Force of Will', nameLower: 'force of will', set: 'EMA', rarity: 'Mythic', foil: false },
  ]);
  await db.collection('prices').insertMany([
    { _id: '90542', price: 41.5, prevPrice: 40 },
    { _id: '90543', price: 60, prevPrice: 61 },
    { _id: '99001', price: 30, prevPrice: 31 },
    { _id: '50000', price: 12.1, prevPrice: 12.1 },
  ]);
  await db.collection('price_history').insertMany(
    [100, 60, 30, 8, 7, 1].map((d, i) => ({ _id: `90542|${day(d)}`, mtgoId: '90542', date: day(d), price: 30 + i * 2 }))
  );

  // --- start the server
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      MONGODB_URI: URI,
      MONGODB_DB: DB,
      ADMIN_USERNAME: 'me',
      ADMIN_PASSWORD_HASH: bcrypt.hashSync('correct horse', 4),
      SESSION_SECRET: 'test-secret',
      NODE_ENV: 'test',
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
    return res;
  };
  const form = (p, data) =>
    req(p, { method: 'POST', body: new URLSearchParams(data), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const html = async (p) => {
    const r = await req(p);
    assert.strictEqual(r.status, 200, `${p} → ${r.status}\n${serverLog}`);
    return r.text();
  };

  await t.test('login gate', async () => {
    assert.strictEqual((await req('/mtgo/targets')).status, 302);
    assert.strictEqual((await form('/login', { username: 'me', password: 'nope' })).status, 401);
    const ok = await form('/login', { username: 'me', password: 'correct horse' });
    assert.strictEqual(ok.status, 302);
  });

  await t.test('CSV upload', async () => {
    const csv = 'Card Name,Quantity,ID #,Rarity,Set,Collector #,Premium\n"Ragavan, Nimble Pilferer",2,90543,Mythic,MH2,138,Yes\nForce of Will,1,50000,Mythic,EMA,49,No\nEvent Tickets,10,1,,,,No\n';
    const fd = new FormData();
    fd.append('file', new Blob([csv], { type: 'text/csv' }), 'export.csv');
    const r = await req('/mtgo/upload', { method: 'POST', body: fd, headers: { accept: 'application/json' } });
    const j = await r.json();
    assert.strictEqual(r.status, 200, JSON.stringify(j));
    assert.strictEqual(j.uniqueCards, 3);
    assert.strictEqual(Math.round(j.totalValue * 100) / 100, 60 * 2 + 12.1 + 10);
  });

  await t.test('card search API', async () => {
    const all = await (await req('/mtgo/api/cards?q=raga')).json();
    assert.strictEqual(all.length, 3);
    const owned = await (await req('/mtgo/api/cards?q=raga&owned=1')).json();
    assert.deepStrictEqual(owned.map((c) => c.mtgoId), ['90543']);
    assert.strictEqual(owned[0].owned, 2);
    const printings = await (await req('/mtgo/api/cards?name=' + encodeURIComponent('Ragavan, Nimble Pilferer'))).json();
    assert.strictEqual(printings.length, 3);
  });

  await t.test('watch lists', async () => {
    assert.strictEqual((await form('/mtgo/watch/short', { mtgoId: '90542', alertPct: '10', note: 'zz-test-note' })).status, 303);
    assert.strictEqual((await form('/mtgo/watch/short', { mtgoId: '90542' })).status, 303); // duplicate → flash error
    let page = await html('/mtgo/watch/short');
    assert.match(page, /already on this list/);
    assert.match(page, /Ragavan/);
    assert.match(page, /\+3\.8%/); // 1 day: 40 → 41.5
    assert.match(page, /mini-spark/);
    const id = page.match(/\/mtgo\/watch\/item\/([a-f0-9]{24})\/move/)[1];
    await form(`/mtgo/watch/item/${id}/move`, {});
    page = await html('/mtgo/watch/long');
    assert.match(page, /Ragavan/);
    assert.doesNotMatch(await html('/mtgo/watch/short'), /zz-test-note/);
    await form(`/mtgo/watch/item/${id}/delete`, {});
    assert.match(await html('/mtgo/watch/long'), /Nothing on this list yet/);
  });

  await t.test('price targets', async () => {
    await form('/mtgo/targets', { mtgoId: '50000', direction: 'below', target: '13' }); // hit
    await form('/mtgo/targets', { mtgoId: '90542', direction: 'below', target: '38', nearPct: '10' }); // 9.2% away → near
    await form('/mtgo/targets', { mtgoId: '90543', direction: 'above', target: '200' }); // far
    await form('/mtgo/targets', { mtgoId: '90543', direction: 'above', target: '' }); // invalid
    const page = await html('/mtgo/targets');
    const section = (name) => page.split(`target-${name}`)[1]?.split('</section>')[0] || '';
    assert.match(section('hit'), /Force of Will/);
    assert.match(section('near'), /Ragavan[\s\S]*9\.2% away/);
    assert.match(section('far'), /200\.00 tix/);
    assert.match(page, /Enter a target price/);
  });

  await t.test('version swaps', async () => {
    await form('/mtgo/swaps', { ownedId: '90543', wantedId: '99001', qty: '2' });
    await form('/mtgo/swaps', { ownedId: '90543', wantedId: '99001' });
    assert.match(await html('/mtgo/swaps'), /already on the list/);
    await form('/mtgo/swaps', { ownedId: '90543', wantedId: '90543' });
    let page = await html('/mtgo/swaps');
    assert.match(page, /same printing/);
    assert.match(page, /Swap now/);
    assert.match(page, /save 30\.00 tix/);
    assert.match(page, /60\.00 tix total/);
    const id = page.match(/\/mtgo\/swaps\/([a-f0-9]{24})\/delete/)[1];
    await form(`/mtgo/swaps/${id}`, { margin: '50', qty: '2', note: '' });
    page = await html('/mtgo/swaps');
    assert.match(page, /below min\. 50\.00 tix/);
  });

  await t.test('other pages still render', async () => {
    assert.match(await html('/mtgo'), /Your lists/);
    assert.match(await html('/mtgo/collection'), /Most valuable cards/);
    assert.match(await html('/home'), /MTGO Collection Manager/);
  });
});
