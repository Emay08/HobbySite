/**
 * Downloads one of GoatBots' daily files, trying each known location in turn
 * (GoatBots serves them under /download/prices/; the older /download/ path is kept as
 * a fallback). An environment override, if set, is tried first.
 */
async function downloadFirst(urls, what) {
  const errors = [];
  for (const url of urls.filter(Boolean)) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'personal MTGO collection tracker' },
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) {
        errors.push(`${url}: HTTP ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
        errors.push(`${url}: not a zip file`);
        continue;
      }
      return buf;
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }
  throw new Error(`${what} download failed — ${errors.join('; ')}`);
}

module.exports = { downloadFirst };
