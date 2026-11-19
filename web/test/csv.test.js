const test = require('node:test');
const assert = require('node:assert');
const { parseCollectionCsv } = require('../lib/csv');

test('parses the MTGO client CSV export format', () => {
  const csv = [
    '﻿Card Name,Quantity,ID #,Rarity,Set,Collector #,Premium',
    '"Ragavan, Nimble Pilferer",1,90542,Mythic,MH2,138,No',
    '"Ragavan, Nimble Pilferer",1,90543,Mythic,MH2,138,Yes',
    'Event Tickets,42,1,Common,EVENT,,No',
    'Island,0,1234,Basic Land,M21,,No',
  ].join('\r\n');
  const { cards, warnings } = parseCollectionCsv(Buffer.from(csv));
  assert.strictEqual(cards.length, 3);
  const foil = cards.find((c) => c.mtgoId === '90543');
  assert.strictEqual(foil.foil, true);
  assert.strictEqual(foil.name, 'Ragavan, Nimble Pilferer');
  assert.strictEqual(foil.set, 'MH2');
  assert.strictEqual(cards.find((c) => c.mtgoId === '1').qty, 42);
  assert.strictEqual(warnings.length, 1);
});

test('merges duplicate rows and handles missing ID column', () => {
  const csv = 'name,count,set,foil\nLightning Bolt,2,m10,false\nLightning Bolt,3,M10,false\n';
  const { cards } = parseCollectionCsv(csv);
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].qty, 5);
  assert.strictEqual(cards[0]._id, 'Lightning Bolt|M10|N');
});

test('rejects files without required columns', () => {
  assert.throws(() => parseCollectionCsv('foo,bar\n1,2\n'), /Card Name/);
});
