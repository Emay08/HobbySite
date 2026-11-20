const crypto = require('crypto');
const cheerio = require('cheerio');
const telegram = require('./telegram');

const USER_AGENT = 'Mozilla/5.0 (personal MTGO collection monitor; contact: owner of this bot)';
const SEEN_LIMIT = 1000;
const FETCH_TIMEOUT_MS = 20000;

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/xml,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ---------------------------------------------------------------- extractors

function extractLinks(html, monitor) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();
  $(monitor.itemSelector).each((_, el) => {
    const $el = $(el);
    const $a = $el.is('a') ? $el : $el.find('a').first();
    const href = $a.attr('href');
    if (!href) return;
    let url;
    try {
      url = new URL(href, monitor.url).toString().split('#')[0];
    } catch {
      return;
    }
    if (!/^https?:/i.test(url)) return;
    if (monitor.hrefPattern && !monitor.hrefPattern.test(url)) return;
    if (seen.has(url)) return;
    // Prefer a heading inside the card, fall back to the link text / title attribute
    const title = clean($el.find('h1,h2,h3,h4').first().text()) || clean($a.text()) || clean($a.attr('title') || $a.attr('aria-label'));
    if (!title || title.length < 4) return;
    seen.add(url);
    items.push({ id: url, url, title: title.slice(0, 300) });
  });
  return items;
}

function extractRss(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];
  // RSS 2.0
  $('item').each((_, el) => {
    const $el = $(el);
    const url = clean($el.find('link').first().text());
    const title = clean($el.find('title').first().text());
    const guid = clean($el.find('guid').first().text()) || url;
    const body = cheerio.load($el.find('description').first().text() || '').text();
    if (title) items.push({ id: guid || title, url, title, body: clean(body).slice(0, 4000) });
  });
  // Atom (Reddit uses Atom)
  $('entry').each((_, el) => {
    const $el = $(el);
    const url = $el.find('link').first().attr('href') || '';
    const title = clean($el.find('title').first().text());
    const id = clean($el.find('id').first().text()) || url;
    const body = cheerio.load($el.find('content').first().text() || '').text();
    if (title) items.push({ id, url, title, body: clean(body).slice(0, 4000) });
  });
  return items;
}

function extractPageText(html, monitor) {
  const $ = cheerio.load(html);
  $('script,style,noscript,svg,iframe').remove();
  const sel = monitor.contentSelector;
  let text = sel ? $(sel).text() : '';
  if (!clean(text)) text = $('main').text() || $('body').text();
  return clean(text);
}

async function fetchArticleText(url, fetcher = fetchText) {
  const html = await fetcher(url);
  const $ = cheerio.load(html);
  $('script,style,noscript,svg,iframe,nav,header,footer').remove();
  return clean($('article').text() || $('main').text() || $('body').text()).slice(0, 20000);
}

// ---------------------------------------------------------------- classify

function classify(monitor, title, body = '') {
  for (const rule of monitor.rules || []) {
    const inTitle = rule.match.test(title);
    const inBody = !inTitle && body && rule.match.test(body);
    if (inTitle || inBody) {
      return {
        category: rule.category,
        notify: Boolean(rule.notify),
        keep: true,
        snippet: inBody ? snippetAround(body, rule.match) : null,
      };
    }
  }
  const d = monitor.default || {};
  return { category: d.category || 'news', notify: Boolean(d.notify), keep: d.keep !== false, snippet: null };
}

function snippetAround(text, re, radius = 160) {
  const m = re.exec(text);
  if (!m) return null;
  const start = Math.max(0, m.index - radius);
  const end = Math.min(text.length, m.index + m[0].length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

// ---------------------------------------------------------------- runner

/**
 * Runs one monitor: fetch → extract → diff against what's been seen →
 * store new highlights → send Telegram for those marked notify.
 *
 * On the first ever run of a monitor nothing is sent to Telegram (otherwise you
 * would get one message per existing article), but items are still saved so the
 * website has something to show.
 */
async function runMonitor(db, monitor, { dryRun = false, log = console.log, fetcher = fetchText, now = new Date() } = {}) {
  const stateColl = db ? db.collection('monitor_state') : null;
  const state = (stateColl && (await stateColl.findOne({ _id: monitor.id }))) || { seen: [] };
  const firstRun = !state.lastChecked;
  const seen = new Set(state.seen || []);

  const raw = await fetcher(monitor.url);
  let candidates = [];
  let newPageHash = null;

  if (monitor.type === 'links') {
    candidates = extractLinks(raw, monitor);
  } else if (monitor.type === 'rss') {
    candidates = extractRss(raw);
  } else if (monitor.type === 'page') {
    const text = extractPageText(raw, monitor);
    newPageHash = sha1(text);
    if (state.lastHash && state.lastHash !== newPageHash) {
      candidates = [{ id: `${monitor.id}@${newPageHash}`, url: monitor.url, title: `${monitor.label} changed`, body: text.slice(0, 4000) }];
    }
  } else {
    throw new Error(`Unknown monitor type "${monitor.type}"`);
  }

  const fresh = candidates.filter((c) => !seen.has(sha1(c.id)));
  if (dryRun) {
    log(`  extracted ${candidates.length} item(s), ${fresh.length} not seen before`);
  }

  const results = [];
  for (const item of fresh) {
    let body = item.body || '';
    if (monitor.follow && item.url && monitor.follow.titlePattern.test(item.title)) {
      try {
        body = await fetchArticleText(item.url, fetcher);
      } catch (err) {
        log(`  could not fetch article ${item.url}: ${err.message}`);
      }
    }
    const c = classify(monitor, item.title, body);
    results.push({ item, ...c });
  }

  const kept = results.filter((r) => r.keep);
  const toNotify = firstRun ? [] : kept.filter((r) => r.notify);

  if (dryRun) {
    for (const r of kept) log(`  [${r.category}${r.notify ? ', notify' : ''}] ${r.item.title}\n      ${r.item.url}`);
    if (candidates.length === 0) log('  ⚠ nothing extracted — check itemSelector / hrefPattern, or whether the page needs JavaScript');
    return { monitor: monitor.id, extracted: candidates.length, fresh: fresh.length, kept: kept.length, notified: 0, items: kept.map((r) => r.item) };
  }

  const highlights = db.collection('highlights');
  let notified = 0;
  for (const r of kept) {
    const doc = {
      _id: sha1(`${monitor.id}|${r.item.id}`),
      source: monitor.label,
      monitorId: monitor.id,
      title: r.item.title,
      url: r.item.url,
      category: r.category,
      summary: r.snippet || null,
      detectedAt: now,
      notified: false,
    };
    await highlights.updateOne({ _id: doc._id }, { $setOnInsert: doc }, { upsert: true });
  }

  for (const r of toNotify) {
    const e = telegram.escapeHtml;
    const icon = r.category === 'treasure-chest' ? '💰' : r.category === 'reprint' ? '♻️' : r.category === 'banlist' ? '🔨' : '📰';
    const msg =
      `${icon} <b>${e(r.item.title)}</b>\n` +
      (r.snippet ? `<i>${e(r.snippet.slice(0, 600))}</i>\n` : '') +
      (r.item.url ? `${e(r.item.url)}\n` : '') +
      `— ${e(monitor.label)}`;
    try {
      const sent = await telegram.sendMessage(msg);
      if (!sent.skipped) {
        notified++;
        await highlights.updateOne({ _id: sha1(`${monitor.id}|${r.item.id}`) }, { $set: { notified: true } });
      }
    } catch (err) {
      log(`  Telegram send failed: ${err.message}`);
    }
  }

  // Remember everything we extracted this time (so items that disappear and
  // reappear don't re-trigger), capped to the most recent SEEN_LIMIT.
  const newSeen = [...new Set([...candidates.map((c) => sha1(c.id)), ...(state.seen || [])])].slice(0, SEEN_LIMIT);
  await db.collection('monitor_state').updateOne(
    { _id: monitor.id },
    {
      $set: {
        label: monitor.label,
        url: monitor.url,
        seen: newSeen,
        lastChecked: now,
        lastError:
          candidates.length === 0 && monitor.type !== 'page'
            ? 'Nothing extracted — the site layout may have changed (run monitors:dry-run)'
            : null,
        lastExtracted: candidates.length,
        ...(newPageHash ? { lastHash: newPageHash } : {}),
      },
    },
    { upsert: true }
  );

  return { monitor: monitor.id, extracted: candidates.length, fresh: fresh.length, kept: kept.length, notified, firstRun, items: kept.map((r) => r.item) };
}

async function recordError(db, monitor, err) {
  await db.collection('monitor_state').updateOne(
    { _id: monitor.id },
    { $set: { label: monitor.label, url: monitor.url, lastError: String(err.message || err).slice(0, 300), lastErrorAt: new Date() } },
    { upsert: true }
  );
}

module.exports = { runMonitor, recordError, extractLinks, extractRss, classify, snippetAround, fetchText, fetchArticleText };
