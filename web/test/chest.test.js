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
