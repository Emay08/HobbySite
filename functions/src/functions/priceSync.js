const { app } = require('@azure/functions');
const { getDb } = require('../lib/db');
const { runDailySync } = require('../lib/dailySync');

/**
 * Daily: card definitions + GoatBots prices, tracked-card history, collection value,
 * then Telegram alerts for price targets, version swaps, the short-term watch list
 * and (optionally) big movers in your collection.
 * Schedule via PRICE_SYNC_SCHEDULE (NCRONTAB, UTC).
 */
app.timer('priceSync', {
  schedule: '%PRICE_SYNC_SCHEDULE%',
  runOnStartup: false,
  handler: async (timer, context) => {
    const db = await getDb();
    await runDailySync(db, { log: (s) => context.log(s) });
  },
});
