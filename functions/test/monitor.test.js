const test = require('node:test');
const assert = require('node:assert');
const AdmZip = require('adm-zip');
const { extractLinks, extractRss, classify } = require('../src/lib/monitor');
const { parsePriceZip } = require('../src/lib/prices');
const monitors = require('../src/lib/monitors.config');

const mtgoNews = monitors.find((m) => m.id === 'mtgo-news');

test('extracts news links and resolves relative URLs', () => {
  const html = `
    <main>
      <a href="/news/magic-online-announcements-november-18-2026"><h3>Magic Online Announcements – November 18, 2026</h3></a>
      <a href="/news/vintage-cube-returns">Vintage Cube Returns!</a>
      <a href="/news/vintage-cube-returns">Read more</a>
      <a href="/store">Store</a>
    </main>`;
  const items = extractLinks(html, mtgoNews);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].url, 'https://www.mtgo.com/news/magic-online-announcements-november-18-2026');
  assert.match(items[0].title, /Announcements/);
});

test('classifies treasure chest from article body and reprints from title', () => {
  const tc = classify(mtgoNews, 'Magic Online Announcements', 'Blah. The Treasure Chest will be updated on November 25 with new cards. More.');
  assert.strictEqual(tc.category, 'treasure-chest');
  assert.strictEqual(tc.notify, true);
  assert.match(tc.snippet, /Treasure Chest will be updated/);

  const rp = classify(mtgoNews, 'Vintage Cube Returns!');
  assert.strictEqual(rp.category, 'reprint');

  const other = classify(mtgoNews, 'Server maintenance');
  assert.deepStrictEqual([other.category, other.notify, other.keep], ['news', false, true]);
});

test('reddit monitor drops posts that match no rule', () => {
  const reddit = monitors.find((m) => m.id === 'reddit-mtgo');
  assert.strictEqual(classify(reddit, 'Anyone want to trade?').keep, false);
  assert.strictEqual(classify(reddit, 'Treasure chest update leaked').category, 'treasure-chest');
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
