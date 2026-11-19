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

test('reads MTGO exports with missing line breaks and unescaped quotes', () => {
  // Real MTGO export quirks: no line break after a name with an accent, quotes inside names not escaped
  const csv =
    'Card Name,Quantity,ID #,Rarity,Set,Collector #,Premium,Sideboarded,Annotation\r\n' +
    '"Event Ticket",247,1,Common,ETK,,No,No,0\r\n' +
    '"Márton Stromgald",1,28053,Rare,MED,104/195,No,No,0\r"Mystic Remora",1,28055,Uncommon,MED,42/195,No,No,0\r\n' +
    '"Henzie "Toolbox" Torre",1,99789,Mythic Rare,PRM,/1158,No,No,0\r\n' +
    '"Nazgûl",1,111681,Uncommon,LTR,332,Yes,No,0\r"Nazgûl",1,111683,Uncommon,LTR,333,Yes,No,0\r"Delighted Halfling",4,111702,Rare,LTR,402,No,No,0\r\n' +
    '"Mystic Remora",2,28055,Uncommon,MED,42/195,No,Yes,0\r\n';
  const { cards, rowCount } = parseCollectionCsv(Buffer.from(csv));
  assert.strictEqual(rowCount, 8);
  const by = (id) => cards.find((c) => c.mtgoId === id);
  assert.strictEqual(by('28053').name, 'Márton Stromgald');
  assert.strictEqual(by('28055').qty, 3); // main + sideboarded rows merged
  assert.strictEqual(by('99789').name, 'Henzie "Toolbox" Torre');
  assert.strictEqual(by('99789').rarity, 'Mythic Rare');
  assert.strictEqual(by('111683').name, 'Nazgûl');
  assert.strictEqual(by('111702').qty, 4);
  assert.strictEqual(by('1').qty, 247);
});

test('gives a readable error for broken non-MTGO CSVs', () => {
  assert.throws(() => parseCollectionCsv('name,count\n"a"b,1\n'), (e) => e.expose === true && /Couldn't read the CSV/.test(e.message));
});

test('a GoatBots trade history is refused as a collection', () => {
  const gb = 'timestamp,time_cet,bot,get_value,give_value,credits_before,credits_after,method,itemID,name,cardset,rarity,foil,quantity,price\n1787843359,"2026-08-27 17:09:19",GoatBots1,41.5,42,0.38,0.88,get,90543,"Force of Will",EMA,Mythic,0,5,41.5\n';
  assert.throws(() => parseCollectionCsv(Buffer.from(gb)), /GoatBots trade history.*Trades page/);
});
