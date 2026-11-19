#!/usr/bin/env node
// Runs the daily job once, locally. Add --no-alert to skip all Telegram messages.
require('./env');
const { getDb, close } = require('../src/lib/db');
const { runDailySync } = require('../src/lib/dailySync');

(async () => {
  const db = await getDb();
  await runDailySync(db, { sendAlerts: !process.argv.includes('--no-alert') });
  await close();
})().catch(async (e) => {
  console.error(e);
  await close();
  process.exit(1);
});
