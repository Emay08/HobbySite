/**
 * Shared "lazy until close, then aggressive" schedule for the watchers that run on the
 * 30-second tick (Treasure Chest, banlist, Player Reward Packs).
 *
 *   targets   Dates an update is expected. Inside [target − daysBefore, target + daysAfter]
 *             the watcher checks on every tick, unless `done(target)` says the update for
 *             that target has already been seen.
 *   idleHours Interval outside a window. `unknownHours` when there is no target at all.
 *
 * A watcher that has never succeeded retries every 5 minutes. After a failure it waits
 * at least 15 minutes between idle attempts (on every tick inside a window).
 */
const DAY = 86400000;

function plan({ state, now = new Date(), targets = [], done = () => false, daysBefore = 7, daysAfter = 7, idleHours = 6, unknownHours = 1 }) {
  for (const t of targets.filter(Boolean).map((d) => new Date(d))) {
    const start = new Date(t.getTime() - daysBefore * DAY);
    const end = new Date(t.getTime() + daysAfter * DAY);
    if (now >= start && now <= end && !done(t, start)) return { due: true, mode: 'watching', target: t, windowStart: start, windowEnd: end };
  }
  const known = targets.some(Boolean);
  const mode = known ? 'idle' : 'unknown';
  const next = targets
    .filter(Boolean)
    .map((d) => new Date(new Date(d).getTime() - daysBefore * DAY))
    .filter((s) => s > now)
    .sort((a, b) => a - b)[0];
  const sinceAttempt = state && state.lastAttempt ? now - new Date(state.lastAttempt) : Infinity;
  if (!state || !state.lastSuccess) return { due: sinceAttempt >= 5 * 60000, mode, windowStart: next || null };
  const sinceSuccess = now - new Date(state.lastSuccess);
  const interval = (known ? idleHours : unknownHours) * 3600000;
  return { due: sinceSuccess >= interval && sinceAttempt >= 15 * 60000, mode, windowStart: next || null };
}

module.exports = { plan, DAY };
