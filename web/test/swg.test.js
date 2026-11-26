const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('../lib/swgShips');
const C = require('../public/swg-calc.js');

const LUA = `
--Copyright
object_ship_player_player_test = object_ship_player_shared_player_test:new {
	name = "player_test",
	certificationsRequired = {"cert_starships_test"},
	slideFactor = 1.76,
	chassisHitpoints = 1512,
	chassisMass = 1000,
	category = "heavyfighter",
	level = 5,
	attributes = {
		{"engineAccel", 35},
		{"maxSpeed", 0.5},
	},
	reactor = { name = "rct_generic", hitpoints = 298.5859, armor = 293.59,},
	engine = { name = "eng_x", hitpoints = 99, armor = 99, speed = 100, acceleration = 12, deceleration = 15, pitchRate = 60, yawRate = 40, rollRate = 59,},
	shield_0 = { name = "shd_generic", hitpoints = 389, armor = 488, regen = 5, front = 900, back = 1000,},
	armor_0 = { name = "arm_generic", hitpoints = 199, armor = 190,},
	armor_1 = { name = "arm_generic", hitpoints = 194, armor = 180,},
	capacitor = { name = "cap_generic", hitpoints = 0, armor = 0, rechargeRate = 20, energy = 500,},
	--weapon_9 = { name = "wpn_commented_out", rate = 1,},
	weapon_1 = { name = "wpn_b", rate = 0.5, drain = 10, maxDamage = 300, minDamage = 100,},
	weapon_0 = { name = "wpn_a", rate = 0.5, drain = 10, maxDamage = 200, minDamage = 100,},
	weapon_2 = { name = "wpn_std_countermeasure", rate = 10, drain = 20, maxDamage = 99, minDamage = 24, ammo = 25, ammo_type = 6,},
	childObjects = {
		{ templateFile = "object/x.iff", x = 1, componentSlot = -2 },
	},
}
`;

test('parseShipLua: chassis, attributes and slots in order', () => {
  const s = L.parseShipLua(LUA);
  assert.strictEqual(s.template, 'player_test');
  assert.strictEqual(s.chassisMass, 1000);
  assert.deepStrictEqual(s.certifications, ['cert_starships_test']);
  assert.deepStrictEqual(s.attributes, { engineAccel: 35, maxSpeed: 0.5 });
  assert.deepStrictEqual(Object.keys(s.slots), ['reactor', 'engine', 'shield_0', 'armor_0', 'armor_1', 'capacitor', 'weapon_0', 'weapon_1', 'weapon_2']);
  assert.strictEqual(s.slots.weapon_2.ammo_type, 6);
  assert.strictEqual(s.slots.engine.name, 'eng_x');
});

test('parseShipNames + buildShipData: names, factions, missing files', () => {
  const names = `"Rebel",\n{\n\t"Test Deed", "test.iff",\n\t"Ghost Deed", "ghost.iff",\n},\n"Neutral",\n{\n\t"Kimogila Deed, Style 1", "hutt_heavy_s01.iff",\n},`;
  assert.deepStrictEqual(L.parseShipNames(names)[2], { faction: 'freelancer', name: 'Kimogila, Style 1', iff: 'hutt_heavy_s01.iff' });
  const r = L.buildShipData(names, { 'player_test.lua': LUA, 'player_other.lua': LUA });
  assert.deepStrictEqual(r.ships.map((s) => [s.id, s.name, s.faction]), [['test', 'Test', 'rebel']]);
  assert.deepStrictEqual(r.missing, ['Ghost (player_ghost.lua)', 'Kimogila, Style 1 (player_hutt_heavy_s01.lua)']);
  assert.deepStrictEqual(r.unnamed, ['player_other.lua']);
});

test('shipStats: base numbers, then overloads', () => {
  const ship = { id: 'test', ...L.parseShipLua(LUA) };
  const b = C.defaultBuild(ship);
  assert.strictEqual(b.components.reactor.source, 'default');
  let st = C.shipStats(ship, b);
  assert.strictEqual(st.speed, 50); // 100 × 0.5
  assert.strictEqual(st.dps, 150 / 0.5 + 200 / 0.5); // countermeasure left out
  assert.strictEqual(st.gunDrain, 40);
  assert.strictEqual(st.sustain, 500 / 20);
  assert.deepStrictEqual([st.shieldFront, st.shieldBack, st.armorFront, st.armorBack], [900, 1000, 190, 180]);

  b.overloads.engine = { on: true, level: 4 };
  b.overloads.weapon = { on: true, level: 3 }; // ×2 damage, energy value 2.0 = half the drain
  b.overloads.capacitor = { on: true, level: 2 };
  st = C.shipStats(ship, b);
  assert.ok(Math.abs(st.speed - 70) < 1e-9);
  assert.strictEqual(st.dps, 1400);
  assert.strictEqual(st.gunDrain, 20);
  assert.strictEqual(st.capRecharge, 30);
  assert.strictEqual(st.capEnergy, 750); // capacity × 1.5 too
  assert.strictEqual(st.sustain, Infinity);
  assert.strictEqual(C.overloadFactors(b.overloads).engineEnergyUse, 10); // 1 / 0.1
  b.overloads.weapon.on = false; // off = no effect, level remembered
  assert.strictEqual(C.shipStats(ship, b).dps, 700);
  assert.strictEqual(C.overloadEffect('weapon', 4), 'Damage ×3 · energy use ×10');
});

test('massUsage: only parts with a mass count; over-filling is reported', () => {
  const ship = { id: 'test', ...L.parseShipLua(LUA) };
  const b = C.defaultBuild(ship);
  assert.deepStrictEqual(C.massUsage(ship, b), { used: 0, max: 1000, known: 0, total: 9, over: 0, pct: 0 }); // the empty droid slot doesn't count
  b.components.reactor.mass = 700;
  b.components.engine.mass = 500;
  const m = C.massUsage(ship, b);
  assert.strictEqual(m.over, 200);
  assert.strictEqual(m.pct, 1.2);
});

test('data/swg-ships.json: every named ship has the core slots', () => {
  const { ships } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'swg-ships.json'), 'utf8'));
  assert.ok(ships.length > 0);
  for (const s of ships) {
    for (const k of ['reactor', 'engine', 'shield_0', 'capacitor', 'weapon_0']) assert.ok(s.slots[k], s.id + ' has ' + k);
    assert.ok(['rebel', 'imperial', 'freelancer'].includes(s.faction));
  }
});

test('every ship gets a droid interface slot, empty, before the weapons', () => {
  const ship = { id: 'test', ...L.parseShipLua(LUA) };
  const b = C.defaultBuild(ship);
  assert.deepStrictEqual(b.components.droid_interface, { source: 'empty' });
  assert.deepStrictEqual(Object.keys(b.components).slice(5, 8), ['capacitor', 'droid_interface', 'weapon_0']);
  // an old build gets the slots it lacks (stock parts, chassis order); its own parts stay
  const old = { ship: 'test', components: { reactor: { name: 'mine' }, weapon_0: { name: 'gun' } } };
  const fixed = C.ensureSlots(ship, old).components;
  assert.deepStrictEqual(Object.keys(fixed), ['reactor', 'engine', 'shield_0', 'armor_0', 'armor_1', 'capacitor', 'droid_interface', 'weapon_0', 'weapon_1', 'weapon_2']);
  assert.strictEqual(fixed.reactor.name, 'mine');
  assert.strictEqual(fixed.engine.source, 'default');
  const has = { ship: 'test', components: { droid_interface: { name: 'ddi_x', source: 'loot' } } };
  assert.strictEqual(C.ensureSlots(ship, has).components.droid_interface.name, 'ddi_x');
  // removed parts are empty: no stats, not counted for mass
  b.components.engine = { source: 'empty' };
  assert.strictEqual(C.shipStats(ship, b).speed, null);
  assert.strictEqual(C.massUsage(ship, b).total, 8);
});

test('reactor load: engine and weapon overloads multiply their energy required', () => {
  const ship = { id: 'test', ...L.parseShipLua(LUA) };
  const b = C.defaultBuild(ship);
  b.components.engine.energyMaintenance = 100;
  b.components.weapon_0.energyMaintenance = 50;
  b.components.shield_0.energyMaintenance = 30;
  assert.strictEqual(C.shipStats(ship, b).energyUse, 180);
  b.overloads.engine = { on: true, level: 2 }; // energy value 0.6 → ×1/0.6
  b.overloads.weapon = { on: true, level: 4 }; // 0.1 → ×10
  const st = C.shipStats(ship, b);
  assert.ok(Math.abs(st.energyUse - (100 / 0.6 + 500 + 30)) < 1e-9);
  assert.strictEqual(st.gunDrain, (10 * 10) / 0.5 + (10 * 10) / 0.5); // energy per shot too
});

test('DPS vs shields / armor: each gun\u2019s DPS × its own effectiveness', () => {
  const ship = { id: 'test', ...L.parseShipLua(LUA) };
  const b = C.defaultBuild(ship);
  b.components.weapon_0.shieldEfficiency = 0.6;
  b.components.weapon_0.armorEfficiency = 0.8;
  b.components.weapon_1.shieldEfficiency = 0.5;
  b.components.weapon_1.armorEfficiency = 0.5;
  const st = C.shipStats(ship, b); // gun DPS 300 and 400
  assert.ok(Math.abs(st.dpsShields - (300 * 0.6 + 400 * 0.5)) < 1e-9);
  assert.ok(Math.abs(st.dpsArmor - (300 * 0.8 + 400 * 0.5)) < 1e-9);
});

test('ship fixes: empty ordnance slots, the Dunelizard\u2019s second gun, turrets', () => {
  const { ships } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'swg-ships.json'), 'utf8'));
  const byId = (id) => ships.find((s) => s.id === id);
  const layout = (s) => Object.entries(s.slots).filter(([k]) => k.startsWith('weapon')).map(([k, v]) => k + ':' + (v.empty ? v.launcher : C.weaponKind(v)));
  assert.deepStrictEqual(layout(byId('tieaggressor')), ['weapon_0:gun', 'weapon_1:gun', 'weapon_2:missile', 'weapon_3:countermeasure']);
  assert.deepStrictEqual(layout(byId('hutt_light_s01')), ['weapon_0:gun', 'weapon_1:missile', 'weapon_2:countermeasure']);
  assert.deepStrictEqual(layout(byId('hutt_heavy_s02')), ['weapon_0:gun', 'weapon_1:gun', 'weapon_2:gun', 'weapon_3:missile', 'weapon_4:countermeasure']);
  assert.deepStrictEqual(layout(byId('hutt_medium_s01')), ['weapon_0:gun', 'weapon_1:gun', 'weapon_2:missile', 'weapon_3:countermeasure']);
  // an empty ordnance slot starts empty in a new build
  assert.deepStrictEqual(C.defaultBuild(byId('tieaggressor')).components.weapon_2, { source: 'empty' });
  // turrets (weapon index from ship_turret.lua = slot number)
  const t = Object.fromEntries(ships.filter((s) => s.turrets).map((s) => [s.id, s.turrets]));
  assert.deepStrictEqual(t, {
    ykl37r: ['weapon_0', 'weapon_1'], ywing: ['weapon_1'], decimator: ['weapon_0', 'weapon_1'],
    tieaggressor: ['weapon_1'], hutt_turret_ship: ['weapon_1'], yt1300: ['weapon_0', 'weapon_1'],
  });
  // a Dunelizard build saved before the fix gets the new slots
  const dl = byId('hutt_medium_s01');
  const old = { ship: dl.id, components: { weapon_0: { name: 'x', source: 'loot' }, weapon_2: { name: 'wpn_std_countermeasure', source: 'default' } } };
  assert.deepStrictEqual(Object.keys(C.ensureSlots(dl, old).components).filter((k) => k.startsWith('weapon')), ['weapon_0', 'weapon_1', 'weapon_2', 'weapon_3']);
});

test('ship fixes: the X-wing gets its missing third blaster in weapon_2, before ordnance', () => {
  const { ships } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'swg-ships.json'), 'utf8'));
  const x = ships.find((s) => s.id === 'xwing');
  const weapons = Object.keys(x.slots).filter((k) => k.startsWith('weapon'));
  assert.deepStrictEqual(weapons, ['weapon_0', 'weapon_1', 'weapon_2', 'weapon_3', 'weapon_4']);
  assert.deepStrictEqual(weapons.map((k) => C.weaponKind(x.slots[k])), ['gun', 'gun', 'gun', 'missile', 'countermeasure']);
  assert.strictEqual(x.slots.weapon_2.name, 'wpn_incom_blaster');
  const fixed = L.applyFixes({ id: 'xwing', slots: { weapon_0: { name: 'a' }, weapon_1: { name: 'b' }, weapon_3: { name: 'm' } } });
  assert.deepStrictEqual(Object.keys(fixed.slots), ['weapon_0', 'weapon_1', 'weapon_2', 'weapon_3']);
});
