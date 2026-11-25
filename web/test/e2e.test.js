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

  await t.test('card page: versions, owned, watch toggles, trade log, upload changes', async () => {
    let page = await html('/mtgo/card/' + encodeURIComponent('Ragavan, Nimble Pilferer'));
    assert.match(page, /<h1>Ragavan, Nimble Pilferer<\/h1>/);
    assert.match(page, /Versions on MTGO<\/span><span class="stat-value">3</);
    assert.match(page, /You own<\/span><span class="stat-value">2</);
    assert.match(page, /goatbots\.com\/card\/ragavan-nimble-pilferer/);
    // Lists link to the card page
    assert.match(await html('/mtgo/collection'), /href="\/mtgo\/card\/Ragavan%2C%20Nimble%20Pilferer"/);
    // Toggle short-term watch on the MH2R version, then off again
    await form('/mtgo/card/' + encodeURIComponent('Ragavan, Nimble Pilferer') + '/watch', { mtgoId: '99001', list: 'short' });
    page = await html('/mtgo/card/' + encodeURIComponent('Ragavan, Nimble Pilferer'));
    assert.match(page, /Added Ragavan, Nimble Pilferer \(MH2R\) to the short-term watch list/);
    assert.match(page, /class="pill-btn on"[^>]*>✓ Short/);
    assert.match(await html('/mtgo/watch/short'), /MH2R/);
    await form('/mtgo/card/' + encodeURIComponent('Ragavan, Nimble Pilferer') + '/watch', { mtgoId: '99001', list: 'short' });
    assert.match(await html('/mtgo/card/' + encodeURIComponent('Ragavan, Nimble Pilferer')), /Removed Ragavan/);
    // Trade log
    await form('/mtgo/card/' + encodeURIComponent('Ragavan, Nimble Pilferer') + '/trades', { date: '2026-11-01', direction: 'buy', mtgoId: '90543', qty: '2', price: '55', counterparty: 'GoatBots', note: 'xmas' });
    await form('/mtgo/card/' + encodeURIComponent('Ragavan, Nimble Pilferer') + '/trades', { date: '2026-11-10', direction: 'sell', qty: '1', price: '62.5', counterparty: 'Cardhoarder' });
    page = await html('/mtgo/card/' + encodeURIComponent('Ragavan, Nimble Pilferer'));
    assert.match(page, /Bought 2 for 110\.00 tix · sold 1 for 62\.50 tix · net -47\.50 tix/);
    const tradeId = page.match(/\/trades\/([a-f0-9]{24})\/delete/)[1];
    await form('/mtgo/card/' + encodeURIComponent('Ragavan, Nimble Pilferer') + `/trades/${tradeId}/delete`, {});
    assert.match(await html('/mtgo/card/' + encodeURIComponent('Ragavan, Nimble Pilferer')), /Bought 2 for 110\.00 tix · sold 0/);
    // A second CSV upload records per-card changes
    const csv = 'Card Name,Quantity,ID #,Rarity,Set,Collector #,Premium\n"Ragavan, Nimble Pilferer",3,90543,Mythic,MH2,138,Yes\nEvent Tickets,10,1,,,,No\n';
    const fd = new FormData();
    fd.append('file', new Blob([csv], { type: 'text/csv' }), 'export2.csv');
    assert.strictEqual((await req('/mtgo/upload', { method: 'POST', body: fd, headers: { accept: 'application/json' } })).status, 200);
    page = await html('/mtgo/card/' + encodeURIComponent('Ragavan, Nimble Pilferer'));
    assert.match(page, /<td class="num">2<\/td>\s*<td class="num">3<\/td>\s*<td class="num up">\+1<\/td>/);
    assert.match(await html('/mtgo/card/' + encodeURIComponent('Force of Will')), /<td class="num down">-1<\/td>/);
    // Unknown card
    assert.strictEqual((await req('/mtgo/card/Not%20A%20Card')).status, 404);
    // Live prices endpoint (vendors disabled in tests)
    const live = await (await req('/mtgo/api/live?name=Force%20of%20Will')).json();
    assert.strictEqual(live.disabled, true);
  });

  await t.test('GoatBots trade history import skips duplicates', async () => {
    const hdr = 'timestamp,time_cet,bot,get_value,give_value,credits_before,credits_after,method,itemID,name,cardset,rarity,foil,quantity,price\n';
    const t1 = '1787843359,"2026-08-27 17:09:19",GoatBots1,41.5,42,0.38,0.88,get,90543,"Ragavan, Nimble Pilferer",MH2,Mythic,1,1,41.5\n' +
               '1787843359,"2026-08-27 17:09:19",GoatBots1,41.5,42,0.38,0.88,give,1,"Event Ticket",EVT,Common,0,42,1\n';
    const t2 = '1787801349,"2026-08-27 05:29:09",GoatBots2,0,12.1,0.30,0.38,give,50000,"Force of Will",EMA,Mythic,0,1,12.1\n';
    const send = async (body) => {
      const fd = new FormData();
      fd.append('file', new Blob(['\uFEFF' + body], { type: 'text/csv' }), 'goatbots-trade-history.csv');
      const r = await req('/mtgo/trades/upload', { method: 'POST', body: fd, headers: { accept: 'application/json' } });
      return [r.status, await r.json()];
    };
    let [status, j] = await send(hdr + t1);
    assert.strictEqual(status, 200, JSON.stringify(j));
    assert.deepStrictEqual([j.tradesInFile, j.newTrades, j.newItems], [1, 1, 1]); // Event Tickets aren't a card entry
    [, j] = await send(hdr + t1 + t2); // overlapping download
    assert.deepStrictEqual([j.tradesInFile, j.newTrades, j.duplicateTrades, j.newItems], [2, 1, 1, 1]);
    [status, j] = await send('Card Name,Quantity,ID #,Rarity,Set,Collector #,Premium\n"X",1,2,C,S,1,No\n');
    assert.strictEqual(status, 400);
    assert.match(j.error, /collection export, not a trade history/);
    const page = await html('/mtgo/trades');
    assert.match(page, /2 trades<\/p>/);
    assert.match(page, /42 Event Tickets/);
    const card = await html('/mtgo/card/' + encodeURIComponent('Ragavan, Nimble Pilferer'));
    assert.match(card, /GoatBots import/);
    assert.match(card, /GoatBots1/);
  });

  await t.test('nav search: suggestions ranked by watch list / collection / all', async () => {
    let r = await (await req('/mtgo/api/suggest?q=rag')).json();
    assert.deepStrictEqual(r[0], { name: 'Ragavan, Nimble Pilferer', tier: 2, label: 'owned' });
    // Put Force of Will on the long-term list → it becomes tier 1
    await form('/mtgo/card/' + encodeURIComponent('Force of Will') + '/watch', { mtgoId: '50000', list: 'long' });
    r = await (await req('/mtgo/api/suggest?q=force')).json();
    assert.deepStrictEqual(r[0], { name: 'Force of Will', tier: 1, label: 'long' });
    const go = await req('/mtgo/go?q=forc');
    assert.strictEqual(go.status, 303);
    assert.strictEqual(go.headers.get('location'), '/mtgo/card/Force%20of%20Will');
    assert.match(await html('/mtgo'), /id="nav-search"/);
  });

  await t.test('collection changes become unconfirmed trades; GoatBots import and manual entry resolve them', async () => {
    // State now: Ragavan foil 90543 ×3, Event Tickets. Upload: Ragavan ×5 (+2), Force of Will EMA ×1 (+1)
    const upload = async (rows, name) => {
      const fd = new FormData();
      fd.append('file', new Blob(['Card Name,Quantity,ID #,Rarity,Set,Collector #,Premium\n' + rows], { type: 'text/csv' }), name);
      const r = await req('/mtgo/upload', { method: 'POST', body: fd, headers: { accept: 'application/json' } });
      return r.json();
    };
    const openCount = async () => Number((await html('/mtgo/trades')).match(/Unconfirmed <span class="muted small">\((\d+)\)/)[1]);
    const start = await openCount(); // earlier tests already left some
    await new Promise((r) => setTimeout(r, 1100)); // so a trade "just now" is after the previous upload
    const before = Math.floor(Date.now() / 1000);
    let u = await upload('"Ragavan, Nimble Pilferer",5,90543,Mythic,MH2,138,Yes\n"Force of Will",1,50000,Mythic,EMA,49,No\nEvent Tickets,3,1,,,,No\n', 'c3.csv');
    assert.deepStrictEqual(u.pending, { created: 2, checked: 2, resolved: 0 });
    assert.strictEqual(await openCount(), start + 2);
    let page;

    // A GoatBots download that includes buying 2 Ragavans inside the window resolves that one
    const hdr = 'timestamp,time_cet,bot,get_value,give_value,credits_before,credits_after,method,itemID,name,cardset,rarity,foil,quantity,price\n';
    const fd = new FormData();
    fd.append('file', new Blob([hdr + `${before},"x",GoatBots3,90,90,0,0,get,90543,"Ragavan, Nimble Pilferer",MH2,Mythic,1,2,45\n`], { type: 'text/csv' }), 'h.csv');
    const j = await (await req('/mtgo/trades/upload', { method: 'POST', body: fd, headers: { accept: 'application/json' } })).json();
    assert.deepStrictEqual([j.newTrades, j.pendingResolved, j.pendingOpen], [1, 1, start + 1]);

    // Fill in the Force of Will purchase by hand (bought from Dojo)
    page = await html('/mtgo/card/' + encodeURIComponent('Force of Will'));
    const ids = [...page.matchAll(/\/mtgo\/trades\/pending\/([a-f0-9]{24})\/resolve/g)].map((m) => m[1]);
    const id = ids[0]; // newest first: this upload's +1
    await form(`/mtgo/trades/pending/${id}/resolve`, { qty: '1', price: '12.5', date: new Date().toISOString().slice(0, 10), counterparty: 'Dojo', back: '/mtgo/trades#unconfirmed' });
    page = await html('/mtgo/trades');
    assert.match(page, /Saved to your trade history/);
    assert.strictEqual(await openCount(), start);
    const fow = await html('/mtgo/card/' + encodeURIComponent('Force of Will'));
    assert.match(fow, /Dojo/);
    assert.match(fow, /12\.50 tix/);

    // Sell 4 Ragavans that no trade explains → shows on the card page; bulk dismiss clears it
    u = await upload('"Ragavan, Nimble Pilferer",1,90543,Mythic,MH2,138,Yes\n"Force of Will",1,50000,Mythic,EMA,49,No\n', 'c4.csv');
    assert.strictEqual(u.pending.created, 1);
    const rag = await html('/mtgo/card/' + encodeURIComponent('Ragavan, Nimble Pilferer'));
    assert.match(rag, /Unconfirmed changes from collection uploads/);
    assert.match(rag, /−4/);
    const pid = rag.match(/\/mtgo\/trades\/pending\/([a-f0-9]{24})\/resolve/)[1];
    await form('/mtgo/trades/pending/dismiss', { ids: pid, back: '/mtgo/trades#unconfirmed' });
    assert.match(await html('/mtgo/trades'), /Dismissed 1 unconfirmed change\./);
  });

  await t.test('other pages still render', async () => {
    assert.match(await html('/mtgo'), /Your lists/);

    // Highlights: only the four watchers are listed, banlist highlights get their own chip
    await db.collection('monitor_state').insertMany([
      { _id: 'reddit-mtgo', label: 'r/mtgo', lastError: 'HTTP 404' },
      { _id: 'banlist', label: 'Banlist (Wizards announcements)', lastChecked: new Date(), nextAnnouncementText: 'November 30, 2026', mode: 'watching' },
      { _id: 'reward-packs', label: 'Player Reward Packs', lastChecked: new Date(), cards: 12, lastUpdatedText: 'November 2, 2026' },
      { _id: 'home-runner', label: 'Home runner (hobbymini)', lastBeat: new Date(Date.now() - 20 * 60000) },
    ]);
    await db.collection('highlights').insertOne({ _id: 'b1', source: 'Banlist', monitorId: 'banlist', title: 'Banned and Restricted Announcement', url: 'https://magic.wizards.com/x', category: 'banlist', detectedAt: new Date() });
    const hl = await html('/mtgo');
    assert.doesNotMatch(hl, /r\/mtgo/);
    assert.match(hl, /Banlist \(Wizards announcements\)[\s\S]*Player Reward Packs[\s\S]*12 cards · updated November 2, 2026/);
    assert.match(hl, /badge-banlist/);
    assert.match(hl, /Home runner \(hobbymini\)[\s\S]*not checking in/);
    assert.match(hl, /Next announcement: November 30, 2026[\s\S]*checking every 30 seconds/);
    assert.match(await html('/mtgo?category=reward-pack'), /class="chip active">Reward packs/);
    assert.match(await html('/mtgo/collection'), /Most valuable cards/);
    assert.match(await html('/home'), /MTGO Collection Manager/);
  });

  await t.test('show order: page, save and load a project', async () => {
    assert.match(await html('/home'), /Show Order/);
    assert.match(await html('/showorder'), /Find schedules/);
    const empty = await (await req('/showorder/api/project', { headers: { accept: 'application/json' } })).json();
    assert.strictEqual(empty.project, null);
    // bigger than the site-wide 20 kB JSON limit, like a real studio's lists
    const dancers = Array.from({ length: 600 }, (_, i) => ({ name: `Dancer number ${i}`, age: 4 + (i % 14), family: i % 9 ? '' : `Family ${i}` }));
    const body = {
      raw: { dancers, enrollments: [{ class: 'Tiny Tap', dancer: 'Dancer number 0' }], dances: [{ name: 'Tap', classes: 'Tiny Tap', hair: 'down' }] },
      source: 'test',
      settings: { nights: 2, minGap: 2 },
      results: [{ label: 'Option 1', named: { nights: [{ seq: ['Tap'], split: 1 }] }, locks: { tap: { night: 0, act: 0, slot: 1 } } }],
      active: 0,
    };
    const put = await req('/showorder/api/project', { method: 'PUT', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    assert.strictEqual(put.status, 200);
    const got = (await (await req('/showorder/api/project', { headers: { accept: 'application/json' } })).json()).project;
    assert.strictEqual(got.raw.dancers.length, 600);
    assert.deepStrictEqual(got.results[0].locks, { tap: { night: 0, act: 0, slot: 1 } });
    assert.strictEqual(got.settings.minGap, 2);
    const bad = await req('/showorder/api/project', { method: 'PUT', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ raw: { dancers: 'nope' } }) });
    assert.strictEqual(bad.status, 400);
    // still small everywhere else
    const big = await req('/mtgo/watch/short', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(30000) }) });
    assert.strictEqual(big.status, 413);
  });

  await t.test('swg ship builder: pages, ship list, save / load / delete a build', async () => {
    assert.match(await html('/home'), /SWG Ship Builder/);
    const page = await html('/swg/ships');
    assert.match(page, /<h1>Ship Builder<\/h1>/);
    assert.match(page, /Ship Builder[\s\S]*Loot[\s\S]*Crafting/);
    assert.match(await html('/swg/loot'), /Coming later/);
    const json = { 'content-type': 'application/json', accept: 'application/json' };
    const { ships } = await (await req('/swg/api/ships', { headers: json })).json();
    assert.ok(ships.length >= 30);
    const krayt = ships.find((s) => s.id === 'hutt_turret_ship');
    assert.strictEqual(krayt.name, 'M22-T Krayt Heavy Fighter');
    const build = { ship: krayt.id, overloads: { weapon: { on: true, level: 3 } }, components: { reactor: { name: 'rct_generic', source: 'default' } } };
    assert.strictEqual((await req('/swg/api/builds/My%20Krayt', { method: 'PUT', headers: json, body: JSON.stringify(build) })).status, 200);
    const list = (await (await req('/swg/api/builds', { headers: json })).json()).builds;
    assert.deepStrictEqual(list.map((b) => b.name), ['My Krayt']);
    const got = (await (await req('/swg/api/builds/my%20krayt', { headers: json })).json()).build;
    assert.deepStrictEqual(got.overloads.weapon, { on: true, level: 3 });
    const bad = await req('/swg/api/builds/x', { method: 'PUT', headers: json, body: JSON.stringify({ ...build, ship: 'nope' }) });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await req('/swg/api/builds/My%20Krayt', { method: 'DELETE', headers: json })).status, 200);
    assert.strictEqual((await req('/swg/api/builds/My%20Krayt', { headers: json })).status, 404);
  });
});
