# Vault — personal site + MTGO collection manager

Two deployables that share one MongoDB database:

```
mtgo-manager/
├── web/         Express website (Azure App Service)
│                login → landing page → MTGO manager (highlights, collection browser, CSV upload)
│                                     → Show Order (dance recital running-order planner)
└── functions/   Azure Functions app (timer triggers)
                 watchers      – one 30-second tick; each page is checked every tick near its
                                 expected update, lazily otherwise:                               → Telegram
                                   Treasure Chest (window around "Next Update", daily otherwise)
                                   Banlist (window around "Next announcement", every 6 h otherwise)
                                   Player Reward Packs (window around the 1st, every 6 h otherwise)
                 spoilerWatch  – Scryfall, hourly 8 am–8 pm PT: reprints of your cards           → Telegram
                 priceSync     – daily: GoatBots cards + prices → value history, tracked-card history,
                                 target / swap status for the website
```

## What's in MongoDB

| Collection      | Written by           | Contents |
|-----------------|----------------------|----------|
| `collection`    | web (CSV upload)     | One doc per MTGO catalog ID: name, qty, set, rarity, foil |
| `uploads`       | web                  | Upload log with added/removed/changed counts |
| `prices`        | functions/priceSync  | `_id` = MTGO catalog ID, `price`, `prevPrice` (tix) |
| `cards`         | functions/priceSync  | Every MTGO printing (name, set, foil, `collector` number, `firstSeen` = when GoatBots first listed it) — powers the card search |
| `gb_chest`      | functions/priceSync  | GoatBots' Treasure Chest list (top 100 curated cards: name, variant, set, foil) |
| `tc_versions`   | web                  | Which MTGO ID each chest version was matched to, per update, and how (GoatBots / treatment / guess) |
| `price_history` | both                 | Daily price per tracked card (anything on a watch list, target or swap) |
| `watchlist`     | web                  | Short- and long-term watch-list entries (`list: 'short' \| 'long'`) |
| `targets`       | web + priceSync      | Price targets; the daily job sets `hit` / `hitAt` |
| `swaps`         | web + priceSync      | Version swaps; the daily job sets `good` when the wanted printing is cheaper |
| `value_history` | both                 | One doc per day: total collection value |
| `highlights`    | functions            | Items shown on the MTGO front page (Treasure Chest updates, reprints, banlist announcements, reward pack changes) |
| `monitor_state` | functions            | Each watcher's state: last run, last error, schedule |
| `tc_snapshots`  | functions/treasureChest | Parsed copies of the Treasure Chest page (last 30 changes) |
| `reprint_seen`  | functions/spoilerWatch  | Scryfall printing IDs the reprint watch has already looked at |
| `prp_snapshots` | functions/watchers      | Every version of the Player Reward Pack contents |
| `meta`          | functions/priceSync  | Last price sync time |
| `trades`        | web                  | Per-card trade entries: logged by hand on card pages, or imported from GoatBots |
| `gb_trades`     | web                  | Imported GoatBots trades (one doc per trade, with all items) |
| `trade_imports` | web                  | Log of trade history uploads |
| `pending_changes` | web                | Unconfirmed buys/sells found by comparing collection uploads |
| `collection_changes` | web             | Per-card quantity changes recorded by each CSV upload |
| `tc_history`    | both                 | One doc per Treasure Chest update (`_id` = date): `changes` (the CHANGELIST), `contents` (full chest after the update), `issues` |
| `price_daily`   | functions/priceSync  | One doc per day: `prices` = { MTGO ID: tix } for every printing of every chest card + everything you own |
| `sheet_trades`  | web                  | Entries from the spreadsheet import (as typed, resolved card name, duplicate/date-range info) |
| `import_staging`| web                  | A spreadsheet import waiting for review |
| `sessions`      | web                  | Login sessions |
| `showorder`     | web                  | One doc (`_id: 'project'`): Show Order lists, rules, saved schedules and their locks |

Prices come from GoatBots' public daily price file, keyed by MTGO catalog ID — the same number as the `ID #` column in the MTGO CSV export — so cards match exactly, including foils and different printings.

---

## 1. MongoDB Atlas

1. In your cluster: **Database Access** → add a database user with read/write.
2. **Network Access** → allow the Azure outbound IPs (or `0.0.0.0/0` while setting up; the user/password still protects it).
3. **Connect → Drivers** → copy the `mongodb+srv://…` string. Database name defaults to `mtgo_manager` (created automatically).

## 2. Run the website locally

```bash
cd web
npm install
cp .env.example .env
npm run hash-password          # paste the output into ADMIN_PASSWORD_HASH (in single quotes)
# fill MONGODB_URI and SESSION_SECRET in .env
npm run dev                    # http://localhost:3000
```

There is no sign-up page and no users table: the one allowed username and its bcrypt hash live in environment variables. Login attempts are rate-limited (10 per 15 min), sessions last 14 days, cookies are `httpOnly` + `SameSite=Strict` (+ `Secure` in production), and pages send `noindex`.

### Updating your collection
MTGO client → **Collection** → select all cards in your full collection → right-click → **Export** → **CSV**. Drag the file onto **MTGO → Update**. Each upload replaces the stored collection and shows what was added/removed. Headers are matched loosely, so exports from other tools that have *name* + *quantity* columns also work (cards without an MTGO ID won't get prices, though).

Only drop the MTGO export here: a GoatBots trade history is refused (it would otherwise be read as a collection of the cards in your trades). If the stored collection is ever wrong, tick **Start fresh** before uploading: the upload becomes the new starting point, recorded collection changes are cleared and open unconfirmed buys/sells are dismissed, instead of thousands of bogus changes being measured against the wrong collection.

MTGO's own CSV export isn't quite valid CSV: after a card name with an accented letter (Márton Stromgald, Nazgûl…) it drops the line break, and quotes inside names aren't escaped (`"Henzie "Toolbox" Torre"`). The upload reads MTGO exports record by record to cope with both, and counts sideboarded copies too.

### Card search
The search box in the top bar (press `/` to jump to it) suggests card names as you type, in this order: your short-term watch list, long-term watch list, your collection, then every card on MTGO; within each group exact matches come first, then names starting with what you typed, then names containing it. Enter (or clicking a suggestion) opens that card's page. The names are kept in memory on the web server, so each lookup takes a few milliseconds; the list refreshes every 10 minutes and immediately after you change a watch list or upload your collection.

### Unconfirmed buys and sells
Every collection upload is compared with the previous one. Each version whose quantity changed becomes an *unconfirmed* buy (+n) or sell (−n) with an unknown price, dated "between the previous upload and this one". Trades you already have in that window for the same MTGO ID (GoatBots imports, or entries you added) are subtracted automatically; if they account for the whole change it's resolved straight away.

What's left is listed on the **Trades** page (and on each card's page), where you can:
- **Save** it with a price, a date inside the window and who you traded with — it becomes a normal trade-history entry;
- **leave it** — the next GoatBots history upload that covers those dates resolves it automatically;
- **dismiss** it (one by one, or tick several and *Dismiss selected*) if it wasn't a purchase or sale, e.g. a prize or redemption.

Event Tickets are left out. Card pages also have an **Add transaction** button for trades with other vendors or players.

### Trade history (GoatBots)
On GoatBots, download your trade history CSV (your last 1,000 trades) and drop it on **MTGO → Trades**. Upload every download you have, in any order: each trade is identified by its timestamp + bot, and each item by get/give + MTGO ID, so trades already stored are skipped and only new ones are added. The Trades page lists every trade (what you got, what you gave, values, credit change) with a card-name filter; each card's trades also appear in the trade history on its card page, tagged *GoatBots import*, next to anything you log by hand.

### Spreadsheet import (one-time) — **Update → Spreadsheet import**
Your Google Sheet (Treasure Chest tabs + `buysell`) was converted to `vault-import.json` with `tools/sheet-to-json.py` (`python3 tools/sheet-to-json.py MTGO_treasure_chest_updates.xlsx vault-import.json`; needs `openpyxl`). Drop that file on the import page, check the flagged entries, and import. **Undo** removes everything it added.

- **Treasure Chest tabs** are CHANGELISTs (only cards that changed). They're stored in `tc_history`, and each update's **full contents** are rebuilt backwards from the watcher's newest page snapshot (before an update = after it, with each changed card set back to slots − change). Rows that disagree with the rebuild are listed as mismatches on each update's page. The tab named "Jan 16 2025" is treated as **Jan 16 2026**; the **June 4 2024** tab repeated 283 of May 13's rows, so those are left out (a checkbox keeps them). Tabs before June 2024 have no Treatment, so those versions are known by set only.
- **buysell** (rebought / recently bought / sold, oldest first, no dates): names are matched to MTGO cards (shorthand, typos, "(f)" = foil, "x4" = quantity, other notes kept). An entry is a **GoatBots duplicate** when the same card, direction and price (to the cent) appear in your GoatBots trades *in the same order as the sheet* — the longest such chain per column is used, so one stray match can't throw off the rest. Duplicates aren't added. Everything else becomes a trade with no date and the **range between its nearest matched neighbours** (shown on card pages, tagged *Spreadsheet*). Uploading another GoatBots history re-runs the matching, so older histories remove more duplicates and narrow the ranges.
- The name boxes on the review page suggest names as you type (same ranking as the nav search), with the entry's original candidates first. Names typed there are checked against the same names as the nav search — GoatBots' card definitions (from the daily price sync), your collection and watch lists — ignoring case, accents and punctuation (’ vs '). If a correct name is rejected, the message says how many names the site knows; a small number means the price sync hasn't loaded GoatBots' card list.
- Entries without a card name wait on the import page to be named or skipped; *remove* on a card page skips one for good.

### Current Treasure Chest — **MTGO → Chest**
`/mtgo/chest`, built from the watcher's page snapshots:
- **Last update recorded**: when the watcher first saw the chest's current contents (not the "Last Updated" date printed on the page). If the watcher started after the update, it says so. **Next update** comes from the page; there's a link to the official page.
- **New in the first curated table**: the average GoatBots price, per day since the update was recorded, of the cards newly added this update to the first table of the curated section (whole sets left out). Points come from the daily `price_daily` snapshot plus today's prices. **New printings are left out**: a printing GoatBots first listed within two days before the update was recorded, or later, or one GoatBots doesn't list yet, has rough, volatile early prices. (The daily sync stamps each printing's `firstSeen` the first time GoatBots lists it; printings from the very first sync, or stored before `firstSeen` existed, count as established.) Each chest version is matched to an MTGO ID by name + set (+ foil). When a set has several printings of the card (e.g. the English and Japanese SOA Force of Will), the site fetches Scryfall's details for those printings and picks, in order: the variant **GoatBots' own Treasure Chest list** names ("Force of Will (Japanese)") → **✓**; the official page's Treatment; the "Regular" printing if there's no treatment; else the cheapest → **?**. The answer is remembered per update in `tc_versions`; a better-grounded one (usually GoatBots' list, a day or two after the update) replaces a weaker one and posts a *Treasure Chest version corrected* notice on Highlights.
- **Your cards in the chest**: everything you own or watch that is in any curated table, matched by name, most expensive first. Columns: price (the card's most expensive chest version), **change** since the update (vs. the first price recorded after it was recorded), **low** (lowest price recorded since), your quantity, watch lists, and the chest versions. **↘ sold** marks cards you've sold since the update was recorded (GoatBots or logged trades, or unconfirmed drops in your collection) — hover it for details. Watched cards can be moved between short/long or removed right there; owned cards that aren't watched get + Short / + Long.

Prices below 0.10 tix are shown to three decimals everywhere.

### Treasure Chest history — **Highlights → Treasure Chest → Update history**
Every recorded update (`/mtgo/tc`): added / removed / changed counts, cards and total slots in the chest, and a page per update with the changes, the full contents and which of them you own. Card pages have a **Treasure Chest** section: when each version was in the chest (added, removed, how many updates, max slots) and every changelist row that mentions it. The watcher writes each new update to the same place, contents and all.

For the later price analysis, the daily job also stores `price_daily`: one compact document per day with the GoatBots price of every printing of every card that has been in the chest, plus everything you own (a few thousand IDs, under 100 KB a day). GoatBots only publishes today's prices, so this history starts when this is deployed.

### Watch lists, price targets and version swaps
Each has its own page in the MTGO menu. Cards are picked in two steps: type a name (suggestions ranked like the nav search — watch lists, then your collection, then every card on MTGO), then pick the version. Every version comes from GoatBots' card definitions — the cards actually in circulation on MTGO — refreshed daily. Until the first daily job has run, only cards in your own collection are found.

| Page | What it shows |
|------|---------------|
| **Short watch** | price, 1-day and 7-day change, change since added, 30-day chart. Rows are highlighted when a card moved more than its alert % today (default 15 %). Cards found by the Treasure Chest and reprint watchers are added here automatically (tagged *auto*). |
| **Long watch** | price, 30- and 90-day change, change since added, 6-month chart, notes |
| **Targets** | three groups: *reached*, *getting close* (within the card's "close" %, default 10 %), *waiting*. Buy targets (≤) or sell targets (≥) |
| **Swaps** | the version you own next to the one you want, the price gap, total saving across your copies; *Swap now* when the wanted version is cheaper by at least your minimum saving |

Items move between the short- and long-term lists with one click. Charts start from the day a card is added (price history is only kept for tracked cards so the database stays small) and fill in as the daily job runs. Target and swap status is updated once a day, after the price update. None of these send Telegram messages unless you turn that on (see `NOTIFY_*` settings).

### Card pages
Click any card name (collection, watch lists, targets, swaps) to open its page:

- **Images and versions**: the image at the top is a version you own (if any); click any row in *All versions* to show that version instead. Hover any card image or version thumbnail (also in the watch-list / target / swap pickers) to see it full size next to the mouse. Each version is labelled from Scryfall — *Regular*, *Borderless · Showcase*, *Extended art*, *Retro frame*… plus its collector number — looked up by MTGO ID (one request per card, cached 30 days in `scryfall_cards`).
- **All versions** on MTGO with: GoatBots' daily price (last night's average sell price, with 1-day change and a 90-day chart for tracked versions); **live** Cardhoarder and Dojo sell / buy prices and stock; the best offer in each row highlighted; *Short* / *Long* buttons to add or remove that version from either watch list.
- **Trade history**: a log you fill in (bought / sold, version, quantity, tix each, with whom) with totals, plus the quantity changes recorded by each collection upload.

Where the prices come from:

| Vendor | Freshness | How |
|--------|-----------|-----|
| GoatBots | daily (published ~5:30 AM CET) | their public download, as before. Their live prices are deliberately drawn as obfuscated images to stop automated reading, so the page links to GoatBots' own card page for those. |
| Cardhoarder | live | one request per card page view (their search, exact name). Their card ids are MTGO catalog ids, so prices match your versions exactly. |
| Dojo | live | one request per card page view (their price table search). Matched to versions by set + foil; variants Dojo names in brackets ("Retro Frame") that can't be placed are listed separately. |

Live results are cached for 2 minutes. If a vendor blocks or times out, its columns show "!" with the reason and the rest of the page still works. Set `VENDOR_LIVE_DISABLED=1` on the web app to turn live lookups off.

## 3. Telegram bot (≈2 minutes)

1. In Telegram, message **@BotFather** → `/newbot` → copy the token.
2. Open your new bot and send it any message (e.g. "hi").
3. ```bash
   cd functions
   npm install
   cp local.settings.example.json local.settings.json   # put the token in TELEGRAM_BOT_TOKEN
   npm run telegram:chat-id                              # prints TELEGRAM_CHAT_ID=…
   npm run telegram:test                                 # you should get a message
   ```

## 4. Watchers and Telegram

Telegram is used for exactly two things:

### Treasure Chest page — `functions/src/lib/treasureChest.js`

Reads https://www.mtgo.com/news/mtgo-treasure-chest-info.

- **When:** the timer ticks every 30 seconds, but the page is only fetched every tick from **7 days before** the page's "Next Update" date until the page changes (or 7 days after the date, if the update is late). Otherwise it's fetched **once a day**. If the date can't be read, hourly.
- **What's stored:** every version of the page that differs from the last is parsed and saved (`tc_snapshots`): the header dates, each slot table (whatever slot tables exist that month), and the CHANGELIST.
- **CHANGELIST check:** the CHANGELIST only lists changes, so it's compared with the *difference* between the slot tables before and after the update — each card version (name + set + treatment) whose total drop weight changed must be listed with the right Change and Slots values. Cards that didn't change aren't expected in it. Also checked: each table's "Total RDR in this list" equals the sum of its rows.
  - CHANGELIST not updated → the message says so, and the changes are worked out from the slot tables.
  - CHANGELIST wrong → the message lists the differences.
  - CHANGELIST fixed later → it's checked again against the page as it was before the update began.
- **Message:** sent on every change: counts of added / removed / changed cards, new or removed slot tables, the next update date, the CHANGELIST check, and **the added cards that are in your collection or on a watch list** (matched by name, any version) with your versions' current prices. Those cards are also added to the short-term watch list.
- **GoatBots' list:** the daily price job also reads https://www.goatbots.com/card/treasure-chest-booster once (robots.txt allows /card/ pages) and stores its *Top 100 Curated Cards* — name, variant, set, foil; not its prices, which GoatBots draws as images — in `gb_chest`. GoatBots usually updates it a day or two after a chest change. The chest page uses it to pin down versions (above).
- **History:** each update is also written to `tc_history` (date from the page's "Last Updated"), with the full contents and the changes — see *Treasure Chest history* above.
- The first check only records the page; nothing is sent.

### Reprints — `functions/src/lib/reprints.js`

Asks Scryfall's search API hourly between 8 am and 8 pm Pacific for every reprint printing (paper or MTGO) in sets released from two weeks ago onward: `is:reprint (game:paper or game:mtgo) date>=…`. Scryfall adds preview cards as they're revealed, so upcoming sets and Secret Lair drops show up during spoiler season. (This replaced MagicSpoiler, which blocks Azure behind Cloudflare.)

- Every printing not seen before is matched against your collection and watch lists by name. Matches are sent in one Telegram message grouped by set (with release date and prices), saved as highlights, and added to the short-term watch list.
- The first run only records what's already there: highlights, but no Telegram message and no watch-list additions.

### Banlist — `functions/src/lib/banlist.js`

Reads https://magic.wizards.com/en/news/announcements and keeps only announcements with "Banned" in the title (e.g. *Banned and Restricted Announcement — October 12, 2026*); everything else on that page is ignored (rules in `monitors.config.js`). New ones become highlights and a Telegram message (`NOTIFY_BANLIST=false` turns the message off). The first run records the page without sending anything.

- **When:** each banned & restricted article ends with "Next announcement: November 30, 2026". The watcher reads that date from the newest one (the very first time, from the October 12 article) and checks **every 30 seconds** from 7 days before it until a new "Banned" announcement appears, or until 7 days after the date if it's late. Otherwise it checks **every 6 hours**, so an unscheduled emergency ban is still caught the same day. If an announcement doesn't state a next date: hourly.
- The page only shows the latest 8 announcements, which is plenty at these intervals.

### Player Reward Packs — `functions/src/lib/rewardPacks.js`

Reads https://www.mtgo.com/player-rewards with the Treasure Chest parser (same page layout). When the card table changes, the added, removed and re-slotted cards are saved as a highlight and sent by Telegram (`NOTIFY_REWARD_PACKS=false` turns the message off); added cards you own or watch are put on the short-term watch list. Every version is kept in `prp_snapshots`. The first check only records the page.

- **When:** reward periods start on the 1st of each month at 8 am PT and the list changes around then (November's is dated November 2). The watcher checks **every 30 seconds** from 7 days before the 1st until the list changes (or 7 days after the 1st, if it's late), and **every 6 hours** otherwise.

### One timer, and the free grant

The Treasure Chest, banlist and reward pack watchers share one 30-second timer (`functions/src/functions/watchers.js`). Each tick reads three small state documents and only fetches the pages that are due, in parallel. That's about 86,400 executions a month whatever the number of watchers, about a third of Flex Consumption's free 250,000. Execution time is billed per GB-second while an instance is busy; most ticks take a fraction of a second, and the fetches inside windows a second or two. Check Function App → *Metrics* → *On Demand Function Execution Units* / *On Demand Function Execution Count* after the first week to see the real numbers.

Window lengths and idle intervals can be changed with `TC_WINDOW_DAYS_*`, `BANLIST_WINDOW_DAYS_BEFORE` / `_AFTER`, `BANLIST_IDLE_HOURS`, `PRP_WINDOW_DAYS_BEFORE` / `_AFTER`, `PRP_IDLE_HOURS`.

### If a watcher breaks

Every watcher records errors on the website (Highlights → Monitors, in red), and the panel shows each watcher's schedule. If a page can't be read for 30 minutes during its fast-check window (Treasure Chest 6 hours, banlist 12 hours, Player Rewards a day otherwise), or Scryfall for 6 hours, you get one Telegram warning a day.

### Running the price sync now

The daily job runs at 10:20 UTC. To run it immediately (e.g. after a deploy), trigger it through the Function App's admin endpoint:

```powershell
$key = az functionapp keys list -g hobbysite-rg -n hobbysite-func-6xrma0 --query masterKey -o tsv
Invoke-RestMethod -Method Post -Uri "https://hobbysite-func-6xrma0.azurewebsites.net/admin/functions/priceSync" -Headers @{ "x-functions-key" = $key } -ContentType "application/json" -Body '{}'
```

It answers straight away (202) and runs in the background for a minute or two; the Collection page then shows "Prices updated …".

### Checking by hand

```bash
cd functions
npm run tc:dry-run         # parse the live Treasure Chest page and print what was found
npm run tc:run             # one real check now (ignores the schedule)
npm run spoilers:dry-run   # list Scryfall reprints of cards you own or watch; saves nothing
npm run spoilers:run       # one real reprint check now
npm run rewards:dry-run    # parse the live Player Rewards page; saves nothing
npm run rewards:run        # one real Player Reward Pack check now
npm run banlist:dry-run    # what the banlist watch keeps from the announcements page + the next announcement date
npm run banlist:run        # one real banlist check now
```

### Nothing else

The MTGO.com news and r/mtgo monitors were removed to keep the feed to these four things; their old highlights are cleared on the next run. Earlier MagicSpoiler reprint highlights are kept.

## 5. Deploy to Azure

Deployment is automatic: **every push to `main` deploys whatever changed.**

| Workflow | Runs when you change | What it does |
|----------|----------------------|--------------|
| `.github/workflows/deploy-web.yml` | `web/**` | tests (incl. end-to-end against a throwaway MongoDB) → deploys to **Azure App Service** → checks `/healthz` |
| `.github/workflows/deploy-functions.yml` | `functions/**` | tests → deploys to **Azure Functions (Flex Consumption)** |

Both can also be started by hand from the repo's **Actions** tab ("Run workflow"). If tests fail, nothing is deployed.

GitHub signs in to Azure with OIDC (a short-lived token GitHub issues per run), so there is no Azure password or publish profile stored in GitHub. The sign-in only works for the `main` branch of this repo and can only touch the `hobbysite-rg` resource group.

### One-time setup (≈10 minutes)

You need the [Azure CLI](https://aka.ms/installazurecliwindows). The [GitHub CLI](https://cli.github.com) is optional: with it, the script fills in GitHub for you.

```powershell
cd web; npm install; npm run hash-password; cd ..   # copy the hash it prints
az login
gh auth login                                       # optional
.\deploy\setup-azure.ps1
```

The script asks for your MongoDB connection string, the password hash, and (optionally) your Telegram token and chat id. Then it creates:

- `hobbysite-rg` resource group (Canada Central; change with `-Location`)
- an App Service plan (B1, about US$13/month) and a Node 22 web app, HTTPS only
- a storage account and a Function App on the Flex Consumption plan (pay-per-use, effectively free at this volume)
- all app settings, including a random `SESSION_SECRET`
- an Entra ID app with a federated credential for `repo:Emay08/HobbySite:ref:refs/heads/main`, given Contributor on the resource group only
- six GitHub **repository variables** (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_WEBAPP_NAME`, `AZURE_FUNCTIONAPP_NAME`). Without `gh`, it prints them for you to add under *Settings → Secrets and variables → Actions → Variables*.

It's safe to re-run, for example to change a setting. Generated app names are remembered in `deploy/.azure-names.json`, which git ignores.

Then:

1. **MongoDB Atlas → Network Access**: add the website's outbound IPs that the script prints. Flex Consumption has no fixed outbound IPs, so the scheduled scripts need `0.0.0.0/0`. The database user and password still protect the data.
2. Commit and push to `main`, then watch the **Actions** tab. Both workflows run on the first push.
3. Load initial data without waiting for the timers (from your PC, with `functions/local.settings.json` filled in):
   ```bash
   cd functions
   npm run prices:run -- --no-alert   # card list + prices
   npm run banlist:run                # seed the banlist watch (first run never notifies)
   ```

### Your own domain (ericmay.org) via Cloudflare

The free App Service plan can't take a custom domain, so a **Cloudflare Worker** serves the site at ericmay.org: it forwards every request to `hobbysite-6xrma0.azurewebsites.net` and passes the answer back. Cloudflare provides HTTPS. Code: `deploy/cloudflare-worker.js`.

- Worker settings: `ORIGIN_HOST` = `hobbysite-6xrma0.azurewebsites.net` (text), `PROXY_SECRET` (secret).
- App Service settings: `PUBLIC_HOST` = `ericmay.org`, `PROXY_SECRET` = the same value.
- With both App Service settings set, the site only trusts requests that carry the secret (so the visitor's real IP is used for the login limit), and redirects anyone opening the azurewebsites.net address to ericmay.org — except `/healthz`, which the deploy workflow checks. Remove either setting to switch this off.

If you move to a paid plan (Basic B1) later, you can instead add the domain under App Service → *Custom domains* with a free managed certificate, and delete the Worker.

Logs: App Service → *Log stream*; Function App → *Monitor* / *Log stream*.

> The repo previously deployed a placeholder page to an Azure **Static Web App** ("calm-sand-…"). That workflow has been removed, because Static Web Apps only serve static files and can't run this site's server. Delete the old Static Web App resource in the Azure portal when convenient.

## Settings reference

**web** (`.env` / App Service settings)

| Name | Required | Notes |
|------|----------|-------|
| `MONGODB_URI` | yes | |
| `MONGODB_DB` | no | default `mtgo_manager` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` | yes | `npm run hash-password` |
| `SESSION_SECRET` | yes | long random string |
| `NODE_ENV` | prod | `production` turns on secure cookies |
| `DISPLAY_TIMEZONE` | no | default `America/Vancouver` |
| `WATCH_ALERT_PCT` | no | default alert % shown on the short-term list; keep in step with the functions setting |
| `VENDOR_LIVE_DISABLED` | no | `1` turns off live Cardhoarder / Dojo lookups on card pages |
| `PUBLIC_HOST` / `PROXY_SECRET` | no | custom domain through the Cloudflare Worker (see *Your own domain*) |
| `SCRYFALL_DISABLED` | no | `1` stops Scryfall lookups (used by the tests) |

**functions** (`local.settings.json` / Function App settings)

| Name | Notes |
|------|-------|
| `MONGODB_URI`, `MONGODB_DB` | same database as the website |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | leave empty to disable Telegram |
| `PRICE_SYNC_SCHEDULE` | NCRONTAB, UTC. Default 10:20 UTC daily |
| `TC_WINDOW_DAYS_BEFORE` / `TC_WINDOW_DAYS_AFTER` | Treasure Chest fast-check window around "Next Update" (default 7 / 7) |
| `TC_IDLE_HOURS` | Treasure Chest check interval outside the window (default 24) |
| `SPOILER_HOURS` | reprint watch active hours, Pacific (default `8-20`) |
| `BANLIST_WINDOW_DAYS_BEFORE` / `_AFTER`, `BANLIST_IDLE_HOURS` | banlist fast-check window around "Next announcement" (default 7 / 7) and interval outside it (default 6) |
| `PRP_WINDOW_DAYS_BEFORE` / `_AFTER`, `PRP_IDLE_HOURS` | reward pack fast-check window around the 1st (default 7 / 7) and interval outside it (default 6) |
| `NOTIFY_BANLIST`, `NOTIFY_REWARD_PACKS` | set to `false` to keep banlist / reward pack changes off Telegram (on by default) |
| `NOTIFY_PRICE_TARGETS`, `NOTIFY_SWAPS`, `NOTIFY_SHORT_WATCH`, `NOTIFY_COLLECTION_MOVERS` | set to `true` to also get Telegram messages for these (all off by default) |
| `PRICE_ALERT_MIN_PCT` / `PRICE_ALERT_MIN_TIX` | thresholds for the collection-movers message, if turned on (default 25 % and 2 tix) |
| `WATCH_ALERT_PCT` | default daily-move alert for the short-term watch list (default 15) |
| `GOATBOTS_PRICES_URL` / `GOATBOTS_CARDS_URL` | override if GoatBots moves the files (defaults: `https://www.goatbots.com/download/prices/price-history.zip` and `…/prices/card-definitions.zip`, with the older `/download/…` paths as fallback) |

## Tests

```bash
cd web && npm test          # CSV parsing
cd functions && npm test    # link/RSS extraction, classification, price-file parsing
```

With a MongoDB to test against (a local one, or a throwaway Atlas database), the end-to-end tests also run. They create and drop their own databases (`mtgo_e2e_test`, `mtgo_fn_test`):

```bash
export TEST_MONGODB_URI="mongodb://127.0.0.1:27017/?directConnection=true"
cd web && npm test          # + login, upload, card search, watch lists, targets, swaps, card pages, spreadsheet import through the real server
cd functions && npm test    # + daily job, Treasure Chest scenarios (stale / wrong / late CHANGELIST), reprint watcher
```

## Show Order — recital running-order planner (`/showorder`)

Plans the running order of a multi-night dance recital. Everything is solved in the browser (`web/public/showorder-solver.js`); the server only renders the page and saves the project.

**Data** — three CSVs, dropped together or one at a time (column names are matched loosely):

| File | Columns |
|------|---------|
| Dancers | `name` (or `first name` + `last name`), `age`, `family` (same text for siblings, optional) |
| Class lists | `class`, `dancer` — one row per dancer per class (or `class` + `dancers` separated by `;`) |
| Dances | `dance`, `class` (several separated by `;`), `hair` (`up` / `down` / blank = either), optional `minutes` (default 3), `night`, `act`, `position` (`first`, `last` or a number) |

A dance's dancers are everyone in its class(es). **Generate** makes a simulated studio (≈200 dancers, ≈40 classes, siblings, Company opening each night) from a seed, and the lists can be downloaded as CSV templates.

**Firm rules** (each break costs 1000 points, so a schedule shows ✓ only when none are broken):
- at least *N* dances between two of a dancer's dances (default 2; the intermission counts as enough time unless unticked);
- hair: once a dancer has been in a hair-down dance, no hair-up dance for her later that night (optionally reset at intermission);
- dancers under the age limit (default 7) only before intermission;
- fixed `night` / `act` / `position` from the dances file, and locked dances.

**Preferences** (weights editable on the page): dancers with ≤ 2 dances on one night, families with ≤ 4 dances on one night, younger → older through each night (years away from a perfectly sorted night), roomier costume changes than the minimum, nights and acts the same length.

**Search**: simulated annealing (swaps, moves between nights/acts, short reversals, intermission shifts) run several times from different random starts; the best different schedules are kept and ranked. About half a second per run at *Normal* effort for a 47-dance show.

**Working with the results**: tabs per schedule with a scorecard; click a dance to see its dancers and where else each dances (shared dances highlighted); find a dancer or family; drag dances (also across the intermission or to the other night) and the page re-checks instantly; 🔒 a dance to keep it in its slot, then **Re-solve around locked** (the schedule before the re-solve is kept as a tab). Locks belong to that schedule. Exports: running order CSV, per-dancer list CSV (nights, slots, closest change), and a print layout. **Save** stores everything in MongoDB.

Tests: `web/test/showorder.test.js` (rules, solver, locks, sample data).

## Adding more tools later

The landing page (`web/views/home.ejs`) is a grid of tiles. Add a new tile, a router under `web/routes/`, and mount it in `server.js` behind `requireLogin` — everything else (auth, layout, DB) is shared.
