const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/swgLoot');
const L = require('../public/swg-loot-calc.js');

const ITEM = (id, tier, mass, extra = '') => `${id} = {
	minimumLevel = 0,
	maximumLevel = -1,
	craftingValues = {
		{"ship_component_capacitor_energy", 100, 200, 1},${extra}
		{"ship_component_mass", ${mass[0]}, ${mass[1]}, 0},
		{"reverseengineeringlevel", ${tier}, ${tier}, 0},
	},
}
addLootItemTemplate("${id}", ${id})`;
const GROUP = (name, entries) => `${name} = {
	lootItems = {
${entries.map(([k, n, w]) => `		{${k}Template = "${n}", weight = ${w}},`).join('\n')}
	}
}
addLootGroupTemplate("${name}", ${name})`;
const SHIP = (id, chance, table, rolls = 1) => `${id} = ShipAgent:new {
	lootChance = ${chance},
	lootRolls = ${rolls},
	lootTable = "${table}",
	spaceFaction = "pirate",
}
ShipAgentTemplates:addShipAgentTemplate(${id}, "${id}")`;

test('loot files: items, groups, NPC ships', () => {
  const it = G.parseLootItem(ITEM('cap_a', 5, [3000, 1000]));
  assert.deepStrictEqual(it, { id: 'cap_a', tier: 5, stats: { ship_component_capacitor_energy: [100, 200, 1], ship_component_mass: [3000, 1000, 0] } });
  const g = G.parseLootGroup(GROUP('grp', [['item', 'cap_a', 6000000], ['group', 'other', 4000000]]));
  assert.deepStrictEqual(g.entries, [{ item: 'cap_a', weight: 6000000 }, { group: 'other', weight: 4000000 }]);
  const s = G.parseShipAgent(SHIP('pirate_t1', 0.15, 'tbl'));
  assert.deepStrictEqual(s, { id: 'pirate_t1', lootChance: 0.15, lootRolls: 1, lootTable: 'tbl', faction: 'pirate', ship: '' });
});

test('buildLootData: nested groups, weights out of 10,000,000, ships without loot rolls left out', () => {
  const d = G.buildLootData({
    items: [{ type: 'weapon_capacitor', text: ITEM('cap_a', 5, [3000, 1000]) }, { type: 'weapon_capacitor', text: ITEM('cap_b', 5, [3000, 1000]) }],
    groups: [
      GROUP('comp_t1', [['item', 'cap_a', 2500000], ['item', 'cap_b', 7500000]]),
      GROUP('faction_t1', [['group', 'comp_t1', 5000000], ['item', 'junk', 5000000]]),
    ],
    ships: [SHIP('pirate', 0.2, 'faction_t1'), SHIP('no_rolls', 0.5, 'faction_t1', 0), SHIP('lost', 0.5, 'missing_table')],
  });
  assert.deepStrictEqual(d.items.map((i) => i.id), ['cap_a', 'cap_b']);
  assert.deepStrictEqual(d.items[0].stats.mass, [3000, 1000, 0]); // prefix dropped
  assert.deepStrictEqual(d.tables.faction_t1, { g: [['comp_t1', 0.5]], i: [] });
  assert.deepStrictEqual(d.groups.comp_t1, [[0, 0.25], [1, 0.75]]);
  assert.deepStrictEqual(d.npcs, [['pirate', 0.2, 1, 'faction_t1', 'pirate']]);
  assert.deepStrictEqual(d.unknownTables, ['missing_table']);

  const drops = L.makeDropIndex(d);
  const probs = drops.tableProbs('faction_t1');
  assert.strictEqual(probs.get(0), 0.125);
  const npc = { chance: 0.2, rolls: 1 };
  assert.ok(Math.abs(L.killChance(npc, probs, [0]) - 0.025) < 1e-12); // 0.2 × 0.5 × 0.25
  assert.ok(Math.abs(L.killChance({ chance: 0.2, rolls: 2 }, probs, [0]) - (1 - 0.975 ** 2)) < 1e-12);
});

test('stat rolls: normal around the middle of the range, server constants', () => {
  assert.ok(Math.abs(L.SIGMA - 1 / (4 * 2.82333)) < 1e-12);
  const item = { stats: { mass: [3000, 1000, 0], capacitor_energy: [100, 200, 1], weapon_refire_rate: [400, 300, 3] } };
  const mass = L.itemStat(item, 'mass');
  assert.deepStrictEqual([mass.lo, mass.hi, mass.lower, mass.step], [1000, 3000, true, 1]);
  // the middle of the range is the median (whole-number rounding moves it by half a step)
  assert.ok(Math.abs(L.tailProb(L.itemStat(item, 'capacitor_energy'), 150) - 0.5) < 1e-9);
  assert.ok(Math.abs(L.tailProb(mass, 1999.5) - 0.5) < 1e-9); // mass ≤ 1999.5 ⇔ unrounded < 2000
  // one σ above the middle
  const e = L.itemStat(item, 'capacitor_energy');
  assert.ok(Math.abs(L.tailProb(e, 150 + 100 * L.SIGMA) - 0.158655) < 1e-5);
  // lower is better: P(mass ≤ v) grows as v rises
  assert.ok(L.tailProb(mass, 1500) < L.tailProb(mass, 1800));
  assert.strictEqual(L.tailProb(mass, 999), 0);
  assert.strictEqual(L.tailProb(e, 99), 1);
  // refire rate is shown in seconds
  assert.deepStrictEqual([L.itemStat(item, 'weapon_refire_rate').lo, L.itemStat(item, 'weapon_refire_rate').hi], [0.3, 0.4]);
  // a server-style simulation agrees
  let n = 0;
  const N = 200000;
  for (let i = 0; i < N; i++) {
    const z = Math.cos(2 * Math.PI * Math.random()) * Math.sqrt(-2 * Math.log(1 - Math.random()));
    const v = 100 + 100 * (((z * 0.5) / 2.82333 + 1) * 0.5);
    if (v >= 165) n++;
  }
  assert.ok(Math.abs(n / N - L.tailProb(e, 165)) < 0.004);
  assert.strictEqual(L.oneIn(0.001), '1 in 1,000');
  assert.strictEqual(L.oneIn(0), 'never');
});

test('RE projects: best value per stat, bonus by level, typical rolls fill gaps', () => {
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(L.reBonus), [0.01, 0.02, 0.02, 0.03, 0.03, 0.04, 0.04, 0.05, 0.05, 0.06]);
  const s = L.projectSummary('weapon_capacitor', 8, [
    { values: { capacitor_energy: 500, mass: 4000 }, typical: { capacitor_energy: 500, mass: 4000, hitpoints: 300 } },
    { values: { capacitor_energy: 600, mass: 4500 }, typical: { capacitor_energy: 600, mass: 4500, hitpoints: 320 } },
  ]);
  assert.strictEqual(s.values.capacitor_energy, 600 * 1.05);
  assert.strictEqual(s.values.mass, 4000 * 0.95);
  assert.strictEqual(s.values.hitpoints, 320 * 1.05);
  assert.deepStrictEqual(s.estimated, ['hitpoints']);
});

test('toShipFields: loot stats → ship builder parts', () => {
  assert.deepStrictEqual(L.toShipFields('engine', { engine_speed_maximum: 50, engine_pitch_rate_maximum: 40, mass: 900 }), {
    speed: 50, pitchRate: 40, mass: 900, acceleration: 40, deceleration: 30,
  });
  assert.deepStrictEqual(L.toShipFields('weapon', { weapon_refire_rate: 0.35, weapon_energy_per_shot: 20 }), { rate: 0.35, drain: 20 });
  assert.strictEqual(L.typeForSlot('shield_0'), 'shield_generator');
  assert.strictEqual(L.typeForSlot('capacitor'), 'weapon_capacitor');
  assert.strictEqual(L.typeForSlot('weapon_3'), 'weapon');
});

test('data/swg-loot.json: components of every type and tier, every NPC table resolvable', () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'swg-loot.json'), 'utf8'));
  for (const t of L.TYPE_KEYS) for (let tier = 1; tier <= 10; tier++) assert.ok(d.items.some((i) => i.type === t && i.tier === tier) || t === 'droid_interface', t + ' ' + tier);
  for (const [, , , table] of d.npcs) assert.ok(d.tables[table], table);
  for (const t of Object.values(d.tables)) for (const [g] of t.g) assert.ok(d.groups[g], g);
  for (const it of d.items) for (const k of Object.keys(it.stats)) assert.ok(L.STATS[k], 'stat ' + k + ' has a label');
});
