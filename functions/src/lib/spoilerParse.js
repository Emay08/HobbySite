/**
 * Parsers for https://www.magicspoiler.com (DOM API only, so it runs in Node via
 * linkedom and in a browser for checking against the live site).
 *
 * Structure (Nov 2026):
 *   Home page nav:  #menu-main > li > a            top-level sets / posts
 *                   #menu-main li ul.sub-menu a    e.g. "Star Trek" › "Star Trek Commander"
 *   Set page:       a[href*="/mtg-spoiler/"][title="Card Name"]  (image link + text link per card)
 *                   paginated as /page/2/, /page/3/ …
 *   News post:      card lists written as text lines, e.g.
 *                   "1x Quicksilver Amulet as “Thumper”", "1x Revel in Riches"
 */

const clean = (s) => String(s == null ? '' : s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/** Pages linked from the main navigation that can hold cards. */
function discoverPages(document, baseUrl = 'https://www.magicspoiler.com/') {
  const out = [];
  const seen = new Set();
  for (const a of Array.from(document.querySelectorAll('#menu-main a[href]'))) {
    let url;
    try {
      url = new URL(a.getAttribute('href'), baseUrl).toString();
    } catch {
      continue;
    }
    if (!/\/(mtg-set|mtg-news)\/[^/]+\/?$/.test(url)) continue;
    url = url.replace(/^http:/, 'https:').replace(/\/?$/, '/');
    if (seen.has(url)) continue;
    seen.add(url);
    const text = clean(a.textContent);
    // Sub-menu items get their parent's name in front: "Marvel: Darkhold Destiny › Commander"
    const parentLi = a.parentElement && a.parentElement.parentElement && a.parentElement.parentElement.closest
      ? a.parentElement.parentElement.closest('li')
      : null;
    const parentA = parentLi ? Array.from(parentLi.children).find((c) => c.tagName === 'A') : null;
    const label = parentA && parentA !== a ? `${clean(parentA.textContent)} › ${text}` : text;
    out.push({ url, label });
  }
  return out;
}

function stripSuffix(name) {
  return clean(name)
    .replace(/\s+-\s+.*\bMtG\b.*Spoiler.*$/i, '') // "Card - Star Trek MtG Spoiler"
    .replace(/\s+-\s+MtG\s+.*$/i, '');
}

/** Card names on a set page or news post, plus links to further pages. */
function extractCards(document, pageUrl) {
  const scope = document.querySelector('#main') || document.querySelector('main') || document.body;
  const cards = new Map(); // normalized-ish name → { name, url }

  for (const a of Array.from(scope.querySelectorAll('a[href*="/mtg-spoiler/"]'))) {
    const img = a.querySelector('img');
    const name = stripSuffix(a.getAttribute('title') || clean(a.textContent) || (img && img.getAttribute('alt')) || '');
    if (!name || name.length > 120 || /\btoken\b/i.test(name)) continue;
    const key = name.toLowerCase();
    if (!cards.has(key)) cards.set(key, { name, url: a.getAttribute('href') });
  }

  // "1x Card Name" / "1x Card Name as “Alias”" lines in post bodies
  const body = scope.querySelector('.entry-content') || scope.querySelector('article') || scope;
  const html = body.innerHTML || '';
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&rsquo;/g, '’')
    .replace(/&#8220;|&ldquo;/g, '“')
    .replace(/&#8221;|&rdquo;/g, '”')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'");
  for (const raw of text.split('\n')) {
    const m = clean(raw).match(/^(\d{1,3})\s*x\s+(.+)$/i);
    if (!m) continue;
    let name = m[2].replace(/\s+as\s+[“"'‘].*$/i, '').replace(/\s*\((?:foil|non-foil|etched|showcase)[^)]*\)\s*$/i, '').trim();
    if (!name || name.length > 120 || /\btoken\b/i.test(name)) continue;
    const key = name.toLowerCase();
    if (!cards.has(key)) cards.set(key, { name, url: pageUrl });
  }

  // Pagination links for set pages: …/page/2/
  const pages = new Set();
  for (const a of Array.from(document.querySelectorAll('a[href*="/page/"]'))) {
    try {
      const u = new URL(a.getAttribute('href'), pageUrl).toString();
      if (pageUrl && u.startsWith(pageUrl.replace(/page\/\d+\/?$/, '')) && /\/page\/\d+\/?$/.test(u)) pages.add(u);
    } catch {
      /* ignore */
    }
  }
  return { cards: [...cards.values()], pages: [...pages], text: clean(text) };
}

/**
 * For news posts whose card lists are images: finds names you care about mentioned in
 * the article text. Matching is case-sensitive on whole words and ignores very short
 * names, so ordinary words ("Shock", "Opt") in a sentence don't count.
 */
function findMentions(text, candidateNames) {
  const found = [];
  const norm = String(text || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  for (const name of candidateNames) {
    if (!name || name.length < 6 || !/\s/.test(name)) continue; // multi-word names only
    const n = name.replace(/[‘’]/g, "'");
    let i = norm.indexOf(n);
    while (i !== -1) {
      const before = norm[i - 1];
      const after = norm[i + n.length];
      if ((!before || !/[\w'-]/.test(before)) && (!after || !/[\w'-]/.test(after))) {
        found.push(name);
        break;
      }
      i = norm.indexOf(n, i + 1);
    }
  }
  return found;
}

if (typeof module !== 'undefined') {
  module.exports = { discoverPages, extractCards, findMentions, stripSuffix };
}
