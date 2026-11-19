const test = require('node:test');
const assert = require('node:assert');
const nm = require('../lib/nameMatch');
const { plan } = require('../lib/sheetTrades');
const tc = require('../lib/tcHistory');

const names = nm.makeEntries([
  { name: 'Dockside Extortionist', tier: -1 },
  { name: 'Dockside Chef', tier: 3 },
  { name: 'Temporal Manipulation', tier: 3 },
  { name: 'Underground Sea', tier: 2 },
  { name: 'Mantle of the Ancients', tier: 3 },
  { name: 'The Meathook Massacre', tier: 2 },
  { name: 'Meathook Massacre II', tier: 3 },
  { name: "Agatha's Soul Cauldron", tier: 3 },
  { name: 'Lórien Revealed', tier: 2 },
  { name: 'Teval, the Balanced Scale', tier: 3 },
  { name: 'Teval, Arbiter of Virtue', tier: 3 },
]);

test('hand-typed names resolve to real cards', () => {
  const r = (s) => nm.resolve(names, s);
  assert.equal(r('dockside').name, 'Dockside Extortionist'); // traded beats a namesake
  assert.equal(r('dockside').status, 'ok');
  assert.equal(r('temporal manip').name, 'Temporal Manipulation');
  assert.equal(r('undergound sea').name, 'Underground Sea'); // typo
  assert.equal(r('mantle ancients').name, 'Mantle of the Ancients');
  assert.equal(r('meathook massacre').name, 'The Meathook Massacre');
  assert.equal(r('agatha soul cauldron').name, "Agatha's Soul Cauldron");
  assert.equal(r('lorien revealed').name, 'Lórien Revealed');
  assert.equal(r('teval').status, 'check'); // two equally good cards
  assert.equal(r('zzzz qqq').status, 'none');
});

const T = (iso) => new Date(`${iso}T12:00:00Z`);
const gb = [
  { _id: 'g1', nameLower: 'tundra', direction: 'buy', qty: 1, price: 16, at: T('2025-05-05') },
  { _id: 'g2', nameLower: 'force of will', direction: 'buy', qty: 1, price: 9.08, at: T('2025-05-10') },
  { _id: 'g3', nameLower: 'force of will', direction: 'buy', qty: 1, price: 9.08, at: T('2026-08-01') }, // same price much later
  { _id: 'g4', nameLower: 'ephemerate', direction: 'buy', qty: 4, price: 0.8, at: T('2025-05-20') },
  { _id: 'g5', nameLower: 'ephemerate', direction: 'buy', qty: 4, price: 0.8, at: T('2025-05-20') },
  { _id: 'g6', nameLower: 'mox opal', direction: 'buy', qty: 1, price: 11.67, at: T('2025-06-01') },
  { _id: 'g7', nameLower: 'solitude', direction: 'buy', qty: 1, price: 5.29, at: T('2025-06-10') },
];
const E = (column, seq, nameLower, price, qty = 1, direction = 'buy') => ({ _id: `sheet|${column}|${seq}`, column, seq, nameLower, price, qty, direction });

test('matching keeps sheet order and dates in step', () => {
  const entries = [
    E('bought', 0, 'force of will', 9.08), // must take May 2025, not Aug 2026
    E('bought', 1, 'tundra', 16), // a stray: GoatBots has it earlier than the previous entry
    E('bought', 2, 'ephemerate', 0.8, 8), // "x8" = two GoatBots lines of 4
    E('bought', 3, 'grim monolith', 6.66), // not on GoatBots
    E('bought', 4, 'mox opal', 11.67),
    E('bought', 5, 'solitude', null), // no price: matched by card inside its range
    E('rebought', 0, 'mox opal', 11.67), // same trade noted in another column → also a duplicate
  ];
  const p = plan(entries, gb, { end: T('2026-11-19') });
  assert.deepEqual(p.get('sheet|bought|0').matched, ['g2']);
  assert.deepEqual(p.get('sheet|bought|2').matched.sort(), ['g4', 'g5']);
  assert.deepEqual(p.get('sheet|bought|4').matched, ['g6']);
  assert.deepEqual(p.get('sheet|rebought|0').matched, ['g6']);
  assert.deepEqual(p.get('sheet|bought|5').matched, ['g7']);
  const grim = p.get('sheet|bought|3');
  assert.equal(grim.matched.length, 0);
  assert.equal(grim.from.toISOString().slice(0, 10), '2025-05-20');
  assert.equal(grim.to.toISOString().slice(0, 10), '2025-06-01');
});

test('Treasure Chest: copied tabs are detected and contents rebuilt backwards', async () => {
  const prepared = tc.prepareSheetUpdates([
    { date: '2024-05-13', tab: 'May 13 2024', rows: [
      { name: 'A', set: 'X', treatment: '', slots: 1, change: 1 },
      { name: 'B', set: 'X', treatment: '', slots: 0, change: -1 },
      { name: 'C', set: 'X', treatment: '', slots: 2, change: 1 },
    ] },
    { date: '2024-06-04', tab: 'June 4 2024', rows: [
      { name: 'A', set: 'X', treatment: '', slots: 1, change: 1 }, // copied
      { name: 'B', set: 'X', treatment: '', slots: 0, change: -1 }, // copied
      { name: 'D', set: 'Y', treatment: 'Retro', slots: 1, change: 1 },
    ] },
  ]);
  assert.equal(prepared[1].excludedRows.length, 2);
  assert.equal(prepared[1].rows.length, 1);
  assert.equal(prepared[0].excludedRows.length, 0);
});
