const crypto = require('crypto');
const { parseHTML } = require('linkedom');
const { parseTreasureChest, slotTotals, slotDelta, verifyChangelist } = require('./tcParse');
const { parseNextUpdate, parseNumericDate } = require('./time');
const names = require('./names');
const telegram = require('./telegram');
const { recordFailure, successFields } = require('./health');

const TC_URL = process.env.TC_URL || 'https://www.mtgo.com/news/mtgo-treasure-chest-info';
const STATE_ID = 'treasure-chest';
const LABEL = 'Treasure Chest page';
const DAY = 86400000;

const config = () => ({
  daysBefore: Number(process.env.TC_WINDOW_DAYS_BEFORE || 7), // start fast polling this long before "Next Update"
  daysAfter: Number(process.env.TC_WINDOW_DAYS_AFTER || 7), // keep fast polling this long after it, in case the update is late
  idleHours: Number(process.env.TC_IDLE_HOURS || 24), // check interval outside the window
  unknownHours: Number(process.env.TC_UNKNOWN_HOURS || 1), // check interval when "Next Update" can't be read
  keepSnapshots: 30,
});

const sha1 = (v) => crypto.createHash('sha1').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

/** Decides whether this 30-second tick should fetch the page. */
function schedule(state, now = new Date(), cfg = config()) {
  const nu = state && state.nextUpdate ? new Date(state.nextUpdate) : null;
  if (nu) {
    const start = new Date(nu.getTime() - cfg.daysBefore * DAY);
    const end = new Date(nu.getTime() + cfg.daysAfter * DAY);
    if (now >= start && now <= end) return { due: true, mode: 'watching', windowStart: start, windowEnd: end };
  }
  const intervalMs = (nu ? cfg.idleHours : cfg.unknownHours) * 3600000;
  const mode = nu ? 'daily' : 'hourly';
  if (!state || !state.lastSuccess) {
    // never succeeded: try now, but at most every 5 minutes while it keeps failing
    const since = state && state.lastAttempt ? now - new Date(state.lastAttempt) : Infinity;
    return { due: since >= 5 * 60000, mode };
  }
  const sinceSuccess = now - new Date(state.lastSuccess);
  const sinceAttempt = state.lastAttempt ? now - new Date(state.lastAttempt) : Infinity;
  return { due: sinceSuccess >= intervalMs && sinceAttempt >= 15 * 60000, mode };
}

async function fetchPage(url = TC_URL) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (personal MTGO collection tracker)',
      Accept: 'text/html',
      'Cache-Control': 'no-cache',
    },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

function parseHtml(html) {
  const { document } = parseHTML(html);
  const parsed = parseTreasureChest(document);
  if (!parsed.slots.length) throw new Error('No slot tables found — the page layout may have changed');
  if (!parsed.changelist) throw new Error('No CHANGELIST table found — the page layout may have changed');
  return parsed;
}

/**
 * One tick. Returns a summary object. Options:
 *   force   – ignore the schedule
 *   html    – use this HTML instead of fetching (tests, dry runs)
 *   notify  – false to skip Telegram (dry runs)
 */
async function runTreasureChest(db, { now = new Date(), force = false, html = null, notify = true, log = () => {} } = {}) {
  const stateColl = db.collection('monitor_state');
  const state = (await stateColl.findOne({ _id: STATE_ID })) || null;
  const plan = schedule(state, now);
  if (!force && !plan.due) return { skipped: true, mode: plan.mode };

  await stateColl.updateOne({ _id: STATE_ID }, { $set: { label: LABEL, url: TC_URL, lastAttempt: now } }, { upsert: true });

  let parsed;
  try {
    parsed = parseHtml(html ?? (await fetchPage()));
  } catch (err) {
    await recordFailure(db, STATE_ID, LABEL, err, { now, afterMs: plan.mode === 'watching' ? 30 * 60000 : 6 * 3600000 });
    throw err;
  }

  const reference = parseNumericDate(parsed.lastUpdatedText) || now;
  const nextUpdate = parseNextUpdate(parsed.nextUpdateText, reference);
  const newPlan = schedule({ ...state, nextUpdate, lastSuccess: now }, now);
  const hash = sha1(parsed);
  const base = {
    label: LABEL,
    url: TC_URL,
    lastChecked: now,
    nextUpdate,
    nextUpdateText: parsed.nextUpdateText,
    lastUpdatedText: parsed.lastUpdatedText,
    mode: newPlan.mode,
    windowStart: nextUpdate ? new Date(nextUpdate.getTime() - config().daysBefore * DAY) : null,
    ...successFields(now),
  };

  if (state && state.lastHash === hash) {
    await stateColl.updateOne({ _id: STATE_ID }, { $set: base });
    return { changed: false, mode: newPlan.mode };
  }

  const snaps = db.collection('tc_snapshots');
  const { insertedId } = await snaps.insertOne({ takenAt: now, hash, parsed });
  const prev = state && state.latestSnapshotId ? await snaps.findOne({ _id: state.latestSnapshotId }) : null;

  // ---- first ever snapshot: remember it, check the CHANGELIST's "Slots" column, no message
  if (!prev) {
    const check = verifyChangelist(parsed.changelist, slotTotals(parsed), null);
    await stateColl.updateOne(
      { _id: STATE_ID },
      { $set: { ...base, lastHash: hash, latestSnapshotId: insertedId, cycleBaseId: insertedId, lastStatus: 'baseline' } }
    );
    const cardCount = parsed.slots.reduce((n, s) => n + s.cards.length, 0);
    await addHighlight(db, now, {
      title: `Started tracking the Treasure Chest page (${cardCount} entries in ${parsed.slots.length} slot tables)`,
      summary: check.ok
        ? 'CHANGELIST "Slots" column matches the slot tables.'
        : `${check.wrongSlots.length} CHANGELIST rows disagree with the slot tables.`,
    });
    log(`baseline stored: ${cardCount} entries, changelist slots check ${check.ok ? 'ok' : 'failed'}`);
    return { changed: true, firstRun: true, check };
  }

  // The CHANGELIST is checked against the page as it was before the current update
  // began ("cycle base"). A new cycle starts when the slot tables change after a
  // consistent state, or when the update date in the section headings changes.
  const prevStatus = state.lastStatus || 'baseline';
  const prevConsistent = ['ok', 'meta', 'baseline'].includes(prevStatus);
  const slotsChanged = slotDelta(slotTotals(prev.parsed), slotTotals(parsed)).length > 0;
  const dateChanged = sectionDate(prev.parsed) !== sectionDate(parsed);
  let baseline =
    (state.cycleBaseId && (await snaps.findOne({ _id: state.cycleBaseId }))) ||
    (state.baselineSnapshotId && (await snaps.findOne({ _id: state.baselineSnapshotId }))) ||
    prev;
  if (slotsChanged && (prevConsistent || dateChanged)) baseline = prev;

  const result = analyse(prev.parsed, baseline.parsed, parsed);
  result.prevStatus = prevStatus;

  // ---- who cares about the added cards?
  const added = result.step.filter((d) => d.from === 0 && d.to > 0);
  const index = await names.loadInterestIndex(db);
  const matches = [];
  const seen = new Set();
  for (const d of added) {
    const m = names.lookup(index, d.name);
    if (m && !seen.has(m)) {
      seen.add(m);
      matches.push(m);
    }
  }
  const updateLabel = result.sectionDate ? `Treasure Chest ${result.sectionDate}` : 'Treasure Chest update';
  const autoAdded = notify ? await names.addToShortWatch(db, matches, `Auto-added: ${updateLabel}`) : [];

  const message = buildMessage(result, parsed, matches, autoAdded);
  let notified = false;
  if (notify) {
    try {
      const sent = await telegram.sendLong(message);
      notified = !(sent[0] && sent[0].skipped);
    } catch (err) {
      log(`Telegram failed: ${err.message}`);
    }
  }

  await addHighlight(db, now, {
    title: `Treasure Chest page updated${result.sectionDate ? ` — ${result.sectionDate}` : ''}`,
    summary: summaryLine(result, matches),
    notified,
  });

  await stateColl.updateOne(
    { _id: STATE_ID },
    {
      $set: {
        ...base,
        lastHash: hash,
        latestSnapshotId: insertedId,
        cycleBaseId: baseline._id,
        lastStatus: result.status,
        lastChangeAt: now,
      },
    }
  );

  // prune old snapshots (never the baseline)
  const old = await snaps.find({}, { projection: { _id: 1 } }).sort({ takenAt: -1 }).skip(config().keepSnapshots).toArray();
  const protect = new Set([String(baseline._id), String(insertedId)]);
  const del = old.map((o) => o._id).filter((id) => !protect.has(String(id)));
  if (del.length) await snaps.deleteMany({ _id: { $in: del } });

  return { changed: true, status: result.status, step: result.step, problems: result.problems, matches: matches.map((m) => m.name), autoAdded, notified, message };
}

/** "November 10" from the "CURATED CARD LISTS - November 10" heading. */
function sectionDate(parsed) {
  const curated = (parsed.sectionTitles || []).find((t) => /curated card lists/i.test(t)) || '';
  return (curated.match(/-\s*(.+)$/) || [])[1] || null;
}

/**
 * Compares snapshots.
 *   step   – card changes since the previous check (what's new right now)
 *   cycle  – card changes since the last consistent state (what the CHANGELIST should list)
 *   status – ok | stale (CHANGELIST not updated) | mismatch | meta (no card changes)
 */
function analyse(prevParsed, baselineParsed, parsed) {
  const prevTotals = slotTotals(prevParsed);
  const baseTotals = slotTotals(baselineParsed);
  const newTotals = slotTotals(parsed);
  const step = slotDelta(prevTotals, newTotals);
  const cycle = slotDelta(baseTotals, newTotals);
  // Rows only: the heading date may be bumped even when the rows weren't updated.
  const clSameAsBaseline = sha1(parsed.changelist.rows) === sha1(baselineParsed.changelist.rows);

  let status;
  let problems = null;
  if (clSameAsBaseline) {
    status = cycle.length ? 'stale' : 'meta';
  } else {
    problems = verifyChangelist(parsed.changelist, newTotals, cycle);
    status = problems.ok ? 'ok' : 'mismatch';
  }

  const prevSlots = new Set(prevParsed.slots.map((s) => s.name));
  const newSlots = new Set(parsed.slots.map((s) => s.name));

  const metaChanges = [];
  for (const [k, label] of [['nextUpdateText', 'Next update'], ['lastUpdatedText', 'Last updated'], ['effectiveText', 'Effective']]) {
    if ((prevParsed[k] || '') !== (parsed[k] || '')) metaChanges.push(`${label}: ${parsed[k] || '—'}`);
  }
  if (sha1(prevParsed.otherTables.map((t) => t.rows)) !== sha1(parsed.otherTables.map((t) => t.rows))) {
    metaChanges.push('Slot odds / play point tables changed');
  }

  // Each slot table states "Total RDR in this list – N"; it should equal the sum of its rows.
  const rdrProblems = parsed.slots
    .map((sl) => {
      const stated = parseInt(((sl.rdrText || '').match(/(\d+)\s*$/) || [])[1], 10);
      const sum = sl.cards.reduce((n, c) => n + (c.slots || 0), 0);
      return Number.isFinite(stated) && stated !== sum ? { slot: sl.name, stated, sum } : null;
    })
    .filter(Boolean);

  return {
    step,
    cycle,
    status,
    rdrProblems,
    problems,
    sectionDate: sectionDate(parsed),
    slotsAdded: [...newSlots].filter((s) => !prevSlots.has(s)),
    slotsRemoved: [...prevSlots].filter((s) => !newSlots.has(s)),
    metaChanges,
  };
}

function cardLabel(d, e) {
  return `${e(d.name)} (${e(d.set)}${d.treatment ? `, ${e(d.treatment)}` : ''})`;
}

function buildMessage(r, parsed, matches, autoAdded) {
  const e = telegram.escapeHtml;
  const lines = [`💰 <b>Treasure Chest page updated</b>${r.sectionDate ? ` — ${e(r.sectionDate)}` : ''}`];
  const adds = r.step.filter((d) => d.from === 0 && d.to > 0).length;
  const removes = r.step.filter((d) => d.to === 0).length;
  const weights = r.step.length - adds - removes;
  if (r.step.length) lines.push(`${adds} added · ${removes} removed · ${weights} odds changes`);
  if (r.slotsAdded.length) lines.push(`New slot table: ${r.slotsAdded.map(e).join(', ')}`);
  if (r.slotsRemoved.length) lines.push(`Slot table gone: ${r.slotsRemoved.map(e).join(', ')}`);
  for (const m of r.metaChanges) lines.push(e(m));

  if (r.status === 'ok') {
    if (r.step.length) lines.push('✅ CHANGELIST matches the slot tables.');
    else if (r.prevStatus === 'stale' || r.prevStatus === 'mismatch') lines.push('✅ The CHANGELIST has now been updated and matches the slot tables.');
    else lines.push('✅ The CHANGELIST was edited; it still matches the slot tables.');
  }
  for (const p of r.rdrProblems || []) {
    lines.push(`⚠️ ${e(p.slot)}: page says total RDR ${p.stated}, rows add up to ${p.sum}`);
  }
  if (r.status === 'meta' && !r.step.length) lines.push('No card changes.');
  if (r.status === 'stale') {
    lines.push('⚠️ <b>The CHANGELIST was not updated.</b> The changes here are worked out from the slot tables.');
  }
  if (r.status === 'mismatch') {
    const p = r.problems;
    lines.push(`⚠️ <b>CHANGELIST doesn't match the slot tables</b> (${p.missing.length + p.wrongChange.length + p.unexpected.length + p.wrongSlots.length} problems):`);
    const items = [
      ...p.missing.map((d) => `• ${cardLabel(d, e)}: changed ${d.change > 0 ? '+' : ''}${d.change} but not listed`),
      ...p.wrongChange.map((d) => `• ${cardLabel(d, e)}: listed ${d.listed > 0 ? '+' : ''}${d.listed}, actually ${d.change > 0 ? '+' : ''}${d.change}`),
      ...p.unexpected.map((d) => `• ${cardLabel(d, e)}: listed (${d.change > 0 ? '+' : ''}${d.change}) but the slot tables didn't change`),
      ...p.wrongSlots.map((d) => `• ${cardLabel(d, e)}: listed Slots ${d.slots}, tables show ${d.actual}`),
    ];
    lines.push(...items.slice(0, 15));
    if (items.length > 15) lines.push(`…and ${items.length - 15} more`);
  }

  lines.push('');
  if (matches.length) {
    lines.push(`<b>Added cards you own or watch (${matches.length}):</b>`);
    for (const m of matches) lines.push(`• ${names.describeMatch(m, e)}`);
    if (autoAdded.length) lines.push(`<i>Added to your short-term watch list: ${autoAdded.length}</i>`);
  } else if (adds) {
    lines.push('None of the added cards are in your collection or watch lists.');
  }
  lines.push('');
  lines.push(e(TC_URL));
  return lines.join('\n');
}

function summaryLine(r, matches) {
  const adds = r.step.filter((d) => d.from === 0 && d.to > 0).length;
  const removes = r.step.filter((d) => d.to === 0).length;
  const parts = [];
  if (r.step.length) parts.push(`${adds} added, ${removes} removed`);
  else parts.push(r.metaChanges.join('; ') || 'No card changes');
  if (r.status === 'stale') parts.push('CHANGELIST not updated');
  if (r.status === 'mismatch') parts.push("CHANGELIST doesn't match the slot tables");
  if (matches.length) parts.push(`Yours / watched: ${matches.map((m) => m.name).join(', ')}`);
  return parts.join(' · ').slice(0, 600);
}

async function addHighlight(db, now, { title, summary, notified = false }) {
  await db.collection('highlights').insertOne({
    _id: sha1(`${STATE_ID}|${now.toISOString()}|${title}`),
    source: LABEL,
    monitorId: STATE_ID,
    title,
    url: TC_URL,
    category: 'treasure-chest',
    summary,
    detectedAt: now,
    notified,
  });
}

module.exports = { runTreasureChest, schedule, analyse, sectionDate, buildMessage, parseHtml, TC_URL, STATE_ID };
