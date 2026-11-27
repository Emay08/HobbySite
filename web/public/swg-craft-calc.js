/*
 * SWG Crafting page — the math. Browser: window.SwgCraft · Node: require().
 *
 * Follows the server (Core3 / NFS: ResourceLabratory, SharedLabratory, CraftingValues,
 * AttributesMap, ComponentImplementation, ArmorComponentImplementation, ArmorObjectImplementation):
 *
 * 1. Resource averages. For each resource stat (OQ, SR, UT, …) the average over the schematic's
 *    resource slots, weighted by each slot's quantity. A resource that doesn't have the stat
 *    (value 0) is left out of that stat's average.
 *
 * 2. Each attribute of the target (e.g. min damage, armor effectiveness) has a weight list like
 *    OQ 1, SR 1 → shares 50 % / 50 %. weightedSum = Σ share × average(stat)   (0–1000)
 *      max %      = weightedSum / 1000                       (the experimentation cap)
 *      assembly % = weightedSum × (0.000015 × weightedSum + 0.015) / 100 × assembly modifier
 *                   capped at max %
 *    assembly modifier: Amazing 1.05 · Great 1.0 · Good 0.9 · Moderate 0.8 · Success 0.7 ·
 *    Marginal 0.6 · OK 0.5 · Barely 0.4   (1.1 − 0.1 × result)
 *
 * 3. value = min + % × (max − min)   (when max < min, lower is better and it runs the other way;
 *    the formula gives the same thing). No resource weights → the value is min.
 *
 * 4. Components. For every filled component slot, the FIRST component in it (identical slots need
 *    identical components anyway) adds each of its properties × the slot's contribution:
 *      linear (1)     value, min and max all move by it — the % stays, so experimentation
 *                     keeps working on the shifted range
 *      percentage (2) added to the %  · bitset (3) OR'd in · override (4) ignored
 *      limited (5)    added to the value, clamped to min/max
 *    A property the target doesn't have is added as a fixed value (it can't be experimented).
 *    Then the values are recalculated from the % (unless the last property handled was a
 *    "limited" one — a server quirk, kept). Clothing (not armor) only takes skill mods from
 *    components, which this page doesn't model, so components don't change clothing stats.
 *
 * 5. Experimentation. Every point spent on a row adds to the % of every attribute in that row:
 *    Amazing +8 % · Great +7 % · Good +5.5 % · Moderate +1.5 % · Success +1 % · Marginal 0 ·
 *    OK −4 % · Barely −7 % · Critical failure −8 %, never above max % or below 0.
 *
 * 6. A finished component keeps every attribute as a property. Armor layers/segments also get
 *    "<type>effectiveness" = special effectiveness (+ the same type from their own layers) for
 *    each type in their special-type bits.
 *
 * 7. Armor pieces: base protection = armor effectiveness; special protection = special
 *    effectiveness when it has a range, else armor effectiveness. Per damage type: vulnerable →
 *    only what layers added; special → special + added; else base + added; capped at 80.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SwgCraft = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LINEAR = 1;
  const PERCENTAGE = 2;
  const BITSET = 3;
  const OVERRIDE = 4;
  const LIMITED = 5;

  const STATS = {
    OQ: 'Overall Quality',
    SR: 'Shock Resistance',
    UT: 'Unit Toughness',
    MA: 'Malleability',
    PE: 'Potential Energy',
    CD: 'Conductivity',
    DR: 'Decay Resistance',
    HR: 'Heat Resistance',
    CR: 'Cold Resistance',
    FL: 'Flavor',
    BK: 'Entangle Resistance',
  };
  const STAT_ORDER = ['OQ', 'CD', 'SR', 'UT', 'MA', 'PE', 'DR', 'HR', 'CR', 'FL', 'BK'];

  // assembly results (CraftingManager): index = server value
  const ASSEMBLY = [
    { label: 'Amazing success', mod: 1.05 },
    { label: 'Great success', mod: 1.0 },
    { label: 'Good success', mod: 0.9 },
    { label: 'Moderate success', mod: 0.8 },
    { label: 'Success', mod: 0.7 },
    { label: 'Marginal success', mod: 0.6 },
    { label: 'OK', mod: 0.5 },
    { label: 'Barely successful', mod: 0.4 },
  ];
  const EXPERIMENT = [
    { label: 'Amazing success', per: 0.08 },
    { label: 'Great success', per: 0.07 },
    { label: 'Good success', per: 0.055 },
    { label: 'Moderate success', per: 0.015 },
    { label: 'Success', per: 0.01 },
    { label: 'Marginal success', per: 0 },
    { label: 'OK', per: -0.04 },
    { label: 'Barely successful', per: -0.07 },
    { label: 'Critical failure', per: -0.08 },
  ];

  const DAMAGE = [
    [1, 'kinetic', 'Kinetic'],
    [2, 'energy', 'Energy'],
    [4, 'blast', 'Blast'],
    [8, 'stun', 'Stun'],
    [16, 'restraint', 'Restraint'],
    [32, 'heat', 'Heat'],
    [64, 'cold', 'Cold'],
    [128, 'acid', 'Acid'],
    [256, 'electrical', 'Electricity'],
  ];
  const effKey = (word) => word + 'effectiveness';

  const LABELS = {
    mindamage: 'Min damage',
    maxdamage: 'Max damage',
    attackspeed: 'Attack speed',
    woundchance: 'Wound chance',
    hitpoints: 'Condition',
    hit_points: 'Condition',
    hitpointsmax: 'Max condition',
    zerorangemod: 'Point blank accuracy',
    midrangemod: 'Mid range accuracy',
    maxrangemod: 'Max range accuracy',
    midrange: 'Mid range',
    maxrange: 'Max range',
    attackhealthcost: 'Health attack cost',
    attackactioncost: 'Action attack cost',
    attackmindcost: 'Mind attack cost',
    roundsused: 'Rounds used',
    forcecost: 'Force cost',
    armor_effectiveness: 'Base effectiveness',
    armor_integrity: 'Integrity',
    armor_health_encumbrance: 'Health encumbrance',
    armor_action_encumbrance: 'Action encumbrance',
    armor_mind_encumbrance: 'Mind encumbrance',
    armor_special_effectiveness: 'Special effectiveness',
    armor_special_integrity: 'Special integrity',
    armor_special_type: 'Special type',
    armor_rating: 'Armor rating',
    skillmodmin: 'Skill required',
    usemodifier: 'Use modifier',
    useCount: 'Uses',
    xp: 'XP',
    complexity: 'Complexity',
  };
  for (const [, w, l] of DAMAGE) LABELS[effKey(w)] = l + ' effectiveness';

  const titleCase = (s) =>
    String(s)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^./, (c) => c.toUpperCase());
  const attrLabel = (name) => LABELS[name] || titleCase(String(name).replace(/^ship_component_/, '').replace(/^res_/, 'resource '));
  const groupLabel = (g) => (!g || g === 'null' ? '' : titleCase(String(g).replace(/^exp_?/i, '').replace(/^Effeciency$/, 'Efficiency')));
  const slotLabel = (t) => titleCase(String(t).replace(/^[a-z_]+_n:/, ''));
  const resourceLabel = (r) => titleCase(r);

  /** Which stats any attribute of a target reads. */
  function relevantStats(target) {
    const seen = new Set();
    for (const a of target.a) for (const [s] of a[6]) seen.add(s);
    return STAT_ORDER.filter((s) => seen.has(s)).concat([...seen].filter((s) => !STAT_ORDER.includes(s)));
  }

  /**
   * Resource averages. resources: per slot index → { OQ: 900, … } (only resource slots are read).
   * uniform: a number → every stat average is that number (the "one value for everything" mode).
   */
  function averages(schematic, resources, uniform) {
    const out = {};
    if (uniform != null) {
      for (const s of STAT_ORDER) out[s] = Number(uniform) || 0;
      return out;
    }
    const sum = {};
    const n = {};
    schematic.s.forEach((slot, i) => {
      if (slot[1] !== 0) return;
      const r = (resources && resources[i]) || {};
      for (const [stat, v] of Object.entries(r)) {
        const x = Number(v);
        if (!x) continue;
        sum[stat] = (sum[stat] || 0) + x * slot[3];
        n[stat] = (n[stat] || 0) + slot[3];
      }
    });
    for (const s of Object.keys(sum)) out[s] = sum[s] / n[s];
    return out;
  }

  const valueOf = (a) => {
    if (a.group === '') return Math.max(a.min, a.max);
    if (a.max === a.min) return a.max;
    if (a.max > a.min) return a.pct * (a.max - a.min) + a.min;
    return (1 - a.pct) * (a.min - a.max) + a.max;
  };
  const clampPct = (a, p) => Math.max(0, Math.min(a.maxPct, p));

  /**
   * Craft one item.
   *   schematic, target: from the data file
   *   opts: {
   *     resources: { slotIndex: { stat: value } },  uniform: number (instead of resources),
   *     components: { slotIndex: component | null }  — component = { target, props: [[name, value, precision, group, hidden]] }
   *     assembly: 0–7 (default 1, great success),
   *     experiment: { group: [points, outcome 0–8] } | 'max' | null,
   *   }
   * Returns { attrs: [...], groups: [...], props, armor, averages }.
   */
  function craft(schematic, target, opts = {}) {
    const avg = averages(schematic, opts.resources, opts.uniform);
    const mod = (ASSEMBLY[opts.assembly == null ? 1 : opts.assembly] || ASSEMBLY[1]).mod;
    const map = new Map();
    const order = [];
    const add = (name, a) => {
      if (!map.has(name)) order.push(name);
      map.set(name, Object.assign(map.get(name) || {}, a));
    };

    for (const [name, group, min, max, precision, combine, weights] of target.a) {
      const filler = weights.length === 0;
      add(name, { name, group, min, max, precision, combine, filler, hidden: filler, source: filler ? 'fixed' : 'resources' });
      const a = map.get(name);
      if (a.pct == null) a.pct = 0;
      if (a.maxPct == null) a.maxPct = 0;
      let ws = 0;
      for (const [stat, share] of weights) ws += (avg[stat] || 0) * share;
      a.weightedSum = ws;
      if (ws > 0) {
        a.maxPct = (ws / 10) * 0.01;
        a.pct = Math.min(ws * (0.000015 * ws + 0.015) * 0.01 * mod, a.maxPct);
      }
    }
    const attrs = () => order.map((n) => map.get(n));
    for (const a of attrs()) a.value = valueOf(a);

    // components
    const isClothing = /^tangible\/wearables\//.test(schematic.t) && !target.armor;
    let modified = false;
    let anyComponent = false;
    const used = [];
    if (!isClothing) {
      schematic.s.forEach((slot, i) => {
        if (!slot[1]) return;
        const comp = opts.components && opts.components[i];
        if (!comp || !comp.props) return;
        anyComponent = true;
        used.push(i);
        const contribution = (slot[4] == null ? 100 : slot[4]) / 100;
        for (const [name, value, precision, group, hidden] of comp.props) {
          modified = true;
          const pv = Number(value) * contribution;
          const a = map.get(name);
          if (a) {
            switch (a.combine) {
              case LINEAR:
                a.value += pv;
                a.min += pv;
                a.max += pv;
                a.fromComponents = (a.fromComponents || 0) + pv;
                break;
              case PERCENTAGE:
                a.min += pv;
                a.max += pv;
                a.pct = clampPct(a, a.value + pv);
                a.fromComponents = (a.fromComponents || 0) + pv;
                break;
              case BITSET:
                a.value = (a.value | 0) | (pv | 0);
                break;
              case OVERRIDE:
                break;
              case LIMITED:
                a.value = Math.max(Math.min(a.value + pv, Math.max(a.min, a.max)), Math.min(a.min, a.max));
                a.fromComponents = (a.fromComponents || 0) + pv;
                modified = false;
                break;
              default:
                break;
            }
          } else {
            add(name, { name, group: group == null ? '' : group, min: Number(value), max: Number(value), precision: precision || 0, combine: LINEAR, filler: !!hidden, hidden: !!hidden, pct: 0, maxPct: 0, value: Number(value), source: 'component', fromComponents: Number(value) });
          }
        }
      });
      if (anyComponent && modified) for (const a of attrs()) a.value = valueOf(a);
    }

    // assembly snapshot
    for (const a of attrs()) {
      a.assemblyPct = a.pct;
      a.assemblyValue = a.value;
    }

    // experimentation rows: groups of attributes that resources move and that have a range
    const groups = [];
    const groupOf = {};
    for (const a of attrs()) {
      if (a.filler || a.min === a.max || !a.group || a.group === 'null' || a.source === 'component') continue;
      if (!groupOf[a.group]) groups.push((groupOf[a.group] = { group: a.group, label: groupLabel(a.group), attrs: [] }));
      groupOf[a.group].attrs.push(a.name);
    }
    for (const g of groups) {
      // points needed at Amazing to reach the cap of every attribute in the row
      let need = 0;
      for (const n of g.attrs) {
        const a = map.get(n);
        need = Math.max(need, Math.ceil(Math.max(0, a.maxPct - a.pct) / EXPERIMENT[0].per - 1e-9));
      }
      g.pointsToCap = need;
    }
    const exp = opts.experiment;
    const inRow = (a) => !!groupOf[a.group] && groupOf[a.group].attrs.includes(a.name);
    for (const a of attrs()) {
      if (!inRow(a)) continue;
      if (exp === 'max') a.pct = a.maxPct;
      else if (exp && exp[a.group]) {
        const [points, outcome] = exp[a.group];
        const e = EXPERIMENT[outcome == null ? 0 : outcome] || EXPERIMENT[0];
        a.pct = clampPct(a, a.pct + e.per * (Number(points) || 0));
      }
      if (!a.hidden) a.value = valueOf(a);
    }
    for (const a of attrs()) {
      a.maxValue = inRow(a) ? valueOf(Object.assign({}, a, { pct: a.maxPct })) : a.value;
      a.label = attrLabel(a.name);
      a.groupLabel = groupLabel(a.group);
      a.experimentable = inRow(a);
    }

    const props = componentProps(schematic, attrs());
    const armor = target.armor ? armorSummary(target.armor, map) : null;
    return { attrs: attrs(), groups, props, armor, averages: avg, components: used, clothing: isClothing };
  }

  /** The properties a crafted item carries into a parent schematic (ComponentImplementation + ArmorComponent). */
  function componentProps(schematic, attrs) {
    const props = attrs.filter((a) => a.name !== 'useCount').map((a) => [a.name, a.value, a.precision, a.group, !!a.hidden]);
    if (/^tangible\/component\/armor\//.test(schematic.t)) {
      const get = (n) => {
        const a = attrs.find((x) => x.name === n);
        return a ? a.value : null;
      };
      const base = get('armor_special_effectiveness');
      const bits = get('armor_special_type');
      for (const p of props) if (p[0] === 'armor_special_effectiveness' || p[0] === 'armor_special_type') p[4] = true;
      if (bits != null) {
        for (const [bit, word] of DAMAGE) {
          if (!((bits | 0) & bit)) continue;
          const key = effKey(word);
          const own = get(key) || 0;
          const v = (base || 0) + own;
          const existing = props.find((p) => p[0] === key);
          if (existing) existing[1] = v;
          else props.push([key, v, 10, 'exp_resistance', false]);
        }
      }
    }
    return props;
  }

  function armorSummary([vulnerability, templateSpecial], map) {
    const val = (n) => (map.has(n) ? map.get(n).value : null);
    let special = (val('armor_special_type') || 0) | 0;
    const added = {};
    for (const [bit, word] of DAMAGE) {
      const v = val(effKey(word));
      if (v != null) {
        special |= bit;
        added[bit] = v;
      }
    }
    const base = val('armor_effectiveness') || 0;
    const se = map.get('armor_special_effectiveness');
    const specialProtection = se && se.max !== se.min ? se.value : base;
    const rows = DAMAGE.map(([bit, word, label]) => {
      const v = added[bit] || 0;
      let out;
      let kind;
      if (vulnerability & bit) {
        out = Math.trunc(v);
        kind = 'vulnerable';
      } else if (special & bit) {
        out = Math.min(80, Math.trunc(specialProtection + v));
        kind = 'special';
      } else {
        out = Math.min(80, Math.trunc(base + v));
        kind = 'base';
      }
      return { bit, key: word, label, value: out, kind, added: v };
    });
    return { rows, base, specialProtection, vulnerability, templateSpecial };
  }

  /** Display a value the way the game rounds it (precision = decimals; very large precisions → 2). */
  function fmt(value, precision) {
    if (value == null || !Number.isFinite(value)) return '—';
    const d = Math.min(precision || 0, 2);
    const r = Number(value.toFixed(d));
    return d ? String(r) : String(Math.round(value));
  }

  /** Can an item crafted from `target` sit in this slot? (template derivation isn't in the scripts; names are) */
  function fits(slot, target) {
    if (!slot[1]) return false;
    if ((slot[5] || []).includes(target)) return true;
    if (target === slot[2]) return true;
    const a = slot[2].split('/');
    const b = target.split('/');
    return a.length === b.length && a.slice(0, -1).join('/') === b.slice(0, -1).join('/') && b[b.length - 1].startsWith(a[a.length - 1] + '_');
  }

  return { STATS, STAT_ORDER, ASSEMBLY, EXPERIMENT, DAMAGE, LINEAR, PERCENTAGE, BITSET, OVERRIDE, LIMITED, craft, averages, relevantStats, componentProps, armorSummary, attrLabel, groupLabel, slotLabel, resourceLabel, fmt, fits };
});
