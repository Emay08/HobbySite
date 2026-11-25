const test = require('node:test');
const assert = require('node:assert');
const { parseCardhoarder, parseDojo, goatbotsUrl, livePrices, _cache } = require('../lib/vendors');

// Trimmed from a real Cardhoarder /cards/search response (Nov 2026)
const CH = {
  data: { cards: { data: [
    { id: 148345, name: 'Force of Will', set_code: 'SOA', set_number: 19, is_foil: false, amount: '13.49', amount_buy: '10.750', is_buylisted: true, quantity_for_purchase: 4 },
    { id: 148346, name: 'Force of Will', set_code: 'SOA', set_number: 19, is_foil: true, amount: '2.00', amount_buy: null, is_buylisted: false, quantity_for_purchase: 0 },
    { id: 107589, name: 'Force of Will', set_code: 'DMR', set_number: 50, is_foil: false, amount: '27.45', amount_buy: '22.080', is_buylisted: true, quantity_for_purchase: 4 },
    { id: 999, name: 'Force of Negation', set_code: 'MH1', set_number: 52, is_foil: false, amount: '1.00', amount_buy: '0.5', is_buylisted: true, quantity_for_purchase: 4 },
  ], meta: { current_page: 1, last_page: 1, total: 4 } } },
};

// Trimmed from a real Dojo ajax.php response (Nov 22 2026): image, Rarity, Collector #, Product, Buy TIX, Sell TIX, Stock, cart
const row = (set, num, product, buy, sell, stock, foil = false) => `<tr>
  <td><img class="image-product-table" src="/x.jpg"></td>
  <td><img src="/s.png" class="image-rarity" title="Rare - Some Set (${set})"></td>
  <td>${num}</td>
  <td><a href="/mtgoProduct/force-of-will" class="text-light"> ${product} ${foil ? '<img src="/public/images/icons/foil-swoosh.png" title="Foil">' : ''}</a></td>
  <td>${buy}</td><td>${sell}</td>
  <td><span data-bs-toggle="tooltip"> ${stock} </span></td><td><select><option>1</option></select></td></tr>`;
const th = (t) => `<th><div><div class="flex-column text-center">${t}</div></div></th>`;
const DOJO = `<table class="table"><thead><tr>${['', 'Rarity', 'Collector<br/>#', 'Product', 'Buy<br/>TIX', 'Sell<br/>TIX', 'Stock', ''].map(th).join('')}</tr></thead><tbody>${[
  row('MED', '33', 'Force of Will', '27.35', '60.87', '4'),
  row('DMR', '50', 'Force of Will', '19.40', '24.49', '4'),
  row('MED', '33', 'Force of Will', '44.76', '-', '-', true),
  row('MH1', '52', 'Force of Negation', '1.00', '2.00', '4'),
].join('')}</tbody></table>`;

test('Cardhoarder: exact name only, ids are MTGO ids, buy only when buylisted', () => {
  const rows = parseCardhoarder(CH, 'Force of Will');
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[0], { mtgoId: '148345', set: 'SOA', foil: false, sell: 13.49, buy: 10.75, stock: 4, label: 'SOA #19' });
  assert.strictEqual(rows[1].buy, null);
  assert.strictEqual(rows[1].foil, true);
});

test('Dojo: columns found by header, set from rarity icon, collector number, out of stock', () => {
  const rows = parseDojo(DOJO, 'Force of Will');
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(
    rows.map((r) => [r.set, r.collector, r.foil, r.buy, r.sell, r.stock]),
    [['MED', '33', false, 27.35, 60.87, 4], ['DMR', '50', false, 19.4, 24.49, 4], ['MED', '33', true, 44.76, null, null]]
  );
  assert.throws(() => parseDojo('<table><thead><tr><th>Product</th></tr></thead></table>', 'x'), /no Buy\/Sell columns/);
  assert.strictEqual(rows[0].url, 'https://www.dojotradebots.com/mtgoProduct/force-of-will');
});

test('GoatBots card URLs', () => {
  assert.strictEqual(goatbotsUrl('Force of Will'), 'https://www.goatbots.com/card/force-of-will');
  assert.strictEqual(goatbotsUrl("Urza's Saga"), 'https://www.goatbots.com/card/urzas-saga');
  assert.strictEqual(goatbotsUrl('Jace, the Mind Sculptor'), 'https://www.goatbots.com/card/jace-the-mind-sculptor');
});

test('livePrices: queries both vendors, isolates failures, caches', async () => {
  _cache.clear();
  let calls = 0;
  const fakeFetch = async (url, opts) => {
    calls++;
    if (url.includes('cardhoarder')) {
      assert.strictEqual(new URL(url).searchParams.get('cardname'), '"Force of Will"');
      return Response.json(CH);
    }
    if (url.includes('dojotradebots')) {
      assert.strictEqual(opts.body.get('filter-search-product-name'), 'Force of Will');
      return new Response('nope', { status: 503 });
    }
    throw new Error('unexpected ' + url);
  };
  const r = await livePrices('Force of Will', { fetchImpl: fakeFetch, now: 1000 });
  assert.strictEqual(r.vendors.cardhoarder.ok, true);
  assert.strictEqual(r.vendors.cardhoarder.rows.length, 3);
  assert.deepStrictEqual(r.vendors.dojo, { ok: false, error: 'HTTP 503' });
  const again = await livePrices('force of will', { fetchImpl: fakeFetch, now: 60000 });
  assert.strictEqual(again.cached, true);
  assert.strictEqual(calls, 2);
});

test('Cardhoarder block: reported as blocked, then not asked again for 6 hours', async () => {
  const { cardhoarder, _blocked } = require('../lib/vendors');
  _blocked.cardhoarder = 0;
  let calls = 0;
  const f = async () => (calls++, new Response('Just a moment...', { status: 403 }));
  await assert.rejects(cardhoarder('Force of Will', f, 1000), (e) => e.blocked && /blocked by Cardhoarder/.test(e.message));
  await assert.rejects(cardhoarder('Force of Will', f, 1000 + 3600e3), /blocked/);
  assert.strictEqual(calls, 1);
  await assert.rejects(cardhoarder('Force of Will', f, 1000 + 7 * 3600e3), /blocked/);
  assert.strictEqual(calls, 2);
  _blocked.cardhoarder = 0;
});

test('Cardhoarder via the home runner when it is checking in', { skip: !process.env.TEST_MONGODB_URI && 'TEST_MONGODB_URI not set' }, async () => {
  const { MongoClient } = require('mongodb');
  const client = await new MongoClient(process.env.TEST_MONGODB_URI).connect();
  const db = client.db('mtgo_vendor_home_test');
  await db.dropDatabase();
  try {
    _cache.clear();
    const now = Date.now();
    await db.collection('monitor_state').insertOne({ _id: 'home-runner', lastBeat: new Date(now - 30000) });
    let direct = 0;
    const fakeFetch = async (url) => {
      if (url.includes('cardhoarder')) direct++;
      return new Response(JSON.stringify({ callbackData: { html: '<table><thead><tr><th>Buy TIX</th><th>Sell TIX</th></tr></thead></table>' } }), { status: 200 });
    };
    // Stand-in for the runner on hobbymini: answers the queued request
    const answer = setInterval(async () => {
      await db.collection('vendor_requests').updateOne(
        { status: 'pending' },
        { $set: { status: 'done', result: { ok: true, rows: [{ mtgoId: '1', set: 'MED', foil: false, sell: 60, buy: 30, stock: 4 }] } } }
      );
    }, 100);
    const r = await livePrices('Force of Will', { fetchImpl: fakeFetch, now, db });
    clearInterval(answer);
    assert.strictEqual(direct, 0);
    assert.deepStrictEqual([r.vendors.cardhoarder.ok, r.vendors.cardhoarder.via, r.vendors.cardhoarder.rows[0].sell], [true, 'home', 60]);
    const q = await db.collection('vendor_requests').findOne({});
    assert.deepStrictEqual([q._id, q.vendor, q.name], ['cardhoarder|force of will', 'cardhoarder', 'Force of Will']);

    // Runner gone quiet → straight to Cardhoarder again
    _cache.clear();
    await db.collection('monitor_state').updateOne({ _id: 'home-runner' }, { $set: { lastBeat: new Date(now - 10 * 60000) } });
    await livePrices('Force of Will', { fetchImpl: fakeFetch, now, db });
    assert.strictEqual(direct, 1);
  } finally {
    _cache.clear();
    await db.dropDatabase();
    await client.close();
  }
});
