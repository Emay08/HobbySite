const test = require('node:test');
const assert = require('node:assert');
const AdmZip = require('adm-zip');
const { extractLinks, extractRss, classify } = require('../src/lib/monitor');
const { parsePriceZip } = require('../src/lib/prices');
const monitors = require('../src/lib/monitors.config');

const banlist = monitors.find((m) => m.id === 'banlist');

test('only the banlist monitor is configured', () => {
  assert.deepStrictEqual(monitors.filter((m) => m.enabled).map((m) => m.id), ['banlist']);
  assert.ok(monitors.retired.includes('mtgo-news') && monitors.retired.includes('reddit-mtgo'));
});

test('banlist monitor keeps only announcements with "Banned" in the title', () => {
  // Same shape as magic.wizards.com/en/news/announcements
  const html = `<main>
    <a data-navigation-type="server-side" href="/en/news/announcements">Announcements</a>
    <a data-navigation-type="server-side" href="/en/news/announcements/banned-and-restricted-october-12-2026"><div><h3 class="css-mbeyN">Banned and Restricted Announcement — October 12, 2026</h3></div></a>
    <a data-navigation-type="server-side" href="/en/news/announcements/mtg-arena-patch-notes-2026-11"><h3 class="css-mbeyN">MTG Arena Patch Notes</h3></a>
    <a href="/en/news/feature/something"><h3>Feature</h3></a>
  </main>`;
  const items = extractLinks(html, banlist);
  assert.deepStrictEqual(
    items.map((i) => i.url),
    ['https://magic.wizards.com/en/news/announcements/banned-and-restricted-october-12-2026', 'https://magic.wizards.com/en/news/announcements/mtg-arena-patch-notes-2026-11']
  );
  const b = classify(banlist, items[0].title);
  assert.deepStrictEqual([b.category, b.keep, b.notify], ['banlist', true, true]);
  assert.strictEqual(classify(banlist, items[1].title).keep, false);
  assert.strictEqual(classify(banlist, 'Unbanning a classic').keep, false);
});

test('parses Atom feeds (Reddit)', () => {
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry><id>t3_abc</id><title>Treasure Chest update</title><link href="https://reddit.com/r/mtgo/abc"/><content type="html">&lt;p&gt;hello&lt;/p&gt;</content></entry>
  </feed>`;
  const items = extractRss(xml);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].url, 'https://reddit.com/r/mtgo/abc');
  assert.strictEqual(items[0].body, 'hello');
});

test('parses a GoatBots-style price zip', () => {
  const zip = new AdmZip();
  zip.addFile('price-history-2026-11-18.txt', Buffer.from(JSON.stringify({ 1: 1, 90542: 41.5, 12: 'x' })));
  const { prices } = parsePriceZip(zip.toBuffer());
  assert.strictEqual(prices.get('90542'), 41.5);
  assert.strictEqual(prices.has('12'), false);
});

test('reads the next banned & restricted date from an article', () => {
  const { parseNextAnnouncement } = require('../src/lib/banlist');
  const a = parseNextAnnouncement('Changes effective as of October 12, 2026. View the list. Next announcement: November 30, 2026', new Date('2026-10-12'));
  assert.strictEqual(a.date.toISOString(), '2026-11-30T08:00:00.000Z'); // midnight Pacific
  const b = parseNextAnnouncement('…the next banned and restricted announcement will be on January 18, 2027.');
  assert.strictEqual(b.text, 'January 18, 2027');
  assert.strictEqual(parseNextAnnouncement('No date here'), null);
});

test('cadence: lazy outside the window, every tick inside it', () => {
  const { plan } = require('../src/lib/cadence');
  const t = new Date('2026-11-30T08:00:00Z');
  const state = { lastSuccess: new Date('2026-11-20T12:00:00Z'), lastAttempt: new Date('2026-11-20T12:00:00Z') };
  const at = (iso, extra = {}) => plan({ state, now: new Date(iso), targets: [t], idleHours: 6, ...extra });
  assert.deepStrictEqual([at('2026-11-20T13:00:00Z').due, at('2026-11-20T13:00:00Z').mode], [false, 'idle']);
  assert.strictEqual(at('2026-11-20T18:01:00Z').due, true); // 6 h later
  assert.strictEqual(at('2026-11-20T13:00:00Z').windowStart.toISOString(), '2026-11-23T08:00:00.000Z');
  assert.deepStrictEqual([at('2026-11-23T08:00:30Z').due, at('2026-11-23T08:00:30Z').mode], [true, 'watching']);
  assert.strictEqual(at('2026-11-25T00:00:00Z', { done: () => true }).mode, 'idle');
  assert.strictEqual(at('2026-12-07T09:00:00Z').mode, 'idle'); // 7 days late → give up
  assert.strictEqual(plan({ state, now: new Date('2026-11-20T13:30:00Z'), targets: [null], unknownHours: 1 }).due, true);
  assert.strictEqual(plan({ state: null, now: new Date(), targets: [] }).due, true);
});
