const { app } = require('@azure/functions');
const { getDb } = require('../lib/db');
const { runReprints } = require('../lib/reprints');

/**
 * Reprint watch (Scryfall). Hourly at :05; the code skips runs outside 8 am–8 pm Pacific
 * (SPOILER_HOURS), so daylight saving time is handled without changing the schedule.
 */
app.timer('spoilerWatch', {
  schedule: '0 5 * * * *',
  runOnStartup: false,
  handler: async (timer, context) => {
    const db = await getDb();
    try {
      const r = await runReprints(db, { log: (s) => context.log(s) });
      if (r.skipped) return;
      context.log(`Reprints: ${r.printings} printings, ${r.fresh} new, ${r.found.length} owned/watched`);
    } catch (err) {
      context.error(`Reprint check failed: ${err.message}`);
    }
  },
});
