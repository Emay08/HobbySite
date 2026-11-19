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

// Trimmed from a real Dojo ajax.php response (Nov 2026): columns are image, rarity/set, product, Buy, Sell, Stock, cart
const row = (set, product, buy, sell, stock, foil = false) => `<tr>
  <td class=" text-center"><img class="image-product-table" src="/x.jpg"></td>
  <td class=" text-center"><img src="/s.png" class="image-rarity" title="Rare - Some Set (${set})"></td>
  <td class=" text-start"><a href="/mtgoProduct/force-of-will" class="text-light"> ${product} ${foil ? '<img src="/public/images/icons/foil-swoosh.png" title="Foil">' : ''}</a></td>
  <td class=" text-center">${buy}</td><td class=" text-center">${sell}</td>
  <td class=" text-center"><span data-bs-toggle="tooltip"> ${stock} </span></td><td class=" text-center">-</td></tr>`;
const DOJO = [
  '<thead><tr><th>Rarity</th></tr></thead>',
  row('MED', 'Force of Will', '30.65', '65.54', '4'),
  row('DMR', 'Force of Will (Retro Frame)', '10.96', '15.98', '4'),
  row('MED', 'Force of Will', '48.00', '-', '-', true),
  row('MH1', 'Force of Negation', '1.00', '2.00', '4'),
].join('');

test('Cardhoarder: exact name only, ids are MTGO ids, buy only when buylisted', () => {
  const rows = parseCardhoarder(CH, 'Force of Will');
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[0], { mtgoId: '148345', set: 'SOA', foil: false, sell: 13.49, buy: 10.75, stock: 4, label: 'SOA #19' });
  assert.strictEqual(rows[1].buy, null);
  assert.strictEqual(rows[1].foil, true);
});

test('Dojo: set from rarity icon, variant from name, buy/sell columns, out of stock', () => {
  const rows = parseDojo(DOJO, 'Force of Will');
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(
    rows.map((r) => [r.set, r.foil, r.variant, r.buy, r.sell, r.stock]),
    [['MED', false, null, 30.65, 65.54, 4], ['DMR', false, 'Retro Frame', 10.96, 15.98, 4], ['MED', true, null, 48, null, null]]
  );
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
