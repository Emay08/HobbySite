#!/usr/bin/env node
/**
 * Rebuild data/swg-crafting.json (the SWG Crafting page: schematics, slots, experimental
 * properties) from the server scripts folder.
 *
 *   node scripts/swg-import-crafting.js "<…>\MMOCoreORB\bin\scripts" ["<Core3>\MMOCoreORB\bin\scripts"]
 *
 * Reads managers/crafting/schematics.lua (the schematics the server loads), each one's
 * object/draft_schematic/… file and its target object file. With a second folder (public SWGEmu
 * Core3), schematics missing there are flagged NFS-only and targets whose experimental table
 * differs are flagged as NFS-changed.
 */
const fs = require('fs');
const path = require('path');
const { buildCraftingData, parseTarget, compactCraftingData } = require('../lib/swgCrafting');

const root = process.argv[2];
const publicRoot = process.argv[3];
if (!root) {
  console.error('Usage: node scripts/swg-import-crafting.js <MMOCoreORB/bin/scripts folder> [<Core3 MMOCoreORB/bin/scripts folder>]');
  process.exit(1);
}
const reader = (base) => (rel) => {
  const f = path.join(base, ...rel.split('/'));
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
};
const liveList = (base) => {
  const f = path.join(base, 'managers', 'crafting', 'schematics.lua');
  if (!fs.existsSync(f)) return null;
  return [...fs.readFileSync(f, 'utf8').replace(/--[^\n]*/g, '').matchAll(/path\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
};

const live = liveList(root);
if (!live) {
  console.error('managers/crafting/schematics.lua not found under ' + root);
  process.exit(1);
}

let publicSchematics = null;
let publicTargets = null;
if (publicRoot) {
  const pubLive = liveList(publicRoot) || [];
  publicSchematics = pubLive.map((p) => p.replace(/^object\/draft_schematic\//, '').replace(/\.iff$/, ''));
  const read = reader(publicRoot);
  publicTargets = new Proxy(
    {},
    {
      get(cache, key) {
        if (!(key in cache)) {
          const t = read('object/' + key + '.lua');
          cache[key] = t ? parseTarget(t) : null;
        }
        return cache[key];
      },
    },
  );
}

const data = buildCraftingData({ live, readFile: reader(root), publicSchematics, publicTargets });
const out = path.join(__dirname, '..', 'data', 'swg-crafting.json');
const { missing, dropped } = data;
fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), ...compactCraftingData(data) }) + '\n');
console.log(`${data.schematics.length} schematics (${dropped} of them without material-affected stats), ${Object.keys(data.targets).length} targets → ${path.relative(process.cwd(), out)}`);
if (missing.length) console.log('Listed in schematics.lua but no file:\n  ' + missing.join('\n  '));
