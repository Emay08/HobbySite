const test = require('node:test');
const assert = require('node:assert');
const { parseGbChest } = require('../src/lib/gbChest');

// Trimmed from the live page (Nov 2026): heading, intro, then the curated list.
const li = (href, name, hover, set, foil = false) =>
  `<li data-item="x"${foil ? ' data-foil="1"' : ''}><a href="${href}"> <div class="img" data-img="y">${foil ? '<svg class="foil"><use href="/img/sprites-v31.svg#icon-foil"></use></svg>' : ''}</div> <div class="name col3">${name}</div> <div class="rarity col5 mythic" data-hover="${hover}"><svg class="set-icon"><use href="/img/sprites-v31.svg#cardset-${set}"></use></svg></div> <div class="wide buy col3"> <svg><use href="#price-5"></use></svg> </div> <div class="wide chance col3"> 1 : 560 </div> </a></li>`;
const html = `<html><body><main>
<h2>Treasure Chest Slots</h2><ul class="price-list col7"><li data-item="z" data-foil="1"><a href="#set-debut-slot"><div class="name col3">Set Debut Slot</div></a></li></ul>
<h2>Top 100 Curated Cards</h2><p>The most valuable cards.</p>
<ul class="price-list col7 curated">
<li class="header"><a><div class="img"></div><div class="name col5">Version</div></a></li>
${li('/card/moonshadow', 'Moonshadow', 'Lorwyn Eclipsed Mythic (ECL)', 'ecl')}
${li('/card/force-of-will#japanese', 'Force of Will (Japanese)', 'Secrets of Strixhaven Mystical Archive Mythic (SOA)', 'soa')}
${li('/card/captain-james-t-kirk#classic-foil', 'Foil Captain James T. Kirk (Classic)', 'Star Trek Mythic (TRK)', 'trk', true)}
${li('/card/doomsday#foil', 'Foil Doomsday', 'Weatherlight Rare (WL)', 'wl', true)}
${li('/card/q-stacking-the-deck#showcase', 'Q, Stacking the Deck (Showcase)', 'Star Trek Mythic (TRK)', 'trk')}
</ul><script></script></main></body></html>`;

test('GoatBots Treasure Chest list: name, variant, set, foil', () => {
  const e = parseGbChest(html);
  assert.equal(e.length, 5);
  assert.deepEqual(
    e.map((x) => [x.name, x.variant, x.set, x.foil]),
    [
      ['Moonshadow', '', 'ECL', false],
      ['Force of Will', 'Japanese', 'SOA', false],
      ['Captain James T. Kirk', 'Classic', 'TRK', true],
      ['Doomsday', '', 'WL', true],
      ['Q, Stacking the Deck', 'Showcase', 'TRK', false],
    ]
  );
  assert.equal(e[1].chance, '1 : 560');
});

test('missing list is an error, not an empty result', () => {
  assert.throws(() => parseGbChest('<html><body><h2>Something else</h2></body></html>'), /not found/);
});
