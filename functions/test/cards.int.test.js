// Card definitions keep the date each printing was first seen. Needs TEST_MONGODB_URI.
const test = require('node:test');
const assert = require('node:assert');
const { MongoClient } = require('mongodb');
const { storeCards } = require('../src/lib/cards');

const URI = process.env.TEST_MONGODB_URI;

test('firstSeen is set once per printing', { skip: !URI && 'TEST_MONGODB_URI not set' }, async () => {
  const client = await new MongoClient(URI).connect();
  const db = client.db('mtgo_fn_cards_test');
  await db.dropDatabase();
  try {
    // a card stored before firstSeen existed
    await db.collection('cards').insertOne({ _id: '1', name: 'Old Card', nameLower: 'old card', set: 'AAA', foil: false });
    await storeCards(db, [{ _id: '1', name: 'Old Card', set: 'AAA', foil: false, rarity: 'Rare' }, { _id: '2', name: 'Day One', set: 'BBB', foil: false }]);
    const day1 = await db.collection('cards').findOne({ _id: '2' });
    const meta1 = await db.collection('meta').findOne({ _id: 'cardSync' });
    await new Promise((r) => setTimeout(r, 20));
    await storeCards(db, [{ _id: '1', name: 'Old Card', set: 'AAA', foil: false, rarity: 'Rare' }, { _id: '2', name: 'Day One', set: 'BBB', foil: false }, { _id: '3', name: 'Brand New', set: 'CCC', foil: false }]);
    const [old, again, fresh, meta2] = await Promise.all([
      db.collection('cards').findOne({ _id: '1' }),
      db.collection('cards').findOne({ _id: '2' }),
      db.collection('cards').findOne({ _id: '3' }),
      db.collection('meta').findOne({ _id: 'cardSync' }),
    ]);
    assert.equal(old.firstSeen, undefined); // stored before tracking: no date
    assert.equal(old.rarity, 'Rare'); // fields still updated
    assert.deepEqual(again.firstSeen, day1.firstSeen); // kept on later syncs
    assert.ok(fresh.firstSeen > day1.firstSeen);
    assert.deepEqual(meta2.firstSyncAt, meta1.firstSyncAt); // earliest sync kept
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});
