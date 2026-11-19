const test = require('node:test');
const assert = require('node:assert');
const { rank, norm } = require('../lib/search');

const entry = (name, tier) => ({ name, norm: norm(name), words: norm(name).split(/[\s,/-]+/), tier });
const entries = [
  entry('Lightning Bolt', 3),
  entry('Lightning Helix', 2),
  entry('Lightning Greaves', 1),
  entry('Chain Lightning', 0),
  entry('Force of Will', 3),
  entry('Force of Negation', 2),
  entry('Võx, Child of the Collective', 3),
];

test('watch lists first, then collection, then everything', () => {
  assert.deepStrictEqual(rank(entries, 'light').map((r) => [r.name, r.label]), [
    ['Chain Lightning', 'short'],
    ['Lightning Greaves', 'long'],
    ['Lightning Helix', 'owned'],
    ['Lightning Bolt', ''],
  ]);
});

test('within a tier: exact, then prefix, then word prefix, then substring', () => {
  const r = rank([entry('Storm Crow', 3), entry('Crow of Dark Tidings', 3), entry('Scarecrow', 3), entry('Crow', 3)], 'crow');
  assert.deepStrictEqual(r.map((x) => x.name), ['Crow', 'Crow of Dark Tidings', 'Storm Crow', 'Scarecrow']);
});

test('accents, word fragments, minimum length', () => {
  assert.strictEqual(rank(entries, 'vox child')[0].name, 'Võx, Child of the Collective');
  assert.strictEqual(rank(entries, 'for neg')[0].name, 'Force of Negation');
  assert.deepStrictEqual(rank(entries, 'f'), []);
});
