#!/usr/bin/env node
// Usage:
//   node scripts/run-monitors.js --dry-run            # fetch + show what would be stored; no DB, no Telegram
//   node scripts/run-monitors.js --dry-run mtgo-news  # just one monitor
//   node scripts/run-monitors.js                      # real run against MongoDB (+ Telegram)
require('./env');
const { runMonitor, recordError } = require('../src/lib/monitor');
const monitors = require('../src/lib/monitors.config');
const { getDb, close } = require('../src/lib/db');

(async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const only = args.filter((a) => !a.startsWith('--'));
  const list = monitors.filter((m) => (only.length ? only.includes(m.id) : m.enabled));
  const db = dryRun ? null : await getDb();

  for (const m of list) {
    console.log(`\n▶ ${m.id} — ${m.url}`);
    try {
      const r = await runMonitor(db, m, { dryRun });
      console.log('  result:', r);
    } catch (err) {
      console.error(`  ✖ ${err.message}`);
      if (db) await recordError(db, m, err);
    }
  }
  await close();
})();
