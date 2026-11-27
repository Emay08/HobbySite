#!/usr/bin/env node
/**
 * Rebuild data/swg-loot.json (the SWG Loot page: looted ship components, loot tables, NPC ships)
 * from the server scripts folder.
 *
 *   node scripts/swg-import-loot.js "<…>\MMOCoreORB\bin\scripts"
 *
 * Reads loot/items/ship/components/<type>/*.lua, every loot group under loot/groups, and
 * ship_mobile/ships/*.lua.
 */
const fs = require('fs');
const path = require('path');
const { buildLootData, TYPES } = require('../lib/swgLoot');

const root = process.argv[2];
if (!root) {
  console.error('Usage: node scripts/swg-import-loot.js <MMOCoreORB/bin/scripts folder>');
  process.exit(1);
}
const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.lua') ? [path.join(dir, d.name)] : [])) : []);
const read = (f) => fs.readFileSync(f, 'utf8');

const items = [];
for (const type of TYPES) for (const f of walk(path.join(root, 'loot', 'items', 'ship', 'components', type))) items.push({ type, text: read(f) });
const groups = walk(path.join(root, 'loot', 'groups')).map(read);
const ships = walk(path.join(root, 'ship_mobile', 'ships')).map(read);

const publicFile = path.join(__dirname, '..', 'data', 'swg-public.json');
const publicList = fs.existsSync(publicFile) ? JSON.parse(fs.readFileSync(publicFile, 'utf8')) : null;
const data = buildLootData({ items, groups, ships, publicList });
if (!publicList) console.log('No data/swg-public.json: nothing is flagged NFS-only (see scripts/swg-public-list.js).');
const out = path.join(__dirname, '..', 'data', 'swg-loot.json');
const { unknownTables, ...save } = data;
fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), ...save }) + '\n');
console.log(`${data.items.length} components, ${Object.keys(data.tables).length} loot tables, ${data.npcs.length} NPC ships → ${path.relative(process.cwd(), out)}`);
if (unknownTables.length) console.log('Loot tables used by ships but not found:\n  ' + unknownTables.join('\n  '));
