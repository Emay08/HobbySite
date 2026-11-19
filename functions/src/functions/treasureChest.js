const { app } = require('@azure/functions');
const { getDb } = require('../lib/db');
const { runTreasureChest } = require('../lib/treasureChest');

/**
 * Ticks every 30 seconds. Each tick reads one small state document and only fetches
 * the Treasure Chest page when it's due: every tick during the 7 days before the
 * "Next Update" date (and up to 7 days after, if the update is late), otherwise once a day.
 * Azure runs timer functions one at a time, so a slow fetch never overlaps the next tick.
 */
app.timer('treasureChest', {
  schedule: '*/30 * * * * *',
  runOnStartup: false,
  handler: async (timer, context) => {
    const db = await getDb();
    try {
      const r = await runTreasureChest(db, { log: (s) => context.log(s) });
      if (!r.skipped) {
        context.log(r.changed ? `Treasure Chest changed: ${r.status || 'baseline'}` : `Treasure Chest unchanged (${r.mode})`);
      }
    } catch (err) {
      context.error(`Treasure Chest check failed: ${err.message}`);
    }
  },
});
