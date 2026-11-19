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
 *               Category keys used by the website: 'reprint', 'treasure-chest', 'news'.
 *   default     { category, notify, keep } for items no rule matched.
 *               keep: false drops unmatched items entirely (good for noisy feeds).
 *
 * follow (optional, 'links' and 'rss')
 *   When a new item's title matches follow.titlePattern, the article itself is
 *   fetched and its text is also checked against the rules. This is how the
 *   weekly "Magic Online Announcements" posts, which bury Treasure Chest changes
 *   in the body, get classified correctly.
 */

const REPRINT = /\b(reprint(?:ed|s|ing)?|remaster(?:ed)?|masters|anthology|vintage cube|legacy cube|cube|horizons|flashback draft|special guest|mystery booster|spotlight)\b/i;
const TREASURE_CHEST = /treasure chest/i;

const sharedRules = [
  { match: TREASURE_CHEST, category: 'treasure-chest', notify: true },
  { match: REPRINT, category: 'reprint', notify: true },
];

module.exports = [
  {
    id: 'mtgo-news',
    label: 'MTGO.com news',
    enabled: true,
    type: 'links',
    url: 'https://www.mtgo.com/news',
    itemSelector: 'a[href*="/news/"]',
    hrefPattern: /\/news\/[^/?#]+/,
    follow: { titlePattern: /announcement|treasure|update|release|schedule/i },
    rules: sharedRules,
    default: { category: 'news', notify: false, keep: true },
  },
  {
    id: 'reddit-mtgo',
    label: 'r/mtgo',
    enabled: true,
    type: 'rss',
    url: 'https://www.reddit.com/r/mtgo/new/.rss',
    // Reddit is noisy: only keep posts that match a rule, and don't push them to the phone.
    rules: [
      { match: TREASURE_CHEST, category: 'treasure-chest', notify: false },
      { match: REPRINT, category: 'reprint', notify: false },
    ],
    default: { keep: false },
  },
  {
    // Template for watching one specific page for any change.
    // Point it at e.g. a set's release-notes page or an event schedule.
    id: 'example-page-watch',
    label: 'Example page watch',
    enabled: false,
    type: 'page',
    url: 'https://www.mtgo.com/en/mtgo/ (replace me)',
    contentSelector: 'main',
    rules: sharedRules,
    default: { category: 'news', notify: true, keep: true },
  },
];
