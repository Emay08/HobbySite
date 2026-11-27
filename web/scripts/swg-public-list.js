#!/usr/bin/env node
/**
 * Rebuild data/swg-public.json: which player ships, looted ship components and NPC ships exist in
 * public SWGEmu (Core3). The import scripts flag everything else as NFS-only, and the SWG pages'
 * "Include NFS content" switch hides it.
 *
 *   git clone https://github.com/swgemu/Core3      (or download it)
 *   node scripts/swg-public-list.js "<Core3>/MMOCoreORB/bin/scripts" [label]
 *
 * Then rerun scripts/swg-import-ships.js and scripts/swg-import-loot.js.
 */
const fs = require('fs');
const path = require('path');
const { parseLootItem, parseShipAgent } = require('../lib/swgLoot');

const root = process.argv[2];
if (!root) {
  console.error('Usage: node scripts/swg-public-list.js <Core3 MMOCoreORB/bin/scripts folder> [label]');
  process.exit(1);
}
const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.lua') ? [path.join(dir, d.name)] : [])) : []);
const read = (f) => fs.readFileSync(f, 'utf8');

const ships = walk(path.join(root, 'object', 'ship', 'player'))
  .map((f) => path.basename(f).match(/^player_(.+)\.lua$/))
  .filter(Boolean)
  .map((m) => m[1])
  .sort();
const items = walk(path.join(root, 'loot', 'items', 'ship', 'components')).map((f) => (parseLootItem(read(f)) || {}).id).filter(Boolean).sort();
const npcs = walk(path.join(root, 'ship_mobile', 'ships')).map((f) => (parseShipAgent(read(f)) || {}).id).filter(Boolean).sort();

const out = path.join(__dirname, '..', 'data', 'swg-public.json');
fs.writeFileSync(out, JSON.stringify({ source: process.argv[3] || 'SWGEmu Core3', generatedAt: new Date().toISOString(), ships, items, npcs }) + '\n');
console.log(`${ships.length} player ships, ${items.length} components, ${npcs.length} NPC ships → ${path.relative(process.cwd(), out)}`);
