const telegram = require('./telegram');

/**
 * Records a monitor failure and, if it has been failing for longer than `afterMs`,
 * sends one Telegram warning (at most once a day) so a broken scraper isn't silent.
 */
async function recordFailure(db, id, label, err, { afterMs = 60 * 60 * 1000, now = new Date() } = {}) {
  const coll = db.collection('monitor_state');
  const state = (await coll.findOne({ _id: id })) || {};
  const failingSince = state.failingSince || now;
  const set = {
    label,
    lastError: String((err && err.message) || err).slice(0, 300),
    lastErrorAt: now,
    failingSince,
  };
  const failingFor = now - new Date(failingSince);
  const lastWarned = state.failureWarnedAt ? now - new Date(state.failureWarnedAt) : Infinity;
  if (failingFor >= afterMs && lastWarned >= 24 * 3600 * 1000) {
    try {
      const e = telegram.escapeHtml;
      await telegram.sendMessage(
        `⚠️ <b>${e(label)} isn't working</b>\nFailing for ${Math.round(failingFor / 60000)} min: ${e(set.lastError)}`,
        { disablePreview: true }
      );
      set.failureWarnedAt = now;
    } catch {
      /* best effort */
    }
  }
  await coll.updateOne({ _id: id }, { $set: set }, { upsert: true });
}

/** Clears the failure state after a successful run. */
function successFields(now = new Date()) {
  return { lastError: null, failingSince: null, failureWarnedAt: null, lastSuccess: now };
}

module.exports = { recordFailure, successFields };
