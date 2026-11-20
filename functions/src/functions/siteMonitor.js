const { app } = require('@azure/functions');
const { getDb } = require('../lib/db');
const { runMonitor, recordError } = require('../lib/monitor');
const { runRewardPacks } = require('../lib/rewardPacks');
const monitors = require('../lib/monitors.config');

/** Clears the state and feed entries of monitors that have been removed. */
async function clearRetired(db) {
  const ids = monitors.retired || [];
  if (!ids.length) return;
  await db.collection('monitor_state').deleteMany({ _id: { $in: ids } });
  await db.collection('highlights').deleteMany({ monitorId: { $in: ids } });
}

/**
 * Every 30 minutes (MONITOR_SCHEDULE): the banlist watch, and the Player Reward Pack
 * page (which checks itself at most every 6 hours).
 */
app.timer('siteMonitor', {
  schedule: '%MONITOR_SCHEDULE%',
  runOnStartup: false,
  handler: async (timer, context) => {
    const db = await getDb();
    await clearRetired(db).catch((err) => context.error(`Clearing retired monitors failed: ${err.message}`));
    for (const m of monitors.filter((x) => x.enabled)) {
      try {
        const r = await runMonitor(db, m, { log: (s) => context.log(s) });
        context.log(`[${m.id}] extracted=${r.extracted} new=${r.fresh} kept=${r.kept} notified=${r.notified}${r.firstRun ? ' (first run, no notifications)' : ''}`);
      } catch (err) {
        context.error(`[${m.id}] failed: ${err.message}`);
        await recordError(db, m, err).catch(() => {});
      }
    }
    try {
      const r = await runRewardPacks(db, { log: (s) => context.log(s) });
      if (!r.skipped) context.log(`Player Reward Packs: ${r.cards} cards${r.changed ? ` (changed: +${r.added.length} −${r.removed.length})` : ''}`);
    } catch (err) {
      context.error(`Player Reward Pack check failed: ${err.message}`);
    }
  },
});

module.exports = { clearRetired };
