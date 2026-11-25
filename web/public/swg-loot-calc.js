/*
 * SWG Loot page — the math. Browser: window.SwgLoot · Node: require().
 *
 * Roll model (server: LootValues::getNormalValue + LootAttributeType):
 *   every ship component stat except reverseengineeringlevel is NORMAL:
 *     dist  = ((Z · 0.5 / 2.82333) + 1) · 0.5        Z ~ standard normal
 *     value = lo + (hi − lo) · dist, clamped to [lo, hi]   (lo/hi = the listed min/max, sorted)
 *   so the position in the range is normal with mean 0.5 and σ = 1 / (4 · 2.82333) ≈ 0.0885.
 *   Weapon min/max damage are then both set to the average of their two positions
 *   (LootValues::setDamageValues), so their σ is σ/√2 and they move together.
 *   Stats with precision 0 are rounded to whole numbers.
 *
 * Values are kept in display units: refire rate and weapon effectiveness are stored ×1000 in the
 * loot files and shown ×0.001 in game (ShipWeaponComponent), so they are scaled here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SwgLoot = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DISTNORMAL = 2.82333;
  const SIGMA = 1 / (4 * DISTNORMAL);

  // stat key (loot file name without "ship_component_") → how to show and use it
  // lower: smaller is better · scale: file value → display value · ship: field on the ship builder part
  const STATS = {
    reactor_generation_rate: { label: 'Energy generation', ship: 'energyGeneration' },
    engine_speed_maximum: { label: 'Top speed', ship: 'speed' },
    engine_pitch_rate_maximum: { label: 'Pitch rate', ship: 'pitchRate' },
    engine_yaw_rate_maximum: { label: 'Yaw rate', ship: 'yawRate' },
    engine_roll_rate_maximum: { label: 'Roll rate', ship: 'rollRate' },
    shield_hitpoints_front: { label: 'Front shield HP', ship: 'front' },
    shield_hitpoints_back: { label: 'Back shield HP', ship: 'back' },
    shield_recharge_rate: { label: 'Shield recharge', ship: 'regen' },
    capacitor_energy: { label: 'Capacitor energy', ship: 'energy' },
    capacitor_energy_recharge_rate: { label: 'Recharge rate', ship: 'rechargeRate' },
    booster_energy: { label: 'Booster energy', ship: 'energy' },
    booster_energy_recharge_rate: { label: 'Recharge rate', ship: 'rechargeRate' },
    booster_energy_consumption_rate: { label: 'Energy consumption', ship: 'energyUsage', lower: true },
    booster_acceleration: { label: 'Acceleration', ship: 'acceleration' },
    booster_speed_maximum: { label: 'Top boost speed', ship: 'speed' },
    weapon_damage_minimum: { label: 'Min damage', ship: 'minDamage', damage: true },
    weapon_damage_maximum: { label: 'Max damage', ship: 'maxDamage', damage: true },
    weapon_effectiveness_shields: { label: 'Vs shields', ship: 'shieldEfficiency', scale: 0.001 },
    weapon_effectiveness_armor: { label: 'Vs armor', ship: 'armorEfficiency', scale: 0.001 },
    weapon_energy_per_shot: { label: 'Energy / shot', ship: 'drain', lower: true },
    weapon_refire_rate: { label: 'Refire rate (s)', ship: 'rate', lower: true, scale: 0.001 },
    droidinterface_speed: { label: 'Command speed', ship: 'droidSpeed', lower: true },
    hitpoints: { label: 'Hitpoints', ship: 'hitpoints' },
    armor: { label: 'Armor', ship: 'armor' },
    energy_required: { label: 'Energy required', ship: 'energyMaintenance', lower: true },
    mass: { label: 'Mass', ship: 'mass', lower: true },
  };
  const STAT_ORDER = Object.keys(STATS);

  const TYPES = {
    reactor: { label: 'Reactor', slot: 'reactor' },
    engine: { label: 'Engine', slot: 'engine' },
    shield_generator: { label: 'Shield generator', slot: 'shield' },
    armor: { label: 'Armor', slot: 'armor' },
    weapon_capacitor: { label: 'Capacitor', slot: 'capacitor' },
    booster: { label: 'Booster', slot: 'booster' },
    droid_interface: { label: 'Droid interface', slot: 'droid_interface' },
    weapon: { label: 'Weapon', slot: 'weapon' },
  };
  const TYPE_KEYS = Object.keys(TYPES);
  const typeForSlot = (slot) => TYPE_KEYS.find((t) => TYPES[t].slot === String(slot).replace(/_\d+$/, '')) || null;

  // RE project bonus by reverse engineering level
  function reBonus(level) {
    if (level >= 10) return 0.06;
    if (level >= 8) return 0.05;
    if (level >= 6) return 0.04;
    if (level >= 4) return 0.03;
    if (level >= 2) return 0.02;
    return level >= 1 ? 0.01 : 0;
  }

  // ---------- normal distribution ----------
  function erf(x) {
    // Abramowitz–Stegun 7.1.26 is too coarse for 1-in-a-million tails; use a series / continued fraction
    const s = Math.sign(x);
    x = Math.abs(x);
    if (x < 3) {
      let sum = x, term = x;
      for (let n = 1; n < 100; n++) {
        term *= (-x * x) / n;
        const t = term / (2 * n + 1);
        sum += t;
        if (Math.abs(t) < 1e-17) break;
      }
      return (s * 2 * sum) / Math.sqrt(Math.PI);
    }
    return s * (1 - erfcLarge(x));
  }
  function erfcLarge(x) {
    // continued fraction (Lentz), good for x >= 3
    let f = x, C = x, D = 0;
    for (let n = 1; n < 200; n++) {
      const a = n / 2;
      D = x + a * D;
      D = D === 0 ? 1e-300 : 1 / D;
      C = x + a / C;
      const d = C * D;
      f *= d;
      if (Math.abs(d - 1) < 1e-15) break;
    }
    return Math.exp(-x * x) / (Math.sqrt(Math.PI) * f);
  }
  /** P(Z > z) for a standard normal */
  function upperTail(z) {
    const x = z / Math.SQRT2;
    if (x > 3) return 0.5 * erfcLarge(x);
    if (x < -3) return 1 - 0.5 * erfcLarge(-x);
    return 0.5 * (1 - erf(x));
  }
  function density(z) {
    return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  }

  // ---------- one item's stat ----------
  const round = (v, d) => {
    const p = Math.pow(10, d);
    return Math.round(v * p) / p;
  };

  /** Display decimals for a stat (from the file's precision, adjusted for the display scale). */
  function decimals(key, precision) {
    const sc = (STATS[key] && STATS[key].scale) || 1;
    if (sc === 0.001) return 3;
    return precision === 0 ? 0 : Math.max(1, Math.min(precision, 2));
  }

  /** An item's stat in display units: { lo, hi, prec, step, lower, sigma } (null if the item lacks it) */
  function itemStat(item, key) {
    const raw = item.stats[key];
    if (!raw) return null;
    const meta = STATS[key] || {};
    const sc = meta.scale || 1;
    const a = raw[0] * sc, b = raw[1] * sc;
    return {
      lo: Math.min(a, b),
      hi: Math.max(a, b),
      prec: raw[2],
      step: raw[2] === 0 ? sc : 0, // whole-number rounding, in display units
      lower: !!meta.lower,
      sigma: meta.damage ? SIGMA / Math.SQRT2 : SIGMA,
    };
  }

  /** P(this item's stat rolls as good as v or better). */
  function tailProb(st, v) {
    if (!st) return 0;
    if (st.hi - st.lo < 1e-9) return st.lower ? (st.lo <= v + 1e-9 ? 1 : 0) : st.lo >= v - 1e-9 ? 1 : 0;
    // whole-number stats: value = round(...) → the boundary sits half a step away
    const h = st.step / 2;
    const x = ((st.lower ? v + h : v - h) - st.lo) / (st.hi - st.lo); // position in [0,1] of the boundary
    const z = (x - 0.5) / st.sigma;
    if (st.lower) return x >= 1 ? 1 : x < 0 ? 0 : 1 - upperTail(z);
    return x <= 0 ? 1 : x > 1 ? 0 : upperTail(z);
  }

  /** Probability density of the stat at value v (per display unit). */
  function densityAt(st, v) {
    if (!st || st.hi - st.lo < 1e-9) return 0;
    const x = (v - st.lo) / (st.hi - st.lo);
    if (x < 0 || x > 1) return 0;
    return density((x - 0.5) / st.sigma) / (st.sigma * (st.hi - st.lo));
  }

  // ---------- loot tables ----------
  function makeDropIndex(data) {
    const cache = new Map();
    /** Map(itemIndex → chance per roll of the table) */
    function tableProbs(table) {
      if (cache.has(table)) return cache.get(table);
      const t = data.tables[table];
      const out = new Map();
      if (t) {
        for (const [gname, p] of t.g) for (const [idx, q] of data.groups[gname] || []) out.set(idx, (out.get(idx) || 0) + p * q);
        for (const [idx, p] of t.i) out.set(idx, (out.get(idx) || 0) + p);
      }
      cache.set(table, out);
      return out;
    }
    return { tableProbs };
  }

  /** P(one kill of the NPC drops at least one of the given items) */
  function killChance(npc, probs, itemIdxs) {
    let q = 0;
    for (const i of itemIdxs) q += probs.get(i) || 0;
    const perRoll = npc.chance * q;
    return 1 - Math.pow(1 - perRoll, npc.rolls || 1);
  }

  /**
   * P(one kill drops one of `items` with stat `key` at least as good as v)
   * weights: Map(itemIndex → chance per roll)
   */
  function statKillChance(npc, weights, items, key, v) {
    let p = 0;
    for (const [idx, it] of items) p += (weights.get(idx) || 0) * tailProb(itemStat(it, key), v);
    return 1 - Math.pow(1 - npc.chance * p, npc.rolls || 1);
  }

  /** Same, for several stats at once (each item's stats roll independently, damage min/max together). */
  function jointKillChance(npc, weights, items, values) {
    let p = 0;
    const keys = Object.keys(values);
    for (const [idx, it] of items) {
      let q = weights.get(idx) || 0;
      if (!q) continue;
      let dmg = null;
      for (const k of keys) {
        const st = itemStat(it, k);
        if (!st) { q = 0; break; }
        const t = tailProb(st, values[k]);
        if (STATS[k] && STATS[k].damage) dmg = dmg == null ? t : Math.min(dmg, t);
        else q *= t;
      }
      if (dmg != null) q *= dmg;
      p += q;
    }
    return 1 - Math.pow(1 - npc.chance * p, npc.rolls || 1);
  }

  /** Is v a value this item can roll for the stat? */
  function canRoll(st, v) {
    if (!st) return false;
    const tol = Math.max(st.step / 2, (st.hi - st.lo) * 1e-6, 1e-9);
    return v >= st.lo - tol && v <= st.hi + tol;
  }

  /** Range of a stat over items: { lo, hi, worst, best } */
  function statRange(items, key) {
    let lo = Infinity, hi = -Infinity, lower = false;
    for (const it of items) {
      const st = itemStat(it, key);
      if (!st) continue;
      lo = Math.min(lo, st.lo);
      hi = Math.max(hi, st.hi);
      lower = st.lower;
    }
    if (lo > hi) return null;
    return { lo, hi, worst: lower ? hi : lo, best: lower ? lo : hi, lower };
  }

  /** "1 in 1,234" */
  function oneIn(p) {
    if (!(p > 0)) return 'never';
    const n = 1 / p;
    if (n < 1.005) return 'always';
    if (n < 10) return '1 in ' + round(n, 1);
    if (n >= 1e12) return '1 in ' + n.toExponential(1).replace('e+', '×10^');
    return '1 in ' + Math.round(n).toLocaleString('en-US');
  }

  // ---------- RE projects ----------
  /**
   * components: [{ values: { stat: value }, typical: { stat: value } }] → best value per stat
   * (lowest for "lower is better" stats), then the RE bonus: higher-is-better stats × (1 + bonus),
   * lower-is-better × (1 − bonus). A stat no component has a value entered for falls back to the
   * best typical roll (middle of the range) and is listed in `estimated`.
   * → { values: { stat: value | null }, estimated: [stat] }
   */
  function projectSummary(type, level, components) {
    const keys = statKeysForType(type, components.flatMap((c) => [{ values: c.values }, { values: c.typical }]));
    const bonus = reBonus(level);
    const values = {};
    const estimated = [];
    const bestOf = (k, field) => {
      const lower = !!(STATS[k] && STATS[k].lower);
      let best = null;
      for (const c of components) {
        const v = c[field] && c[field][k];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        if (best == null || (lower ? v < best : v > best)) best = v;
      }
      return best == null ? null : best * (lower ? 1 - bonus : 1 + bonus);
    };
    for (const k of keys) {
      values[k] = bestOf(k, 'values');
      if (values[k] == null) {
        values[k] = bestOf(k, 'typical');
        if (values[k] != null) estimated.push(k);
      }
    }
    return { values, estimated };
  }

  /** The stats a component type has, in display order. */
  function statKeysForType(type, itemsOrComponents) {
    const seen = new Set();
    for (const x of itemsOrComponents || []) for (const k of Object.keys(x.stats || x.values || {})) seen.add(k);
    return STAT_ORDER.filter((k) => seen.has(k));
  }

  /** Display-unit stat values → the part fields the ship builder uses. */
  function toShipFields(type, values) {
    const out = {};
    for (const [k, v] of Object.entries(values || {})) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const f = STATS[k] && STATS[k].ship;
      if (f) out[f] = v;
    }
    if (type === 'engine' && out.speed != null) {
      // ShipEngineComponent: acceleration = 0.8 × top speed, deceleration = 0.6 × top speed
      out.acceleration = round(out.speed * 0.8, 3);
      out.deceleration = round(out.speed * 0.6, 3);
    }
    return out;
  }

  const prettyId = (id) =>
    String(id || '')
      .replace(/^(rct|eng|shd|arm|cap|bst|wpn|ddi)_/, '')
      .replace(/_/g, ' ')
      .replace(/\b(mk|tier)(\d)/gi, (m, a, d) => a + ' ' + d)
      .replace(/\b\w/g, (c) => c.toUpperCase());

  return {
    SIGMA, STATS, STAT_ORDER, TYPES, TYPE_KEYS, typeForSlot, reBonus, upperTail, itemStat, tailProb, densityAt,
    makeDropIndex, killChance, statKillChance, jointKillChance, canRoll, statRange, oneIn, decimals,
    projectSummary, statKeysForType, toShipFields, prettyId, round,
  };
});
