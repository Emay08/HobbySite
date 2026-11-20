#!/usr/bin/env node
// Checks Scryfall for reprints of your cards once, ignoring active hours.
//   node scripts/run-spoilers.js --dry-run   lists matches; saves nothing, no Telegram
//   node scripts/run-spoilers.js             real run
require('./env');
const { getDb, close } = require('../src/lib/db');
const { runReprints } = require('../src/lib/reprints');

(async () => {
  const dry = process.argv.includes('--dry-run');
  const db = await getDb();
  const r = await runReprints(db, { force: true, notify: !dry, log: console.log });
  console.log(JSON.stringify({ found: r.found, autoAdded: r.autoAdded, notified: r.notified }, null, 2));
  await close();
})().catch(async (e) => {
  console.error(e.message);
  await close();
  process.exit(1);
});
