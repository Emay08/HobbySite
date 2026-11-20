#!/usr/bin/env node
// Checks the Player Reward Packs page once.
//   node scripts/run-reward-packs.js --dry-run   reads and parses the page; saves nothing
//   node scripts/run-reward-packs.js             real run
require('./env');
const { getDb, close } = require('../src/lib/db');
const { runRewardPacks } = require('../src/lib/rewardPacks');

(async () => {
  const dry = process.argv.includes('--dry-run');
  const db = await getDb();
  const r = await runRewardPacks(db, { force: true, notify: !dry, log: console.log });
  console.log(JSON.stringify(r, null, 2));
  await close();
})().catch(async (e) => {
  console.error(e.message);
  await close();
  process.exit(1);
});
