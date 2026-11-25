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
    ships.push({ id: n.iff.replace(/\.iff$/, ''), name: n.name, faction: n.faction, ...parsed });
  }
  const unnamed = Object.keys(luaFiles).filter((f) => /^player_.*\.lua$/.test(f) && !used.has(f)).sort();
  return { ships, missing, unnamed };
}

module.exports = { parseShipLua, parseShipNames, buildShipData, luaFlatTable };
