const test = require('node:test');
const assert = require('node:assert');
const { pickVersion, curatedTables } = require('../lib/chest');

test('chest versions: GoatBots variant, then treatment, then regular, then cheapest', () => {
  const { pickVersion, gbEntryFor } = require('../lib/chest');
  // the two SOA Force of Wills (+ foils): #19 English showcase, #84 Japanese
  const cands = [
    { _id: '148345', foil: false },
    { _id: '148346', foil: true },
    { _id: '148475', foil: false },
    { _id: '148476', foil: true },
  ];
  const info = new Map([
    ['148345', { label: 'Showcase', setName: 'Secrets of Strixhaven Mystical Archive' }],
    ['148475', { label: 'Showcase · Japanese', setName: 'Secrets of Strixhaven Mystical Archive' }],
  ]);
  const price = new Map([['148345', 30], ['148475', 25]]);
  const row = { name: 'Force of Will', set: 'SOA', treatment: 'Japanese Mystical Archive' };
  const gb = [{ name: 'Force of Will', variant: 'Japanese', set: 'SOA', foil: false }];
  assert.deepEqual(pickVersion(cands, row, info, price, gbEntryFor(row, gb)), { mtgoId: '148475', via: 'goatbots' });
  assert.deepEqual(pickVersion(cands, row, info, price, null), { mtgoId: '148475', via: 'treatment' });
  // nothing to go on: cheapest, flagged as a guess
  assert.deepEqual(pickVersion(cands, { ...row, treatment: 'Mystical Archive' }, new Map(), price, null), { mtgoId: '148475', via: 'guess' });
  assert.deepEqual(pickVersion(cands, { ...row, treatment: 'Foil' }, info, price, null).mtgoId, '148346'); // only foil is ambiguous… cheapest of foils (no prices) → first
  assert.deepEqual(pickVersion([{ _id: '1', foil: false }], row, info, price, null), { mtgoId: '1', via: 'single' });
  assert.deepEqual(pickVersion([], row, info, price, null), { mtgoId: null, via: 'none' });
  // GoatBots lists the plain printing without a variant → Scryfall's "Regular"
  const reg = new Map([['a', { label: 'Regular' }], ['b', { label: 'Borderless' }]]);
  const plain = { name: 'Moonshadow', set: 'ECL', treatment: '' };
  const gb2 = [{ name: 'Moonshadow', variant: '', set: 'ECL', foil: false }, { name: 'Moonshadow', variant: 'Japanese', set: 'ECL', foil: false }];
  assert.deepEqual(pickVersion([{ _id: 'a' }, { _id: 'b' }], plain, reg, new Map(), gbEntryFor(plain, gb2)), { mtgoId: 'a', via: 'goatbots' });
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
