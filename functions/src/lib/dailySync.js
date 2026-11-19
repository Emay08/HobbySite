const prices = require('./prices');
const cards = require('./cards');
const alerts = require('./alerts');

/**
 * The whole daily job, shared by the Azure timer and the local script:
 *   1. card definitions (names/sets for every MTGO ID — powers the card search)
 *   2. prices
 *   3. price history for tracked cards
 *   4. collection value snapshot
 *   5. price targets / version swaps: update hit & ready flags for the website
 *      (Telegram for these is off unless enabled with NOTIFY_* settings)
 */
async function runDailySync(db, { log = console.log, sendAlerts = true } = {}) {
  try {
    const defs = await cards.downloadCardDefinitions();
    log(`Stored ${await cards.storeCards(db, defs)} card definitions`);
  } catch (err) {
    // Not fatal: the site falls back to searching your own collection.
    log(`Card definitions skipped: ${err.message}`);
  }

  const { prices: map, file } = await prices.downloadPrices();
  log(`Stored ${await prices.storePrices(db, map)} prices from ${file}`);
  log(`Recorded history for ${await alerts.recordTrackedHistory(db, map)} tracked cards`);

  const yesterday = await db.collection('value_history').find().sort({ date: -1 }).limit(1).next();
  const today = await prices.recordCollectionValue(db);
  log(`Collection value ${today.totalValue.toFixed(2)} tix`);

  if (!sendAlerts) return;

  const run = async (name, fn) => {
    try {
      const n = await fn();
      log(`${name}: ${n} alert item(s)`);
    } catch (err) {
      log(`${name} failed: ${err.message}`);
    }
  };
  await run('Price targets', () => alerts.checkTargets(db, map));
  await run('Version swaps', () => alerts.checkSwaps(db, map));
  await run('Short-term watch list', () => alerts.checkShortWatch(db, map));
  // Off unless NOTIFY_COLLECTION_MOVERS=true (PRICE_ALERTS is no longer used).
  if (String(process.env.NOTIFY_COLLECTION_MOVERS).toLowerCase() === 'true') {
    await run('Collection movers', async () => {
      const movers = await prices.findMovers(db, {
        minPct: Number(process.env.PRICE_ALERT_MIN_PCT || 25),
        minTix: Number(process.env.PRICE_ALERT_MIN_TIX || 2),
      });
      if (movers.length) await prices.sendMoversAlert(movers, today, yesterday && yesterday.date !== today.date ? yesterday : null);
      return movers.length;
    });
  }
}

module.exports = { runDailySync };
