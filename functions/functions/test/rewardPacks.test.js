const test = require('node:test');
const assert = require('node:assert');
const { parseRewards, diff } = require('../src/lib/rewardPacks');
const { prpHtml } = require('./fixtures/prpPage');

test('parses the Player Rewards table', () => {
  const p = parseRewards(prpHtml([['Refute Destiny', 'FRA', 'FOIL Braintwister', '1'], ['Force of Will', 'ALL', '', '2']]));
  assert.strictEqual(p.lastUpdatedText, 'November 2, 2026');
  assert.deepStrictEqual(p.cards[0], { name: 'Refute Destiny', set: 'FRA', treatment: 'FOIL Braintwister', slots: 1 });
  assert.throws(() => parseRewards('<html><body><p>nothing</p></body></html>'), /No card table/);
});

test('diffs two versions of the contents', () => {
  const a = [{ name: 'A', set: 'X', treatment: '', slots: 1 }, { name: 'B', set: 'X', treatment: '', slots: 1 }];
  const b = [{ name: 'B', set: 'X', treatment: '', slots: 2 }, { name: 'C', set: 'Y', treatment: 'FOIL', slots: 1 }];
  const d = diff(a, b);
  assert.deepStrictEqual(d.added.map((c) => c.name), ['C']);
  assert.deepStrictEqual(d.removed.map((c) => c.name), ['A']);
  assert.deepStrictEqual(d.changed.map((c) => [c.name, c.from, c.slots]), [['B', 1, 2]]);
});
