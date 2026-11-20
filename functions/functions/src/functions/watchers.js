const { app } = require('@azure/functions');
const { getDb } = require('../lib/db');
const { runTreasureChest } = require('../lib/treasureChest');
const { runBanlist } = require('../lib/banlist');
const { runRewardPacks } = require('../lib/rewardPacks');

/**
 * One timer for every page that needs fast checks near its update date: the Treasure
 * Chest, the banlist and the Player Reward Packs. It ticks every 30 seconds; each watcher
 * reads its own small state document and only fetches its page when it's due (every tick
 * inside its window, every few hours otherwise). Sharing one timer keeps the Function App
 * at ~86,400 executions a month however many watchers there are.
 * Azure runs a timer function one tick at a time, so a slow fetch never overlaps the next tick.
 */
const WATCHERS = [
  ['Treasure Chest', runTreasureChest, (r) => (r.changed ? `changed: ${r.status || 'baseline'}` : `unchanged (${r.mode})`)],
  ['Banlist', runBanlist, (r) => `extracted=${r.extracted} new=${r.fresh} kept=${r.kept} notified=${r.notified} (${r.mode})`],
  ['Player Reward Packs', runRewardPacks, (r) => `${r.cards} cards${r.changed ? `, changed: +${r.added.length} −${r.removed.length}` : ''}`],
];

app.timer('watchers', {
  schedule: '*/30 * * * * *',
  runOnStartup: false,
  handler: async (timer, context) => {
    const db = await getDb();
    await Promise.all(
      WATCHERS.map(async ([label, run, describe]) => {
        try {
          const r = await run(db, { log: (s) => context.log(s) });
          if (!r.skipped) context.log(`${label}: ${describe(r)}`);
        } catch (err) {
          context.error(`${label} check failed: ${err.message}`);
        }
      })
    );
  },
});
