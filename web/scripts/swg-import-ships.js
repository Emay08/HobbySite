#!/usr/bin/env node
/**
 * Rebuild data/swg-ships.json (the SWG ship builder's chassis list) from the server scripts.
 *
 *   node scripts/swg-import-ships.js "<MMOCoreORB>\bin\scripts\object\ship\player" [ship_names.txt]
 *
 * ship_names.txt defaults to data/swg-ship-names.txt; only ships named there are kept.
 */
const fs = require('fs');
const path = require('path');
const { buildShipData } = require('../lib/swgShips');

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node scripts/swg-import-ships.js <folder with player_*.lua> [ship_names.txt]');
  process.exit(1);
}
const namesFile = process.argv[3] || path.join(__dirname, '..', 'data', 'swg-ship-names.txt');
const files = {};
for (const f of fs.readdirSync(dir)) if (/^player_.*\.lua$/.test(f)) files[f] = fs.readFileSync(path.join(dir, f), 'utf8');

const publicFile = path.join(__dirname, '..', 'data', 'swg-public.json');
const publicList = fs.existsSync(publicFile) ? JSON.parse(fs.readFileSync(publicFile, 'utf8')) : null;
const { ships, missing, unnamed } = buildShipData(fs.readFileSync(namesFile, 'utf8'), files, publicList);
const out = path.join(__dirname, '..', 'data', 'swg-ships.json');
fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), ships }, null, 1) + '\n');
console.log(`${ships.length} ships → ${path.relative(process.cwd(), out)}`);
if (missing.length) console.log('Named but no LUA file found:\n  ' + missing.join('\n  '));
if (unnamed.length) console.log('LUA files left out (not in the name list):\n  ' + unnamed.join('\n  '));
