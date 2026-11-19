// Integration test for the daily job against a real MongoDB, with GoatBots and
// Telegram replaced by fakes. Skipped unless TEST_MONGODB_URI is set.
const test = require('node:test');
const assert = require('node:assert');
const AdmZip = require('adm-zip');
const { MongoClient } = require('mongodb');

const URI = process.env.TEST_MONGODB_URI;

function zipOf(name, obj) {
  const z = new AdmZip();
  z.addFile(name, Buffer.from(JSON.stringify(obj)));
  return z.toBuffer();
}

test('daily sync: prices, history, alerts', { skip: !URI && 'TEST_MONGODB_URI not set' }, async () => {
  const client = await new MongoClient(URI).connect();
  const db = client.db('mtgo_fn_test');
  await db.dropDatabase();

  process.env.TELEGRAM_BOT_TOKEN = 'TEST';
  process.env.TELEGRAM_CHAT_ID = '42';
  // These alerts are off by default; this test switches them on to check they work.
  process.env.NOTIFY_PRICE_TARGETS = 'true';
  process.env.NOTIFY_SWAPS = 'true';
  process.env.NOTIFY_SHORT_WATCH = 'true';

  let priceFile = { 1: 1, 90542: 41.5, 90543: 60, 99001: 30, 50000: 12.1 };
  const cardsFile = {
    90542: { name: 'Ragavan, Nimble Pilferer', cardset: 'MH2', rarity: 'Mythic', foil: 0 },
    90543: { name: 'Ragavan, Nimble Pilferer', cardset: 'MH2', rarity: 'Mythic', foil: 1 },
    99001: { name: 'Ragavan, Nimble Pilferer', cardset: 'MH2R', rarity: 'Mythic', foil: 0 },
    50000: { name: 'Force of Will', cardset: 'EMA', rarity: 'Mythic', foil: 0 },
  };
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    url = String(url);
    if (url.includes('price-history')) return new Response(zipOf('price-history-x.txt', priceFile));
    if (url.includes('card-definitions')) return new Response(zipOf('card-definitions.txt', cardsFile));
    if (url.includes('api.telegram.org')) {
      sent.push(JSON.parse(opts.body).text);
      return Response.json({ ok: true, result: {} });
    }
    throw new Error('unexpected fetch ' + url);
  };

  try {
    const { runDailySync } = require('../src/lib/dailySync');
    const log = () => {};

    // Day 0: establish prices, then add the user's lists
    await runDailySync(db, { log });
    assert.strictEqual(await db.collection('cards').countDocuments(), 4);
    await db.collection('collection').insertOne({ _id: '90543', mtgoId: '90543', name: 'Ragavan, Nimble Pilferer', qty: 2, set: 'MH2', foil: true });
    await db.collection('watchlist').insertOne({ list: 'short', mtgoId: '50000', name: 'Force of Will', set: 'EMA', foil: false, alertPct: 10 });
    await db.collection('targets').insertMany([
      { mtgoId: '90542', name: 'Ragavan, Nimble Pilferer', set: 'MH2', target: 38, direction: 'below', hit: false },
      { mtgoId: '50000', name: 'Force of Will', set: 'EMA', target: 20, direction: 'above', hit: false },
    ]);
    await db.collection('swaps').insertOne({
      ownedId: '90543', wantedId: '99001', qty: 2, margin: 0, good: false,
      ownedCard: { name: 'Ragavan, Nimble Pilferer', set: 'MH2', foil: true },
      wantedCard: { name: 'Ragavan, Nimble Pilferer', set: 'MH2R', foil: false },
    });
    sent.length = 0;

    // Day 1: Ragavan drops below target, FoW jumps 20%; the swap is already favourable
    priceFile = { ...priceFile, 90542: 37, 50000: 14.52 };
    await runDailySync(db, { log });

    const joined = sent.join('\n---\n');
    assert.strictEqual(sent.length, 3, joined);
    assert.match(joined, /Price target reached[\s\S]*Buy Ragavan[\s\S]*37\.00/);
    assert.match(joined, /Version swap now in your favour[\s\S]*save 30\.00 tix each, ×2/);
    assert.match(joined, /Short-term watch list[\s\S]*Force of Will[\s\S]*\+20%/);

    const t = await db.collection('targets').findOne({ mtgoId: '90542' });
    assert.strictEqual(t.hit, true);
    assert.strictEqual(t.hitPrice, 37);
    assert.strictEqual((await db.collection('swaps').findOne()).good, true);
    assert.ok((await db.collection('price_history').countDocuments({ mtgoId: '90542' })) >= 1);
    assert.strictEqual((await db.collection('value_history').findOne()).totalValue, 120);

    // Day 2: nothing changes → no repeat notifications
    sent.length = 0;
    await runDailySync(db, { log });
    assert.deepStrictEqual(sent, []);

    // Day 3: Ragavan back above target → re-armed; next drop alerts again
    priceFile = { ...priceFile, 90542: 45 };
    await runDailySync(db, { log });
    assert.strictEqual((await db.collection('targets').findOne({ mtgoId: '90542' })).hit, false);
    priceFile = { ...priceFile, 90542: 36 };
    sent.length = 0;
    await runDailySync(db, { log });
    assert.ok(sent.some((s) => /Price target reached/.test(s)));
    // With the NOTIFY_* settings off (the default), the same changes send nothing
    for (const k of ['NOTIFY_PRICE_TARGETS', 'NOTIFY_SWAPS', 'NOTIFY_SHORT_WATCH']) delete process.env[k];
    priceFile = { ...priceFile, 90542: 45, 50000: 12.1 };
    await runDailySync(db, { log });
    priceFile = { ...priceFile, 90542: 30, 50000: 16 };
    sent.length = 0;
    await runDailySync(db, { log });
    assert.deepStrictEqual(sent, []);
    assert.strictEqual((await db.collection('targets').findOne({ mtgoId: '90542' })).hit, true); // website still updated
  } finally {
    global.fetch = realFetch;
    await db.dropDatabase();
    await client.close();
  }
});
