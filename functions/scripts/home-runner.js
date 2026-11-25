#!/usr/bin/env node
// The home runner (see src/lib/homeRunner.js). Started at boot on hobbymini by the
// "Vault home runner" scheduled task (deploy/install-home-runner.ps1), which restarts it
// if it stops. It also exits by itself when its code changes (after a git pull), so the
// task restarts it on the new code.
//   node scripts/home-runner.js          run forever
//   node scripts/home-runner.js --once   one tick, then exit (to test the setup)
require('./env');
const fs = require('fs');
const path = require('path');
const { getDb, close } = require('../src/lib/db');
const { runTreasureChest } = require('../src/lib/treasureChest');
const { runRewardPacks } = require('../src/lib/rewardPacks');
const { heartbeat, serveVendorRequests } = require('../src/lib/homeRunner');

const TICK_MS = 30000;
const POLL_MS = 1000;
const once = process.argv.includes('--once');
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (s) => console.log(`${stamp()}  ${s}`);

// Exit when our own code changes, so the scheduled task restarts us on the new version.
const root = path.join(__dirname, '..');
const watched = () =>
  [path.join(root, 'package.json'), __filename, ...fs.readdirSync(path.join(root, 'src', 'lib')).map((f) => path.join(root, 'src', 'lib', f))]
    .map((f) => {
      try {
        return fs.statSync(f).mtimeMs;
      } catch {
        return 0;
      }
    })
    .join(',');
const codeAtStart = watched();

let stopping = false;
async function main() {
  const db = await getDb();
  await db.collection('vendor_requests').createIndex({ requestedAt: 1 }, { expireAfterSeconds: 86400 });
  await db.collection('vendor_requests').createIndex({ vendor: 1, status: 1, requestedAt: 1 });
  const startedAt = new Date();
  log(`Home runner started (Node ${process.version})`);

  const tick = async () => {
    await heartbeat(db, { startedAt });
    for (const [label, run] of [['Treasure Chest', runTreasureChest], ['Player Reward Packs', runRewardPacks]]) {
      try {
        const r = await run(db, { log });
        if (!r.skipped) log(`${label}: ${r.changed ? 'changed' : 'checked, no change'}`);
      } catch (err) {
        log(`${label} failed: ${err.message}`);
      }
    }
  };

  if (once) {
    await tick();
    const n = await serveVendorRequests(db, { log });
    log(`One tick done${n ? `, ${n} Cardhoarder lookups` : ''}.`);
    return;
  }

  let nextTick = 0;
  let lastCodeCheck = Date.now();
  while (!stopping) {
    if (Date.now() >= nextTick) {
      nextTick = Date.now() + TICK_MS;
      await tick().catch((err) => log(`Tick failed: ${err.message}`));
    }
    try {
      const n = await serveVendorRequests(db, { log });
      if (n) log(`Cardhoarder: ${n} lookup(s)`);
    } catch (err) {
      log(`Cardhoarder requests failed: ${err.message}`);
    }
    if (Date.now() - lastCodeCheck > 60000) {
      lastCodeCheck = Date.now();
      if (watched() !== codeAtStart) {
        log('Code changed — exiting so the scheduled task restarts on the new version.');
        break;
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (stopping = true));
main()
  .then(() => close())
  .catch(async (err) => {
    log(`Home runner stopped: ${err.stack || err.message}`);
    await close().catch(() => {});
    process.exit(1);
  });
