/**
 * Sites to watch. Edit this file to add, remove or tune monitors, then
 * check what each one extracts with:   npm run monitors:dry-run
 *
 * Common fields
 *   id         unique, stable key (used to remember what has been seen)
 *   label      shown on the website
 *   enabled    false to pause
 *   type       'links' – list page; every new matching link becomes an item
 *              'rss'   – RSS/Atom feed; every new entry becomes an item
 *              'page'  – a single page; an item is created when its text changes
 *   url        page or feed to fetch
 *
 * type: 'links'
 *   itemSelector  CSS selector for the <a> elements (or containers holding one)
 *   hrefPattern   optional RegExp the link URL must match
 *
 * type: 'page'
 *   contentSelector  CSS selector for the part of the page to watch (default 'main' then 'body')
 *
 * Classification (all types)
 *   rules       checked in order against title (+ article body when followed);
 *               the first match sets the category and whether to send a Telegram message.
 *               Category keys used by the website: 'reprint', 'treasure-chest', 'banlist', 'reward-pack'.
 *   default     { category, notify, keep } for items no rule matched.
 *               keep: false drops unmatched items entirely (good for noisy feeds).
 *
 * follow (optional, 'links' and 'rss')
 *   When a new item's title matches follow.titlePattern, the article itself is
 *   fetched and its text is also checked against the rules. This is how the
 *   weekly "Magic Online Announcements" posts, which bury Treasure Chest changes
 *   in the body, get classified correctly.
 */

// The news feed is deliberately narrow. Treasure Chest changes, reprints and Player Reward
// Pack contents have their own watchers (treasureChest.js, reprints.js, rewardPacks.js);
// this file only holds the banlist watch.

const BANNED = /\bbann(?:ed|ing)\b/i;

module.exports = [
  {
    // Wizards posts banned & restricted updates as announcements, e.g.
    // /en/news/announcements/banned-and-restricted-october-12-2026. Everything else
    // on that page is ignored. Telegram on by default; NOTIFY_BANLIST=false turns it off.
    id: 'banlist',
    label: 'Banlist (Wizards announcements)',
    enabled: true,
    type: 'links',
    url: 'https://magic.wizards.com/en/news/announcements',
    itemSelector: 'a[href*="/news/announcements/"]',
    hrefPattern: /\/news\/announcements\/[^/?#]+/,
    rules: [{ match: BANNED, category: 'banlist', notify: process.env.NOTIFY_BANLIST !== 'false' }],
    default: { keep: false },
  },
];

/** Monitors that used to exist; their state and highlights are cleared on the next run. */
module.exports.retired = ['mtgo-news', 'reddit-mtgo', 'example-page-watch'];
