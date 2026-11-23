/**
 * Banlist watch: Wizards' announcements page, "Banned" titles only (rules in
 * monitors.config.js), on the 30-second tick.
 *
 * Each banned & restricted article ends with "Next announcement: November 30, 2026". That
 * date is read from the newest one and drives the schedule: Wizards is punctual, so every
 * 30 seconds from BANLIST_WINDOW_DAYS_BEFORE (1) day before it until a new "Banned"
 * announcement appears (or BANLIST_WINDOW_DAYS_AFTER (2) days after, if it's late), except
 * on weekends; every BANLIST_IDLE_HOURS (6)
 * otherwise, so unscheduled emergency bans are still caught the same day. Without a known
 * date: hourly.
 */
const monitors = require('./monitors.config');
const { runMonitor, fetchText, fetchArticleText } = require('./monitor');
const { parseNextUpdate } = require('./time');
const { plan } = require('./cadence');
const { recordFailure, successFields } = require('./health');

const STATE_ID = 'banlist';
// Used once, to learn the next date before any announcement has been seen.
const SEED_ARTICLE = 'https://magic.wizards.com/en/news/announcements/banned-and-restricted-october-12-2026';

const cfg = () => ({
  daysBefore: Number(process.env.BANLIST_WINDOW_DAYS_BEFORE || 1),
  daysAfter: Number(process.env.BANLIST_WINDOW_DAYS_AFTER || 2),
  idleHours: Number(process.env.BANLIST_IDLE_HOURS || 6),
  unknownHours: 1,
});

/** "…Next announcement: November 30, 2026…" / "the next banned and restricted announcement will be on November 30, 2026" */
function parseNextAnnouncement(text, reference = new Date()) {
  const m = String(text || '').match(
    /next (?:banned (?:and|&) restricted )?announcement(?:\s+will be)?(?:\s+on)?\s*:?\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4})/i
  );
  return m ? { text: m[1], date: parseNextUpdate(m[1], reference) } : null;
}

async function clearRetired(db) {
  const ids = monitors.retired || [];
  if (!ids.length) return;
  await db.collection('monitor_state').deleteMany({ _id: { $in: ids } });
  await db.collection('highlights').deleteMany({ monitorId: { $in: ids } });
}

async function runBanlist(db, { now = new Date(), force = false, fetcher = fetchText, log = () => {} } = {}) {
  const monitor = monitors.find((m) => m.id === STATE_ID);
  if (!monitor || !monitor.enabled) return { skipped: 'disabled' };
  const coll = db.collection('monitor_state');
  const state = await coll.findOne({ _id: STATE_ID });
  const c = cfg();
  const p = plan({ state, now, targets: [state && state.nextAnnouncement], ...c });
  if (!force && !p.due) return { skipped: true, mode: p.mode };
  await coll.updateOne({ _id: STATE_ID }, { $set: { label: monitor.label, url: monitor.url, lastAttempt: now } }, { upsert: true });
  if (!state || !state.lastSuccess) await clearRetired(db);

  try {
    const r = await runMonitor(db, monitor, { log, fetcher, now });
    if (!r.extracted) throw new Error('No announcements found on the page — the layout may have changed');

    // Learn the next scheduled date from the newest banned & restricted article.
    let next = null;
    const article = (r.items && r.items[0] && r.items[0].url) || (!(state && state.nextAnnouncement) ? SEED_ARTICLE : null);
    if (article) {
      try {
        next = parseNextAnnouncement(await fetchArticleText(article, fetcher), now);
        log(`Banlist: ${article} → next announcement ${next ? next.text : 'not stated'}`);
      } catch (err) {
        log(`Banlist: could not read ${article}: ${err.message}`);
      }
    }
    const set = { lastChecked: now, ...successFields(now) };
    if (article) {
      // A new announcement without a stated next date leaves the date unknown (hourly checks).
      set.nextAnnouncement = next && next.date > now ? next.date : null;
      set.nextAnnouncementText = next && next.date > now ? next.text : null;
      set.nextFrom = article;
    }
    const after = plan({ state: { ...state, ...set }, now, targets: [article ? set.nextAnnouncement : state && state.nextAnnouncement], ...c });
    set.mode = after.mode;
    set.windowStart = after.mode === 'watching' ? null : after.windowStart;
    await coll.updateOne({ _id: STATE_ID }, { $set: set }, { upsert: true });
    return { ...r, next: set.nextAnnouncement ?? (state && state.nextAnnouncement) ?? null, mode: after.mode };
  } catch (err) {
    await recordFailure(db, STATE_ID, monitor.label, err, { now, afterMs: p.mode === 'watching' ? 30 * 60000 : 12 * 3600000 });
    throw err;
  }
}

module.exports = { runBanlist, parseNextAnnouncement, clearRetired, STATE_ID, SEED_ARTICLE };
