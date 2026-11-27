/**
 * SWG crafting schematics, read from the server scripts:
 *
 *   bin/scripts/managers/crafting/schematics.lua      the draft schematics the server actually loads
 *   bin/scripts/object/draft_schematic/**.lua          a schematic: slots, resources, quantities, target
 *   bin/scripts/object/(tangible|weapon)/**.lua        the target object: experimental properties
 *
 * The target's experimental tables become one "attribute" each (experimentalSubGroupTitles):
 * its group (experimentalGroupTitles, the row you experiment on), min, max, precision, combine
 * type, and the resource stats that feed it with their weights (numberExperimentalProperties
 * says how many entries of experimentalProperties / experimentalWeights belong to it).
 * See public/swg-craft-calc.js for what the server does with them.
 */

// Profession tabs. Artisan schematics show on every tab except the medical ones; Medic schematics
// show on Doctor and Combat Medic.
const PROFESSIONS = [
  { id: 'weaponsmith', label: 'Weaponsmith' },
  { id: 'armorsmith', label: 'Armorsmith' },
  { id: 'architect', label: 'Architect' },
  { id: 'shipwright', label: 'Shipwright' },
  { id: 'droid', label: 'Droid Engineer' },
  { id: 'chef', label: 'Chef' },
  { id: 'tailor', label: 'Tailor' },
  { id: 'doctor', label: 'Doctor' },
  { id: 'combatmedic', label: 'Combat Medic' },
];

const ASSEMBLY = {
  weapon_assembly: 'weaponsmith',
  armor_assembly: 'armorsmith',
  structure_assembly: 'architect',
  droid_assembly: 'droid',
  food_assembly: 'chef',
  clothing_assembly: 'tailor',
  medicine_assembly: 'doctor',
  combat_medicine_assembly: 'combatmedic',
};

// Medic (the base medical profession) schematics, all medicine_assembly: the basic medical
// components, Stimpacks A–D and Wound Medpacks A–B. Everything else on medicine_assembly is Doctor.
const MEDIC = /^(biologic_effect_controller|liquid_delivery_suspension|release_mechanism_duration|solid_delivery_shell|infection_amplifier|resilience_compound|dispersal_mechanism)$|^(med_stimpack_[abcd]|quest_stimpack_a|medpack_wound_[a-z]+_[ab]|med_fire_blanket)$/;

const SKIP = /^(dead_eye_prototype|fs_medic_puzzle_heal_pack)$/;

const DAMAGE_TYPES = { KINETIC: 1, ENERGY: 2, BLAST: 4, STUN: 8, LIGHTSABER: 16, HEAT: 32, COLD: 64, ACID: 128, ELECTRICITY: 256 };

function stripComments(text) {
  return text.replace(/--\[\[[\s\S]*?\]\]/g, '').replace(/--[^\n]*/g, '');
}

/** The body of the first `name = parent:new { ... }` block, or null. */
function newBlock(src) {
  const m = /:new\s*\{/.exec(src);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < src.length && depth) {
    const c = src[i++];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '"') while (i < src.length && src[i++] !== '"');
  }
  return src.slice(start, i - 1);
}

/** Top-level `key = value` fields of a block: { key: { table: '…' } | { str } | { raw } } */
function fields(block) {
  const out = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/y;
  let i = 0;
  while (i < block.length) {
    re.lastIndex = i;
    const m = re.exec(block);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    let j = re.lastIndex;
    if (block[j] === '{') {
      let depth = 1;
      let k = j + 1;
      while (k < block.length && depth) {
        const c = block[k++];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '"') while (k < block.length && block[k++] !== '"');
      }
      out[key] = { table: block.slice(j + 1, k - 1) };
      i = k;
    } else if (block[j] === '"') {
      const k = block.indexOf('"', j + 1);
      out[key] = { str: block.slice(j + 1, k) };
      i = k + 1;
    } else {
      const m2 = /[^,\n]*/y;
      m2.lastIndex = j;
      const v = m2.exec(block)[0];
      out[key] = { raw: v.trim() };
      i = j + v.length + 1;
    }
  }
  return out;
}

const list = (f) => {
  if (!f || f.table == null) return [];
  const out = [];
  const re = /"([^"]*)"|(-?\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(f.table))) out.push(m[1] != null ? m[1] : Number(m[2]));
  return out;
};
const str = (f) => (f && f.str != null ? f.str.replace(/\\(['"\\])/g, '$1') : f && f.raw != null ? f.raw : '');
const titleCase = (s) => s.replace(/_/g, ' ').replace(/\b([a-z])/g, (c) => c.toUpperCase());
const number = (f) => {
  const n = Number(str(f));
  return Number.isFinite(n) ? n : 0;
};

/** `STUN + LIGHTSABER` → 24 */
function damageBits(raw) {
  if (!raw) return 0;
  let bits = 0;
  for (const part of String(raw).split(/[+|]/)) {
    const p = part.trim();
    if (DAMAGE_TYPES[p]) bits |= DAMAGE_TYPES[p];
    else if (/^\d+$/.test(p)) bits |= Number(p);
  }
  return bits;
}

/** 'object/tangible/foo/shared_bar.iff' or 'object/tangible/foo/bar.iff' → 'tangible/foo/bar' */
function templateKey(p) {
  return String(p || '')
    .replace(/^object\//, '')
    .replace(/\.(iff|lua)$/, '')
    .replace(/\/shared_([^/]+)$/, '/$1');
}

/** A draft schematic file → schematic, or null when it isn't a schematic. */
function parseSchematic(text) {
  const block = newBlock(stripComments(text));
  if (!block) return null;
  const f = fields(block);
  const target = str(f.targetTemplate);
  if (!target) return null;
  const types = list(f.ingredientSlotType);
  const titles = list(f.ingredientTitleNames);
  const res = list(f.resourceTypes);
  const qty = list(f.resourceQuantities);
  const contrib = list(f.contribution);
  const slots = res.map((r, i) => ({
    title: titles[i] || 'slot ' + (i + 1),
    type: types[i] || 0,
    resource: types[i] ? templateKey(r) : r,
    qty: qty[i] || 0,
    contribution: contrib[i] == null ? 100 : contrib[i],
  }));
  return {
    name: str(f.customObjectName),
    complexity: number(f.complexity),
    xp: number(f.xp),
    xpType: str(f.xpType),
    assemblySkill: str(f.assemblySkill),
    experimentingSkill: str(f.experimentingSkill),
    tab: number(f.craftingToolTab),
    target: templateKey(target),
    slots,
  };
}

/**
 * A target object file → { templateType, attrs, armor } or null.
 * attrs: [{ name, group, min, max, precision, combine, weights: [[stat, share], …] }]
 * (stat = two-letter resource stat; share = weight / total weight of the attribute)
 */
function parseTarget(text) {
  const block = newBlock(stripComments(text));
  if (!block) return null;
  const f = fields(block);
  const counts = list(f.numberExperimentalProperties);
  const props = list(f.experimentalProperties);
  const weights = list(f.experimentalWeights);
  const groups = list(f.experimentalGroupTitles);
  const names = list(f.experimentalSubGroupTitles);
  const mins = list(f.experimentalMin);
  const maxs = list(f.experimentalMax);
  const precs = list(f.experimentalPrecision);
  const combs = list(f.experimentalCombineType);
  const attrs = [];
  let w = 0;
  for (let i = 0; i < counts.length; i++) {
    const raw = [];
    for (let j = 0; j < counts[i]; j++, w++) {
      const p = props[w];
      // ResourceWeight::addWeight: weight % 16, and 0 for anything that isn't a resource stat
      if (p && p !== 'XX' && p !== 'PO') raw.push([p, (weights[w] || 0) % 16]);
    }
    const total = raw.reduce((s, x) => s + x[1], 0);
    attrs.push({
      name: names[i] == null ? 'null' : String(names[i]),
      group: groups[i] == null ? 'null' : String(groups[i]),
      min: mins[i] || 0,
      max: maxs[i] || 0,
      precision: precs[i] || 0,
      combine: combs[i] || 0,
      weights: raw.filter((x) => x[1] > 0).map(([s, x]) => [s, Math.round((x / total) * 1e6) / 1e6]),
    });
  }
  const out = { templateType: str(f.templateType), attrs };
  if (out.templateType === 'ARMOROBJECT') out.armor = { vulnerability: damageBits(str(f.vulnerability)), specialResists: damageBits(str(f.specialResists)) };
  return out;
}

/** An attribute that resources move: has resource weights and a range. */
const materialAttr = (a) => a.weights.length > 0 && a.min !== a.max && a.group !== 'null' && a.name !== 'null';

function professionsFor(id, s) {
  const base = id.split('/').pop();
  if (SKIP.test(base)) return [];
  if (s.xpType === 'shipwright') return ['shipwright'];
  if (s.assemblySkill === 'general_assembly') {
    if (s.xpType === 'crafting_general') return ['artisan'];
    if (s.xpType === 'crafting_structure_general') return ['architect'];
    return [];
  }
  if (s.assemblySkill === 'food_assembly' && s.xpType === 'crafting_general') return ['artisan'];
  const p = ASSEMBLY[s.assemblySkill];
  if (!p) return []; // bio-engineer, spices, instruments, jedi, scout
  if (p === 'doctor' && MEDIC.test(base)) return ['medic'];
  return [p];
}

/**
 * Build the page data.
 *   live:      draft schematic paths from schematics.lua ('object/draft_schematic/…iff')
 *   readFile:  (relative path under bin/scripts, e.g. 'object/draft_schematic/x.lua') → text | null
 *   publicSchematics: optional list of schematic ids in public SWGEmu (anything else is NFS-only)
 */
function buildCraftingData({ live, readFile, publicSchematics, publicTargets }) {
  const schematics = [];
  const targets = {};
  const missing = [];
  const pub = publicSchematics ? new Set(publicSchematics) : null;

  for (const p of live) {
    const id = templateKey(p).replace(/^draft_schematic\//, '');
    const text = readFile('object/draft_schematic/' + id + '.lua');
    if (!text) {
      missing.push(p);
      continue;
    }
    const s = parseSchematic(text);
    if (!s) continue;
    if (!s.name || s.name.startsWith('@')) s.name = titleCase(id.split('/').pop().replace(/^(clothing_|item_|droid_|food_|furniture_)/, ''));
    const profs = professionsFor(id, s);
    if (!profs.length) continue;
    if (!(s.target in targets)) {
      const t = readFile('object/' + s.target + '.lua');
      targets[s.target] = t ? parseTarget(t) : null;
    }
    if (!targets[s.target]) continue;
    schematics.push({ id, ...s, professions: profs, nfs: pub ? !pub.has(id) : false });
  }

  // which component slots can be filled by something craftable, and does that something have
  // material-affected stats (directly or through its own components)?
  const byTarget = {};
  for (const s of schematics) (byTarget[s.target] = byTarget[s.target] || []).push(s);
  const accepts = (slotRes, target) => {
    if (target === slotRes) return true;
    const a = slotRes.split('/');
    const b = target.split('/');
    if (a.length !== b.length || a.slice(0, -1).join('/') !== b.slice(0, -1).join('/')) return false;
    return b[b.length - 1].startsWith(a[a.length - 1] + '_');
  };
  const allTargets = Object.keys(byTarget);
  const fits = {};
  for (const s of schematics)
    for (const slot of s.slots) if (slot.type && !(slot.resource in fits)) fits[slot.resource] = allTargets.filter((t) => accepts(slot.resource, t));

  const hasStats = {};
  const statty = (target, seen = new Set()) => {
    if (target in hasStats) return hasStats[target];
    if (seen.has(target)) return false;
    seen.add(target);
    const t = targets[target];
    let ok = !!t && t.attrs.some(materialAttr);
    if (!ok)
      for (const s of byTarget[target] || [])
        for (const slot of s.slots) if (slot.type && (fits[slot.resource] || []).some((x) => statty(x, seen))) ok = true;
    hasStats[target] = ok;
    return ok;
  };
  // everything is kept so recipes can be looked up; `stats: false` marks the ones whose result
  // doesn't depend on the materials (the page hides those unless asked)
  for (const s of schematics) s.stats = statty(s.target);
  const kept = schematics;
  const usedTargets = {};
  for (const s of kept) usedTargets[s.target] = targets[s.target];
  for (const s of kept) for (const slot of s.slots) if (slot.type) slot.fits = (fits[slot.resource] || []).filter((t) => usedTargets[t]);

  // NFS-changed stats: the target's experimental table differs from public SWGEmu
  if (publicTargets)
    for (const [k, t] of Object.entries(usedTargets)) if (publicTargets[k] && JSON.stringify(publicTargets[k].attrs) !== JSON.stringify(t.attrs)) t.nfsStats = true;

  kept.sort((a, b) => a.name.localeCompare(b.name));
  return { professions: PROFESSIONS, schematics: kept, targets: usedTargets, missing, dropped: kept.filter((s) => !s.stats).length };
}

/**
 * The shape written to data/swg-crafting.json (and read by public/swg-craft-calc.js):
 *   schematics: [{ id, n: name, p: [professions], cx: complexity, xp, t: target,
 *                  s: [[title, slotType, resource class | component template, quantity, contribution%, fits?]],
 *                  st: 1 when materials move its stats, nfs: 1 when it isn't in public SWGEmu }]
 *   targets: { template: { a: [[attribute, group, min, max, precision, combineType, [[stat, share], …]]],
 *                          armor?: [vulnerability bits, specialResists bits], nfs?: 1 } }
 * Attributes named "null" (padding rows in the scripts, never shown) are left out.
 */
function compactCraftingData(data) {
  const schematics = data.schematics.map((s) => {
    const o = { id: s.id, n: s.name, p: s.professions, cx: s.complexity, xp: s.xp, t: s.target, s: s.slots.map((x) => (x.type ? [x.title, x.type, x.resource, x.qty, x.contribution, x.fits || []] : [x.title, 0, x.resource, x.qty, x.contribution])) };
    if (s.stats) o.st = 1;
    if (s.nfs) o.nfs = 1;
    return o;
  });
  const targets = {};
  for (const [k, t] of Object.entries(data.targets)) {
    const o = { a: t.attrs.filter((a) => a.name !== 'null').map((a) => [a.name, a.group, a.min, a.max, a.precision, a.combine, a.weights]) };
    if (t.armor) o.armor = [t.armor.vulnerability, t.armor.specialResists];
    if (t.nfsStats) o.nfs = 1;
    targets[k] = o;
  }
  return { professions: data.professions, schematics, targets };
}

module.exports = { compactCraftingData, PROFESSIONS, parseSchematic, parseTarget, buildCraftingData, templateKey, damageBits, professionsFor, materialAttr };
