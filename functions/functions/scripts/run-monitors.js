#!/usr/bin/env node
// Banlist watch, once.
//   node scripts/run-monitors.js --dry-run   what it would keep from the announcements page + the next
//                                            announcement date; no DB, no Telegram
//   node scripts/run-monitors.js             real run now (ignores the schedule)
require('./env');
const { runMonitor, fetchArticleText } = require('../src/lib/monitor');
const { runBanlist, parseNextAnnouncement, SEED_ARTICLE } = require('../src/lib/banlist');
const monitors = require('../src/lib/monitors.config');
const { getDb, close } = require('../src/lib/db');

(async () => {
  if (process.argv.includes('--dry-run')) {
    const m = monitors.find((x) => x.id === 'banlist');
    console.log(`▶ ${m.url}`);
    const r = await runMonitor(null, m, { dryRun: true });
    const article = (r.items[0] && r.items[0].url) || SEED_ARTICLE;
    const next = parseNextAnnouncement(await fetchArticleText(article));
    console.log(`  next announcement (from ${article}): ${next ? next.date.toISOString() + ` ("${next.text}")` : 'not found'}`);
  } else {
    const db = await getDb();
    console.log(await runBanlist(db, { force: true, log: console.log }));
  }
  await close();
})().catch(async (e) => {
  console.error(e.message);
  await close();
  process.exit(1);
});
