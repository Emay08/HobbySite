const { app } = require('@azure/functions');
const { getDb } = require('../lib/db');
const { runMonitor, recordError } = require('../lib/monitor');
const monitors = require('../lib/monitors.config');

/**
 * Runs every enabled monitor on a timer (default: every 30 minutes).
 * Override the schedule with the MONITOR_SCHEDULE app setting (NCRONTAB, 6 fields).
 */
app.timer('siteMonitor', {
  schedule: '%MONITOR_SCHEDULE%',
  runOnStartup: false,
  handler: async (timer, context) => {
    const db = await getDb();
    const enabled = monitors.filter((m) => m.enabled);
    for (const m of enabled) {
      try {
        const r = await runMonitor(db, m, { log: (s) => context.log(s) });
        context.log(`[${m.id}] extracted=${r.extracted} new=${r.fresh} kept=${r.kept} notified=${r.notified}${r.firstRun ? ' (first run, no notifications)' : ''}`);
      } catch (err) {
        context.error(`[${m.id}] failed: ${err.message}`);
        await recordError(db, m, err).catch(() => {});
      }
    }
  },
});
