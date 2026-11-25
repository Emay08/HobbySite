/**
 * The home runner: a small always-on process on hobbymini (scripts/home-runner.js). It does
 * the jobs that sites refuse from Azure's addresses but answer from a home connection:
 *
 *   - the Treasure Chest and Player Reward Pack watchers (mtgo.com), on the same 30-second
 *     tick and schedule as in Azure;
 *   - Cardhoarder lookups for card pages: the website puts a request in `vendor_requests`,
 *     the runner fetches it (one search per card page you open, as if you'd searched their
 *     site) and writes the result back.
 *
 * It writes a heartbeat to monitor_state 'home-runner' every tick. While that's under
 * HOME_RUNNER_STALE_MS old, Azure leaves the two mtgo.com watchers to it and the website
 * sends Cardhoarder lookups to it; when hobbymini is off, Azure and the website go back to
 * doing them directly.
 */
const os = require('os');

const STATE_ID = 'home-runner';
const STALE_MS = 3 * 60000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const BLOCK_BACKOFF_MS = 6 * 3600 * 1000;

async function heartbeat(db, { now = new Date(), host = os.hostname(), startedAt, extra = {} } = {}) {
  await db.collection('monitor_state').updateOne(
    { _id: STATE_ID },
    { $set: { label: `Home runner (${host})`, host, lastBeat: now, startedAt, ...extra } },
    { upsert: true }
  );
}

/** True while the home runner has checked in recently. */
async function homeRunnerActive(db, now = new Date()) {
  const s = await db.collection('monitor_state').findOne({ _id: STATE_ID }, { projection: { lastBeat: 1 } });
  return !!(s && s.lastBeat && now - new Date(s.lastBeat) < STALE_MS);
}

// ------------------------------------------------------------------ Cardhoarder

const norm = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && String(v).trim() !== '-' ? n : null;
};

/** Same rows as web/lib/vendors.js parseCardhoarder. */
function parseCardhoarder(json, name) {
  const rows = (json && json.data && json.data.cards && json.data.cards.data) || [];
  return rows
    .filter((c) => norm(c.name) === norm(name))
    .map((c) => ({
      mtgoId: String(c.id),
      set: c.set_code || (c.set && c.set.code) || '',
      foil: !!c.is_foil,
      sell: num(c.amount),
      buy: c.is_buylisted ? num(c.amount_buy) : null,
      stock: Number.isFinite(c.quantity_for_purchase) ? c.quantity_for_purchase : null,
      label: `${c.set_code}${c.set_number ? ` #${c.set_number}` : ''}`,
    }));
}

const blocked = { until: 0 };

async function cardhoarder(name, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (blocked.until > now) throw Object.assign(new Error('blocked by Cardhoarder (HTTP 403), also from home'), { blocked: true });
  const params = new URLSearchParams({ cardname: `"${name}"`, sort: 'release-date:number-asc', page: '1' });
  const out = [];
  for (let page = 1; page <= 5; page++) {
    params.set('page', String(page));
    const res = await fetchImpl(`https://www.cardhoarder.com/cards/search?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 403) {
      blocked.until = now + BLOCK_BACKOFF_MS;
      throw Object.assign(new Error('blocked by Cardhoarder (HTTP 403), also from home'), { blocked: true });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    out.push(...parseCardhoarder(json, name));
    const meta = json.data && json.data.cards && json.data.cards.meta;
    if (!meta || meta.current_page >= meta.last_page) break;
  }
  return out;
}

/** Answers every pending Cardhoarder request. Returns how many were handled. */
async function serveVendorRequests(db, { fetchImpl = fetch, now = () => new Date(), log = () => {} } = {}) {
  const coll = db.collection('vendor_requests');
  let handled = 0;
  for (;;) {
    const req = await coll.findOneAndUpdate(
      { vendor: 'cardhoarder', status: 'pending' },
      { $set: { status: 'working', startedAt: now() } },
      { sort: { requestedAt: 1 }, returnDocument: 'after' }
    );
    const doc = req && req.value !== undefined ? req.value : req; // driver 5 vs 6
    if (!doc) return handled;
    let result;
    try {
      result = { ok: true, rows: await cardhoarder(doc.name, { fetchImpl, now: now().getTime() }) };
    } catch (err) {
      result = { ok: false, error: err.name === 'TimeoutError' ? 'timed out' : err.message, ...(err.blocked ? { blocked: true } : {}) };
      log(`Cardhoarder "${doc.name}": ${result.error}`);
    }
    await coll.updateOne({ _id: doc._id }, { $set: { status: 'done', result, doneAt: now() } });
    handled++;
  }
}

module.exports = { heartbeat, homeRunnerActive, serveVendorRequests, cardhoarder, parseCardhoarder, STATE_ID, STALE_MS, _blocked: blocked };
