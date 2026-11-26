/**
 * SWG ship chassis data, read from the SWGEmu / NFS server scripts
 * (MMOCoreORB/bin/scripts/object/ship/player/player_*.lua) and named with ship_names.txt.
 *
 * Only what the ship builder needs is read: chassis numbers, the handling attributes and
 * the default component in each slot. Everything else in the files (interior objects,
 * spark / launch points…) is ignored.
 */

const SLOT_ORDER = ['reactor', 'engine', 'shield', 'armor', 'capacitor', 'booster', 'droid_interface', 'weapon'];

/** Parse one Lua literal value: number, "string" or true/false. */
function luaValue(raw) {
  const s = raw.trim();
  if (/^".*"$/.test(s)) return s.slice(1, -1);
  if (s === 'true' || s === 'false') return s === 'true';
  const n = Number(s);
  return Number.isFinite(n) ? n : s;
}

/** `{ name = "x", hitpoints = 1, ... }` (one level, no nesting) → object */
function luaFlatTable(body) {
  const out = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*"|[^,}]+)/g;
  let m;
  while ((m = re.exec(body))) out[m[1]] = luaValue(m[2]);
  return out;
}

function slotSortKey(slot) {
  const [, base, idx] = slot.match(/^([a-z_]+?)(?:_(\d+))?$/) || [, slot, 0];
  const i = SLOT_ORDER.indexOf(base);
  return (i < 0 ? 99 : i) * 100 + Number(idx || 0);
}

/**
 * Parse a player ship LUA file. Returns null when it doesn't look like a ship template.
 */
function parseShipLua(text) {
  // strip comments so commented-out lines never count
  const src = text.replace(/--\[\[[\s\S]*?\]\]/g, '').replace(/--[^\n]*/g, '');
  const num = (key) => {
    const m = src.match(new RegExp('\\b' + key + '\\s*=\\s*(-?[\\d.]+)'));
    return m ? Number(m[1]) : null;
  };
  const str = (key) => {
    const m = src.match(new RegExp('\\b' + key + '\\s*=\\s*"([^"]*)"'));
    return m ? m[1] : null;
  };
  const name = str('name');
  if (!name || num('chassisMass') == null) return null;

  const attributes = {};
  const attrBlock = src.match(/\battributes\s*=\s*\{([\s\S]*?)\n\s*\},/);
  if (attrBlock) {
    const re = /\{\s*"([A-Za-z0-9_]+)"\s*,\s*(-?[\d.]+)\s*\}/g;
    let m;
    while ((m = re.exec(attrBlock[1]))) attributes[m[1]] = Number(m[2]);
  }

  const certs = [];
  const certBlock = src.match(/certificationsRequired\s*=\s*\{([^}]*)\}/);
  if (certBlock) for (const m of certBlock[1].matchAll(/"([^"]+)"/g)) certs.push(m[1]);

  // component slots: `slot = { name = "...", ... },` on one line
  const slots = {};
  const slotRe = /^\s*([a-z]+(?:_[a-z]+)*(?:_\d+)?)\s*=\s*\{\s*(name\s*=[^\n]*?)\}\s*,?\s*$/gm;
  let m;
  while ((m = slotRe.exec(src))) {
    const key = m[1];
    if (!/^(reactor|engine|shield_\d+|armor_\d+|capacitor|booster|droid_interface|weapon_\d+)$/.test(key)) continue;
    slots[key] = luaFlatTable(m[2]);
  }
  const ordered = {};
  for (const k of Object.keys(slots).sort((a, b) => slotSortKey(a) - slotSortKey(b))) ordered[k] = slots[k];

  return {
    template: name,
    certifications: certs,
    category: str('category'),
    level: num('level'),
    slideFactor: num('slideFactor'),
    chassisHitpoints: num('chassisHitpoints'),
    chassisMass: num('chassisMass'),
    attributes,
    slots: ordered,
  };
}

/**
 * ship_names.txt: `"Rebel", { "A-Wing Deed", "awing.iff", ... }, "Imperial", {...}, ...`
 * → [{ faction, name, iff }] in file order. "Neutral" is shown as Freelancer.
 */
function parseShipNames(text) {
  const out = [];
  const groupRe = /"([^"]+)"\s*,\s*\{([\s\S]*?)\}/g;
  let g;
  while ((g = groupRe.exec(text))) {
    const faction = /^neutral$/i.test(g[1]) ? 'freelancer' : g[1].toLowerCase();
    const pairRe = /"([^"]+)"\s*,\s*"([^"]+\.iff)"/g;
    let p;
    while ((p = pairRe.exec(g[2]))) {
      out.push({ faction, name: p[1].replace(/\s+Deed\b/, '').trim(), iff: p[2] });
    }
  }
  return out;
}

/**
 * Combine the name list with parsed LUA files ({ 'player_awing.lua': text, ... }).
 * Ships in the name list without a LUA file are reported in `missing`; LUA files that
 * aren't in the name list are left out (`unnamed`).
 */
/**
 * Corrections to the server's ship templates, applied on every import.
 *
 * Gaps in the weapon slot numbers are empty ordnance (missile launcher) slots the templates leave
 * unfilled; they are listed as { empty: true, launcher: 'missile' } so the builder treats them as
 * ordnance slots that start empty. Two templates are missing a slot outright:
 * - X-wing: 3 blasters + ordnance + countermeasures, but weapon_2 is skipped, so it gets a copy of
 *   the stock Incom blaster;
 * - Dunelizard: 2 guns + ordnance + countermeasures, but the template has one gun and puts the
 *   countermeasure launcher in weapon_2, so it gets a second stock disruptor in weapon_1, an empty
 *   ordnance slot in weapon_2 and the countermeasures move to weapon_3.
 */
const ORDNANCE = () => ({ empty: true, launcher: 'missile' });
const SHIP_FIXES = {
  xwing(ship) {
    if (!ship.slots.weapon_2 && ship.slots.weapon_1) ship.slots.weapon_2 = { ...ship.slots.weapon_1 };
  },
  tieaggressor(ship) {
    if (!ship.slots.weapon_2) ship.slots.weapon_2 = ORDNANCE();
  },
  hutt_light_s01: scyk,
  hutt_light_s02: scyk,
  hutt_heavy_s01: kimogila,
  hutt_heavy_s02: kimogila,
  hutt_medium_s01: dunelizard,
  hutt_medium_s02: dunelizard,
};
function scyk(ship) {
  if (!ship.slots.weapon_1) ship.slots.weapon_1 = ORDNANCE();
}
function kimogila(ship) {
  if (!ship.slots.weapon_3) ship.slots.weapon_3 = ORDNANCE();
}
function dunelizard(ship) {
  const s = ship.slots;
  if (s.weapon_1 || !s.weapon_0 || !s.weapon_2 || s.weapon_3) return;
  s.weapon_3 = s.weapon_2; // countermeasures
  s.weapon_2 = ORDNANCE();
  s.weapon_1 = { ...s.weapon_0 };
}

/**
 * Turret weapon slots: a second crew member can aim these independently of the ship's heading.
 * From the turret table the server loads out of the client (datatables/space/ship_turret.iff,
 * mirrored, commented out, in bin/scripts/managers/space/ship_turret.lua): the weapon index there
 * is the slot number (1 = weapon_1).
 */
const TURRETS = {
  yt1300: ['weapon_0', 'weapon_1'],
  ywing: ['weapon_1'],
  hutt_turret_ship: ['weapon_1'],
  tieaggressor: ['weapon_1'],
  decimator: ['weapon_0', 'weapon_1'],
  ykl37r: ['weapon_0', 'weapon_1'],
};

function applyFixes(ship) {
  if (SHIP_FIXES[ship.id]) {
    SHIP_FIXES[ship.id](ship);
    const ordered = {};
    for (const k of Object.keys(ship.slots).sort((a, b) => slotSortKey(a) - slotSortKey(b))) ordered[k] = ship.slots[k];
    ship.slots = ordered;
  }
  const turrets = (TURRETS[ship.id] || []).filter((k) => ship.slots[k]);
  if (turrets.length) ship.turrets = turrets;
  return ship;
}

function buildShipData(namesText, luaFiles) {
  const names = parseShipNames(namesText);
  const ships = [];
  const missing = [];
  const used = new Set();
  for (const n of names) {
    const file = 'player_' + n.iff.replace(/\.iff$/, '') + '.lua';
    const text = luaFiles[file];
    const parsed = text != null ? parseShipLua(text) : null;
    if (!parsed) {
      missing.push(n.name + ' (' + file + ')');
      continue;
    }
    used.add(file);
    ships.push(applyFixes({ id: n.iff.replace(/\.iff$/, ''), name: n.name, faction: n.faction, ...parsed }));
  }
  const unnamed = Object.keys(luaFiles).filter((f) => /^player_.*\.lua$/.test(f) && !used.has(f)).sort();
  return { ships, missing, unnamed };
}

module.exports = { parseShipLua, parseShipNames, buildShipData, luaFlatTable, applyFixes };
