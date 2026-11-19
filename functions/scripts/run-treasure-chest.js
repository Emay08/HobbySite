#!/usr/bin/env node
// Checks the Treasure Chest page once, ignoring the schedule.
//   node scripts/run-treasure-chest.js --dry-run   parse + compare with the stored snapshot; no saving, no Telegram
//   node scripts/run-treasure-chest.js             real run (saves snapshot, may send Telegram)
require('./env');
const { getDb, close } = require('../src/lib/db');
const tc = require('../src/lib/treasureChest');
const { slotTotals, verifyChangelist } = require('../src/lib/tcParse');
const { parseNextUpdate, parseNumericDate } = require('../src/lib/time');

(async () => {
  const dry = process.argv.includes('--dry-run');
  if (dry) {
    const res = await fetch(tc.TC_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (personal MTGO collection tracker)' } });
    const parsed = tc.parseHtml(await res.text());
    const next = parseNextUpdate(parsed.nextUpdateText, parseNumericDate(parsed.lastUpdatedText) || new Date());
    console.log(`Last updated: ${parsed.lastUpdatedText}\nNext update:  ${parsed.nextUpdateText} → ${next ? next.toISOString() : 'unparsed'}`);
    for (const s of parsed.slots) console.log(`  ${s.name}: ${s.cards.length} rows (${s.rdrText || 'no RDR line'})`);
    const check = verifyChangelist(parsed.changelist, slotTotals(parsed), null);
    console.log(`  ${parsed.changelist.title}: ${parsed.changelist.rows.length} rows; Slots column ${check.ok ? 'matches' : `has ${check.wrongSlots.length} mismatches`}`);
    console.log(`Schedule now: ${tc.schedule({ nextUpdate: next, lastSuccess: new Date() }).mode}`);
    return;
  }
  const db = await getDb();
  const r = await tc.runTreasureChest(db, { force: true, log: console.log });
  console.log(r.message || r);
  await close();
})().catch(async (e) => {
  console.error(e.message);
  await close();
  process.exit(1);
});
