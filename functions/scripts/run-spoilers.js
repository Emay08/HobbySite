#!/usr/bin/env node
// Checks MagicSpoiler once, ignoring active hours.
//   node scripts/run-spoilers.js --dry-run   lists pages + matches; saves nothing, no Telegram
//   node scripts/run-spoilers.js             real run
require('./env');
const { getDb, close } = require('../src/lib/db');
const { runSpoilers } = require('../src/lib/spoilers');

(async () => {
  const dry = process.argv.includes('--dry-run');
  const db = await getDb();
  const r = await runSpoilers(db, { force: true, notify: !dry, log: console.log });
  console.log(JSON.stringify({ found: r.found, autoAdded: r.autoAdded, notified: r.notified }, null, 2));
  await close();
})().catch(async (e) => {
  console.error(e.message);
  await close();
  process.exit(1);
});
