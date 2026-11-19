/**
 * Live prices from MTGO vendors, fetched on demand for one card name at a time
 * (when you open a card page) and cached briefly. Low volume by design: one request
 * per vendor per card view, the same as searching their site by hand.
 *
 * GoatBots is deliberately not here: its live prices are drawn as obfuscated images
 * to stop automated reading, and it publishes a daily price file for projects like
 * this one instead (used by the daily price sync).
 *
 * Wording from your side of the trade:
 *   sell = the vendor's selling price (what you pay to buy from them)
 *   buy  = the vendor's buying price (what you get if you sell to them)
 */
const { parseHTML } = require('linkedom');

const TTL_MS = 2 * 60 * 1000;
const TIMEOUT_MS = 8000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const cache = new Map();

const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && String(v).trim() !== '-' ? n : null;
};
const norm = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

// ------------------------------------------------------------------ Cardhoarder

/** Parses Cardhoarder's /cards/search JSON. Its card id is the MTGO catalog ID. */
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

async function cardhoarder(name, fetchImpl = fetch) {
  const params = new URLSearchParams({
    cardname: `"${name}"`, set_code: '', format: '', price_gte: '', price_lte: '', sort: 'release-date:number-asc',
    is_rentable_only: '', is_buylisted_only: '', in_stock_for_purchase: '', in_stock_for_rent: '', exclude_promos: '',
    finish: '', rarity: '', page: '1',
  });
  const out = [];
  for (let page = 1; page <= 5; page++) {
    params.set('page', String(page));
    const res = await fetchImpl(`https://www.cardhoarder.com/cards/search?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(res.status === 403 ? 'blocked (HTTP 403)' : `HTTP ${res.status}`);
    const json = await res.json();
    out.push(...parseCardhoarder(json, name));
    const meta = json.data && json.data.cards && json.data.cards.meta;
    if (!meta || meta.current_page >= meta.last_page) break;
  }
  return out;
}

// ------------------------------------------------------------------ Dojo

/**
 * Parses the HTML table Dojo's ajax.php returns. Variants are written into the
 * product name, e.g. "Force of Will (Retro Frame)".
 */
function parseDojo(html, name) {
  const { document } = parseHTML(`<table>${html}</table>`);
  const out = [];
  for (const tr of document.querySelectorAll('tr')) {
    const a = tr.querySelector('a[href*="mtgoProduct"]');
    if (!a) continue;
    const cells = Array.from(tr.children);
    const product = a.textContent.replace(/\s+/g, ' ').trim();
    const m = product.match(/^(.*?)(?:\s+\(([^)]+)\))?$/);
    const base = m ? m[1] : product;
    if (norm(base) !== norm(name)) continue;
    const rarityTitle = (cells[1] && cells[1].querySelector('img') && cells[1].querySelector('img').getAttribute('title')) || '';
    const stockText = cells[5] ? cells[5].textContent.replace(/\s+/g, ' ').trim() : '';
    out.push({
      set: ((rarityTitle.match(/\(([^)]+)\)\s*$/) || [])[1] || '').toUpperCase(),
      foil: !!tr.querySelector('img[title="Foil"]'),
      variant: m && m[2] ? m[2] : null,
      buy: num(cells[3] && cells[3].textContent),
      sell: num(cells[4] && cells[4].textContent),
      stock: /^\d+$/.test(stockText) ? parseInt(stockText, 10) : null,
      url: `https://www.dojotradebots.com${a.getAttribute('href')}`,
      label: product,
    });
  }
  return out;
}

async function dojo(name, fetchImpl = fetch) {
  const body = new FormData();
  for (const [k, v] of [
    ['referrer', '/mtgoPrices'], ['function', 'drawPageTableOutputAjax'], ['pageName', 'mtgoPrices'], ['subPageName', ''],
    ['table-sort-column', ''], ['table-sort-direction', 'asc'], ['filter-search-product-name', name],
    ['table-sort-column-select', 'mtgoProductName'], ['table-filter-pagination-limit', '100'], ['table-filter-pagination-page', '1'],
  ]) body.append(k, v);
  const res = await fetchImpl('https://www.dojotradebots.com/ajax.php', {
    method: 'POST',
    body,
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return parseDojo((json.callbackData && json.callbackData.html) || '', name);
}

// ------------------------------------------------------------------ combined

async function settle(fn) {
  try {
    return { ok: true, rows: await fn() };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'timed out' : err.message };
  }
}

/** Live prices for one card name from all vendors, cached for TTL_MS. */
async function livePrices(name, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (process.env.VENDOR_LIVE_DISABLED === '1') {
    return { fetchedAt: new Date(now).toISOString(), vendors: {}, disabled: true };
  }
  const key = norm(name);
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return { ...hit.data, cached: true };
  const [ch, dj] = await Promise.all([settle(() => cardhoarder(name, fetchImpl)), settle(() => dojo(name, fetchImpl))]);
  const data = { fetchedAt: new Date(now).toISOString(), vendors: { cardhoarder: ch, dojo: dj } };
  cache.set(key, { at: now, data });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return data;
}

/** GoatBots card page URL (their slugs: lower case, punctuation dropped, spaces → dashes). */
function goatbotsUrl(name) {
  const slug = norm(name).replace(/['",.!?:]/g, '').replace(/\s*\/\/\s*/g, '-').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `https://www.goatbots.com/card/${slug}`;
}

module.exports = { livePrices, parseCardhoarder, parseDojo, goatbotsUrl, cardhoarder, dojo, _cache: cache };
