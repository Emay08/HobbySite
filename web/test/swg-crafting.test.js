const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/swgCrafting');
const C = require('../public/swg-craft-calc.js');

const SCHEMATIC = `object_draft_schematic_test_widget = object_draft_schematic_shared_widget:new {
   templateType = DRAFTSCHEMATIC,
   customObjectName = "Test Widget\\'s Barrel",
   craftingToolTab = 1, -- (See DraftSchematicObjectTemplate.h)
   complexity = 20,
   xpType = "crafting_weapons_general",
   xp = 120,
   assemblySkill = "weapon_assembly",
   experimentingSkill = "weapon_experimentation",
   ingredientTitleNames = {"frame", "core", "barrel", "scope"},
   ingredientSlotType = {0, 0, 1, 3},
   resourceTypes = {"steel", "copper", "object/tangible/component/weapon/shared_barrel.iff", "object/tangible/component/weapon/shared_scope.iff"},
   resourceQuantities = {30, 10, 1, 1},
   contribution = {100, 100, 100, 50},
   targetTemplate = "object/weapon/test/widget.iff",
}
ObjectTemplates:addTemplate(object_draft_schematic_test_widget, "object/draft_schematic/test/widget.iff")`;

const TARGET = `object_weapon_test_widget = object_weapon_test_shared_widget:new {
	templateType = WEAPON,
	numberExperimentalProperties = {1, 1, 2, 2, 1},
	experimentalProperties = {"XX", "XX", "CD", "OQ", "SR", "OQ", "XX"},
	experimentalWeights = {1, 1, 2, 1, 1, 3, 1},
	experimentalGroupTitles = {"null", "null", "expDamage", "expSpeed", "null"},
	experimentalSubGroupTitles = {"null", "null", "mindamage", "attackspeed", "hitpoints"},
	experimentalMin = {0, 0, 10, 8, 1000},
	experimentalMax = {0, 0, 50, 4, 1000},
	experimentalPrecision = {0, 0, 0, 1, 0},
	experimentalCombineType = {0, 0, 1, 1, 4},
}`;

test('parses a schematic and its target', () => {
  const s = G.parseSchematic(SCHEMATIC);
  assert.strictEqual(s.name, "Test Widget's Barrel");
  assert.strictEqual(s.target, 'weapon/test/widget');
  assert.deepStrictEqual(s.slots.map((x) => [x.type, x.resource, x.qty, x.contribution]), [
    [0, 'steel', 30, 100],
    [0, 'copper', 10, 100],
    [1, 'tangible/component/weapon/barrel', 1, 100],
    [3, 'tangible/component/weapon/scope', 1, 50],
  ]);
  const t = G.parseTarget(TARGET);
  const dmg = t.attrs.find((a) => a.name === 'mindamage');
  assert.deepStrictEqual(dmg.weights, [['CD', 0.666667], ['OQ', 0.333333]]);
  assert.deepStrictEqual(t.attrs.find((a) => a.name === 'attackspeed').weights, [['SR', 0.25], ['OQ', 0.75]]);
  assert.deepStrictEqual(t.attrs.find((a) => a.name === 'hitpoints').weights, []);
  assert.deepStrictEqual(G.professionsFor('test/widget', s), ['weaponsmith']);
  assert.deepStrictEqual(G.professionsFor('chemistry/med_stimpack_b', { assemblySkill: 'medicine_assembly' }), ['medic']);
  assert.deepStrictEqual(G.professionsFor('chemistry/med_stimpack_e', { assemblySkill: 'medicine_assembly' }), ['doctor']);
  assert.deepStrictEqual(G.professionsFor('x/y', { assemblySkill: 'general_assembly', xpType: 'crafting_general' }), ['artisan']);
  assert.strictEqual(G.damageBits('STUN + LIGHTSABER'), 24);
});

function compactFixture() {
  const files = { 'object/draft_schematic/test/widget.lua': SCHEMATIC, 'object/weapon/test/widget.lua': TARGET };
  const data = G.buildCraftingData({ live: ['object/draft_schematic/test/widget.iff'], readFile: (p) => files[p] || null });
  return G.compactCraftingData(data);
}

test('assembly and experimentation follow the server formulas', () => {
  const d = compactFixture();
  const s = d.schematics[0];
  const t = d.targets[s.t];
  assert.strictEqual(s.st, 1);
  // uniform 1000: weightedSum 1000 → max 100 %, assembly 30 % × 1.0 (great success)
  let r = C.craft(s, t, { uniform: 1000 });
  let dmg = r.attrs.find((a) => a.name === 'mindamage');
  assert.ok(Math.abs(dmg.maxPct - 1) < 1e-9);
  assert.ok(Math.abs(dmg.pct - 0.3) < 1e-9);
  assert.ok(Math.abs(dmg.value - 22) < 1e-9); // 10 + 0.3 × 40
  // lower-is-better: attack speed 8 → 4
  const spd = r.attrs.find((a) => a.name === 'attackspeed');
  assert.ok(Math.abs(spd.value - (8 - 0.3 * 4)) < 1e-9);
  // fixed value with no weights
  assert.strictEqual(r.attrs.find((a) => a.name === 'hitpoints').value, 1000);
  // uniform 500: ws 500 → assembly % = 500 × (0.0075 + 0.015) / 100 = 11.25 %, cap 50 %
  r = C.craft(s, t, { uniform: 500, assembly: 0 });
  dmg = r.attrs.find((a) => a.name === 'mindamage');
  assert.ok(Math.abs(dmg.pct - 0.1125 * 1.05) < 1e-9);
  assert.ok(Math.abs(dmg.maxPct - 0.5) < 1e-9);
  // 3 amazing points: +24 %, then capped at 50 %
  r = C.craft(s, t, { uniform: 500, experiment: { expDamage: [3, 0] } });
  assert.ok(Math.abs(r.attrs.find((a) => a.name === 'mindamage').pct - (0.1125 + 0.24)) < 1e-9);
  r = C.craft(s, t, { uniform: 500, experiment: { expDamage: [10, 0] } });
  assert.ok(Math.abs(r.attrs.find((a) => a.name === 'mindamage').pct - 0.5) < 1e-9);
  assert.strictEqual(r.groups.find((g) => g.group === 'expDamage').pointsToCap, 5);
});

test('resource averages are quantity weighted and skip missing stats', () => {
  const d = compactFixture();
  const s = d.schematics[0];
  const avg = C.averages(s, { 0: { CD: 900, OQ: 600 }, 1: { OQ: 1000 } });
  assert.strictEqual(avg.CD, 900); // copper slot has no CD → left out
  assert.strictEqual(avg.OQ, (600 * 30 + 1000 * 10) / 40);
});

test('components add linearly, scaled by contribution; new stats are fixed', () => {
  const d = compactFixture();
  const s = d.schematics[0];
  const t = d.targets[s.t];
  const base = C.craft(s, t, { uniform: 800 });
  const r = C.craft(s, t, { uniform: 800, components: { 2: { props: [['mindamage', 6, 0, 'expDamage', false], ['zerorangemod', 10, 0, 'expRange', false]] }, 3: { props: [['mindamage', 4, 0, '', false]] } } });
  const b = base.attrs.find((a) => a.name === 'mindamage');
  const a = r.attrs.find((x) => x.name === 'mindamage');
  assert.ok(Math.abs(a.value - (b.value + 6 + 2)) < 1e-9); // scope slot is 50 %
  assert.strictEqual(a.min, 18);
  const zr = r.attrs.find((x) => x.name === 'zerorangemod');
  assert.strictEqual(zr.value, 10);
  assert.strictEqual(zr.experimentable, false);
});

test('real data: an energy layer gives its segment energy effectiveness', () => {
  const file = path.join(__dirname, '..', 'data', 'swg-crafting.json');
  if (!fs.existsSync(file)) return;
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const S = (id) => d.schematics.find((s) => s.id === id);
  const layer = S('armor/component/armor_layer_energy');
  const seg = S('armor/armor_segment_composite_advanced');
  const helm = S('clothing/clothing_armor_composite_helmet');
  if (!layer || !seg || !helm) return;
  const L = C.craft(layer, d.targets[layer.t], { uniform: 1000, experiment: 'max' });
  const lp = Object.fromEntries(L.props.map((p) => [p[0], p[1]]));
  assert.strictEqual(lp.armor_special_type, 2);
  assert.strictEqual(lp.energyeffectiveness, lp.armor_special_effectiveness);
  const segSlot = seg.s.findIndex((x) => x[1] === 3);
  const G2 = C.craft(seg, d.targets[seg.t], { uniform: 1000, experiment: 'max', components: { [segSlot]: { props: L.props } } });
  const gp = Object.fromEntries(G2.props.map((p) => [p[0], p[1]]));
  assert.strictEqual(gp.energyeffectiveness, lp.energyeffectiveness);
  assert.ok(gp.electricaleffectiveness > 0); // composite segments are electricity-special
  const helmSlot = helm.s.findIndex((x) => x[1] && x[2].includes('armor_segment'));
  const H = C.craft(helm, d.targets[helm.t], { uniform: 1000, experiment: 'max', components: { [helmSlot]: { props: G2.props } } });
  const row = (k) => H.armor.rows.find((x) => x.key === k);
  const ae = H.attrs.find((a) => a.name === 'armor_effectiveness').value;
  assert.strictEqual(row('kinetic').value, Math.min(80, Math.trunc(ae)));
  assert.strictEqual(row('energy').kind, 'special');
  assert.strictEqual(row('stun').kind, 'vulnerable');
});
