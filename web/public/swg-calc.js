/*
 * SWG ship builder — stat math.
 *
 * Runs in the browser (window.SwgCalc) and in Node (require) so it can be tested.
 *
 * A build is { ship: id, overloads: { reactor|engine|capacitor|weapon: { on, level } },
 * components: { slot: { name, source, ...stats } } }.
 *
 * The formulas in shipStats() are a first pass: one place to change when the stat table
 * gets its final definition.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SwgCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // overload.txt — values per level 1 / 2 / 3 / 4
  const OVERLOADS = {
    reactor: { label: 'Reactor', output: [1.1, 1.3, 1.6, 1.9] },
    engine: { label: 'Engine', speed: [1.1, 1.2, 1.3, 1.4], energy: [1, 0.6, 0.3, 0.1] },
    capacitor: { label: 'Capacitor', efficiency: [1.25, 1.5, 1.75, 2] },
    weapon: { label: 'Weapon', damage: [1.25, 1.5, 2, 3], energy: [0.7, 0.5, 2.0, 0.1] },
  };
  const OVERLOAD_KEYS = Object.keys(OVERLOADS);

  /** Plain-words summary of one overload level, for the overload panel. */
  function overloadEffect(key, level) {
    const o = OVERLOADS[key];
    const i = level - 1;
    const x = (v) => '×' + round(v, 2);
    if (key === 'reactor') return 'Energy output ' + x(o.output[i]);
    if (key === 'engine') return 'Speed +' + Math.round((o.speed[i] - 1) * 100) + '% · energy use ' + x(1 / o.energy[i]);
    if (key === 'capacitor') return 'Efficiency ' + x(o.efficiency[i]) + ' · no extra drain';
    if (key === 'weapon') return 'Damage ' + x(o.damage[i]) + ' · energy use ' + x(1 / o.energy[i]);
    return '';
  }

  /** Multipliers in effect for a build's overloads (1 = no change). */
  function overloadFactors(overloads) {
    const lvl = (k) => {
      const o = overloads && overloads[k];
      return o && o.on && o.level >= 1 && o.level <= 4 ? o.level - 1 : -1;
    };
    const pick = (arr, i) => (i < 0 ? 1 : arr[i]);
    const r = lvl('reactor'), e = lvl('engine'), c = lvl('capacitor'), w = lvl('weapon');
    return {
      reactorOutput: pick(OVERLOADS.reactor.output, r),
      engineSpeed: pick(OVERLOADS.engine.speed, e),
      engineEnergyUse: 1 / pick(OVERLOADS.engine.energy, e), // the file lists divisors
      capacitorEfficiency: pick(OVERLOADS.capacitor.efficiency, c),
      weaponDamage: pick(OVERLOADS.weapon.damage, w),
      weaponEnergyUse: 1 / pick(OVERLOADS.weapon.energy, w),
    };
  }

  function emptyOverloads() {
    const o = {};
    for (const k of OVERLOAD_KEYS) o[k] = { on: false, level: 1 };
    return o;
  }

  /** Slot key → kind ('shield_0' → 'shield') */
  const slotKind = (slot) => slot.replace(/_\d+$/, '');

  function weaponKind(c) {
    const n = String((c && c.name) || '');
    if (/countermeasure/i.test(n)) return 'countermeasure';
    if (/missile|torpedo|rocket/i.test(n)) return 'missile';
    return 'gun';
  }

  /** A new build for a ship: every slot gets the ship's default (character builder) part. */
  function defaultBuild(ship) {
    const components = {};
    for (const [slot, c] of Object.entries(ship.slots)) components[slot] = { ...c, source: 'default' };
    return ensureSlots(ship, { ship: ship.id, overloads: emptyOverloads(), components });
  }

  /**
   * Every ship gets a droid interface slot (empty unless its chassis lists a part), placed
   * before the weapons. Also fixes up builds saved before the slot existed.
   */
  function ensureSlots(ship, build) {
    if (build.components.droid_interface) return build;
    const out = {};
    let added = false;
    for (const [slot, c] of Object.entries(build.components)) {
      if (!added && slotKind(slot) === 'weapon') {
        out.droid_interface = { source: 'empty' };
        added = true;
      }
      out[slot] = c;
    }
    if (!added) out.droid_interface = { source: 'empty' };
    build.components = out;
    return build;
  }
  const isEmpty = (c) => !c || c.source === 'empty';

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const has = (v) => typeof v === 'number' && Number.isFinite(v);

  function round(v, d) {
    const p = Math.pow(10, d);
    return Math.round(v * p) / p;
  }

  /** Mass used by the components vs. the chassis' maximum mass. */
  function massUsage(ship, build) {
    let used = 0;
    let known = 0;
    let total = 0;
    for (const c of Object.values(build.components || {})) {
      if (isEmpty(c)) continue;
      total++;
      if (has(c.mass)) {
        used += c.mass;
        known++;
      }
    }
    const max = num(ship.chassisMass);
    return { used, max, known, total, over: Math.max(0, used - max), pct: max > 0 ? used / max : 0 };
  }

  /**
   * The summary stats. Each value is null when the parts in the build don't provide it.
   */
  function shipStats(ship, build) {
    const f = overloadFactors(build.overloads);
    const comps = build.components || {};
    const bySlot = (k) => comps[k] || null;
    const ofKind = (kind) => Object.entries(comps).filter(([s]) => slotKind(s) === kind).map(([, c]) => c);
    const attr = ship.attributes || {};

    const engine = bySlot('engine');
    const booster = bySlot('booster');
    const cap = bySlot('capacitor');
    const reactor = bySlot('reactor');
    const shields = ofKind('shield');
    const armors = ofKind('armor');
    const weapons = ofKind('weapon');

    const speedMod = has(attr.maxSpeed) ? attr.maxSpeed : 1;
    const speed = engine && has(engine.speed) ? engine.speed * speedMod * f.engineSpeed : null;

    // guns: average damage per shot / seconds between shots
    let dps = 0, gunDrain = 0, guns = 0;
    for (const w of weapons) {
      if (weaponKind(w) !== 'gun' || !(num(w.rate) > 0)) continue;
      guns++;
      const avg = (num(w.minDamage) + num(w.maxDamage)) / 2;
      dps += (avg * f.weaponDamage) / w.rate;
      gunDrain += (num(w.drain) * f.weaponEnergyUse) / w.rate;
    }

    const capEnergy = cap && has(cap.energy) ? cap.energy : null;
    const capRecharge = cap && has(cap.rechargeRate) ? cap.rechargeRate * f.capacitorEfficiency : null;
    let sustain = null; // seconds of continuous fire before the capacitor runs dry
    if (guns && capEnergy != null && capRecharge != null) sustain = gunDrain > capRecharge ? capEnergy / (gunDrain - capRecharge) : Infinity;

    const sum = (list, key) => (list.some((c) => has(c[key])) ? list.reduce((a, c) => a + num(c[key]), 0) : null);
    const armorFront = armors[0] && has(armors[0].armor) ? armors[0].armor : null;
    const armorBack = armors[1] && has(armors[1].armor) ? armors[1].armor : null;
    const reactorOut = reactor && has(reactor.energyGeneration) ? reactor.energyGeneration * f.reactorOutput : null;
    // energy the components need to run; the engine overload multiplies the engine's
    let energyUse = null;
    for (const [slot, c] of Object.entries(comps)) {
      if (!has(c.energyMaintenance)) continue;
      energyUse = (energyUse || 0) + c.energyMaintenance * (slot === 'engine' ? f.engineEnergyUse : 1);
    }

    return {
      speed,
      boostSpeed: speed != null && booster && has(booster.speed) ? speed + booster.speed : null,
      acceleration: engine && has(engine.acceleration) ? engine.acceleration : null,
      deceleration: engine && has(engine.deceleration) ? engine.deceleration : null,
      pitchRate: engine && has(engine.pitchRate) ? engine.pitchRate : null,
      yawRate: engine && has(engine.yawRate) ? engine.yawRate : null,
      rollRate: engine && has(engine.rollRate) ? engine.rollRate : null,
      chassisHitpoints: has(ship.chassisHitpoints) ? ship.chassisHitpoints : null,
      armorFront,
      armorBack,
      shieldFront: sum(shields, 'front'),
      shieldBack: sum(shields, 'back'),
      shieldRegen: sum(shields, 'regen'),
      reactorOutput: reactorOut,
      energyUse,
      capEnergy,
      capRecharge,
      dps: guns ? dps : null,
      gunDrain: guns ? gunDrain : null,
      sustain,
      boosterEnergy: booster && has(booster.energy) ? booster.energy : null,
      boosterUse: booster && has(booster.energyUsage) ? booster.energyUsage : null,
      factors: f,
    };
  }

  return { OVERLOADS, OVERLOAD_KEYS, overloadEffect, overloadFactors, emptyOverloads, defaultBuild, ensureSlots, isEmpty, shipStats, massUsage, slotKind, weaponKind, round };
});
