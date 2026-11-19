const { app } = require('@azure/functions');
const { getDb } = require('../lib/db');
const { runSpoilers } = require('../lib/spoilers');

/**
 * Hourly at :05; the code skips runs outside 8 am–8 pm Pacific (SPOILER_HOURS),
 * so daylight saving time is handled without changing the schedule.
 */
app.timer('spoilerWatch', {
  schedule: '0 5 * * * *',
  runOnStartup: false,
  handler: async (timer, context) => {
    const db = await getDb();
    try {
      const r = await runSpoilers(db, { log: (s) => context.log(s) });
      if (r.skipped) return;
      context.log(`Spoilers: ${r.pages.length} pages, ${r.found.length} owned/watched cards found`);
    } catch (err) {
      context.error(`Spoiler check failed: ${err.message}`);
    }
  },
});
