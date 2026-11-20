const test = require('node:test');
const assert = require('node:assert');
const { pickVersion, curatedTables } = require('../lib/chest');

test('chest versions map to MTGO IDs by treatment', () => {
  const cands = [
    { _id: '1', foil: false },
    { _id: '2', foil: false },
    { _id: '3', foil: true },
  ];
  const labels = new Map([['1', 'Regular'], ['2', 'Borderless · Showcase'], ['3', 'Regular']]);
  const price = new Map([['1', 5], ['2', 9], ['3', 7]]);
  assert.equal(pickVersion(cands, { treatment: 'Borderless' }, labels, price), '2');
  assert.equal(pickVersion(cands, { treatment: '' }, labels, price), '1');
  assert.equal(pickVersion(cands, { treatment: 'Foil' }, labels, price), '3');
  assert.equal(pickVersion(cands, { treatment: 'Japanese Mystical Archive' }, new Map(), price), '1'); // no label match: cheapest
  assert.equal(pickVersion([], { treatment: '' }, labels, price), null);
});

test('curated tables: by section when recorded, else all', () => {
  const parsed = { slots: [
    { name: 'CURATED SLOT', section: 'CURATED CARD LISTS - November 10', cards: [] },
    { name: 'SET DEBUT SLOT', section: 'CURATED CARD LISTS - November 10', cards: [] },
    { name: 'OTHER', section: 'SOMETHING ELSE', cards: [] },
  ] };
  assert.deepEqual(curatedTables(parsed).map((t) => t.name), ['CURATED SLOT', 'SET DEBUT SLOT']);
  assert.equal(curatedTables({ slots: [{ name: 'A', cards: [] }] }).length, 1);
});

test('new printings: listed by GoatBots around the update, not before tracking began', () => {
  const { isNewPrinting } = require('../lib/chest');
  const rec = new Date('2026-12-09T18:00:00Z');
  const firstSync = new Date('2026-11-20T10:20:00Z');
  assert.equal(isNewPrinting(null, rec, firstSync), false); // stored before firstSeen existed
  assert.equal(isNewPrinting(new Date('2026-11-20T10:21:00Z'), rec, firstSync), false); // in the first sync
  assert.equal(isNewPrinting(new Date('2026-11-30T10:20:00Z'), rec, firstSync), false); // listed well before the update
  assert.equal(isNewPrinting(new Date('2026-12-08T10:20:00Z'), rec, firstSync), true); // a day before (previews)
  assert.equal(isNewPrinting(new Date('2026-12-10T10:20:00Z'), rec, firstSync), true); // after
});
