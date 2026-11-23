/**
 * Page fetching for the watchers. Node's fetch reports every connection problem as just
 * "fetch failed"; the real reason (DNS, refused or reset connection, timeout, certificate)
 * is in err.cause. `describe` puts it in the message so the Monitors panel shows it, and
 * a network error is retried once after a short pause before the check counts as failed.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function describe(err) {
  if (!err) return 'unknown error';
  if (err.name === 'TimeoutError') return 'timed out';
  const c = err.cause;
  const why = c && [c.code, c.message].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(': ');
  return why && !String(err.message).includes(why) ? `${err.message} (${why})` : String(err.message || err);
}

async function fetchHtml(url, { headers = {}, timeoutMs = 25000, retries = 1, retryDelayMs = 3000, fetchImpl = fetch } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (personal MTGO collection tracker)', Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9', 'Cache-Control': 'no-cache', ...headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (attempt < retries) {
        await sleep(retryDelayMs);
        continue;
      }
      throw new Error(`${describe(err)} — ${url}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.text();
  }
}

module.exports = { fetchHtml, describe };
