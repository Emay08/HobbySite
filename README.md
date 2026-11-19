# Vault — personal site + MTGO collection manager

Two deployables that share one MongoDB database:

```
mtgo-manager/
├── web/         Express website (Azure App Service)
│                login → landing page → MTGO manager (highlights, collection browser, CSV upload)
└── functions/   Azure Functions app (timer triggers)
                 treasureChest – Treasure Chest page: every 30 s near an update, daily otherwise  → Telegram
                 spoilerWatch  – MagicSpoiler, hourly 8 am–8 pm PT: reprints of your cards       → Telegram
                 siteMonitor   – every 30 min: MTGO news + r/mtgo headlines for the website
                 priceSync     – daily: GoatBots cards + prices → value history, tracked-card history,
                                 target / swap status for the website
```

## What's in MongoDB

| Collection      | Written by           | Contents |
|-----------------|----------------------|----------|
| `collection`    | web (CSV upload)     | One doc per MTGO catalog ID: name, qty, set, rarity, foil |
| `uploads`       | web                  | Upload log with added/removed/changed counts |
| `prices`        | functions/priceSync  | `_id` = MTGO catalog ID, `price`, `prevPrice` (tix) |
| `cards`         | functions/priceSync  | Every MTGO printing (name, set, foil) — powers the card search |
| `price_history` | both                 | Daily price per tracked card (anything on a watch list, target or swap) |
| `watchlist`     | web                  | Short- and long-term watch-list entries (`list: 'short' \| 'long'`) |
| `targets`       | web + priceSync      | Price targets; the daily job sets `hit` / `hitAt` |
| `swaps`         | web + priceSync      | Version swaps; the daily job sets `good` when the wanted printing is cheaper |
| `value_history` | both                 | One doc per day: total collection value |
| `highlights`    | functions            | Items shown on the MTGO front page (news, Treasure Chest updates, reprints) |
| `monitor_state` | functions            | Each watcher's state: last run, last error, schedule |
| `tc_snapshots`  | functions/treasureChest | Parsed copies of the Treasure Chest page (last 30 changes) |
| `spoiler_pages` | functions/spoilerWatch  | Card names already seen on each MagicSpoiler page |
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
- Entries without a card name wait on the import page to be named or skipped; *remove* on a card page skips one for good.

### Treasure Chest history — **Highlights → Treasure Chest → Update history**
Every recorded update (`/mtgo/tc`): added / removed / changed counts, cards and total slots in the chest, and a page per update with the changes, the full contents and which of them you own. Card pages have a **Treasure Chest** section: when each version was in the chest (added, removed, how many updates, max slots) and every changelist row that mentions it. The watcher writes each new update to the same place, contents and all.

For the later price analysis, the daily job also stores `price_daily`: one compact document per day with the GoatBots price of every printing of every card that has been in the chest, plus everything you own (a few thousand IDs, under 100 KB a day). GoatBots only publishes today's prices, so this history starts when this is deployed.

### Watch lists, price targets and version swaps
Each has its own page in the MTGO menu. Cards are picked with a search box that covers every printing on MTGO (from GoatBots' card list, refreshed daily). Until the first daily job has run, the search only finds cards in your own collection.

| Page | What it shows |
|------|---------------|
| **Short watch** | price, 1-day and 7-day change, change since added, 30-day chart. Rows are highlighted when a card moved more than its alert % today (default 15 %). Cards found by the Treasure Chest and reprint watchers are added here automatically (tagged *auto*). |
| **Long watch** | price, 30- and 90-day change, change since added, 6-month chart, notes |
| **Targets** | three groups: *reached*, *getting close* (within the card's "close" %, default 10 %), *waiting*. Buy targets (≤) or sell targets (≥) |
| **Swaps** | the version you own next to the one you want, the price gap, total saving across your copies; *Swap now* when the wanted version is cheaper by at least your minimum saving |

Items move between the short- and long-term lists with one click. Charts start from the day a card is added (price history is only kept for tracked cards so the database stays small) and fill in as the daily job runs. Target and swap status is updated once a day, after the price update. None of these send Telegram messages unless you turn that on (see `NOTIFY_*` settings).

### Card pages
Click any card name (collection, watch lists, targets, swaps) to open its page:

- **Your versions**: quantity, value, and what Cardhoarder and Dojo would pay you right now.
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
- **History:** each update is also written to `tc_history` (date from the page's "Last Updated"), with the full contents and the changes — see *Treasure Chest history* above.
- The first check only records the page; nothing is sent.

### Reprints — `functions/src/lib/spoilers.js`

Reads https://www.magicspoiler.com hourly between 8 am and 8 pm Pacific.

- The pages to check are taken from the site's navigation bar on every run, including sub-menus (e.g. *Star Trek › Star Trek Commander*), so new sets are picked up automatically.
- Set pages: every card, following page 2, 3, …. News posts (e.g. Secret Lair drops): "1x Card Name" lines, plus names of your cards mentioned in the text (some posts only show cards as images; those can't be read).
- Every card not seen before on that page is matched against your collection and watch lists by name. Matches are sent in one Telegram message with prices, saved as highlights, and added to the short-term watch list.
- The very first run treats everything already on the site as new, so expect one larger message listing current reprints of cards you own.

### If a watcher breaks

Both watchers record errors on the website (Highlights → Monitors, in red). If the Treasure Chest page can't be read for 30 minutes during an update window (6 hours otherwise), or MagicSpoiler for 6 hours, you get one Telegram warning a day. MagicSpoiler sits behind Cloudflare; if it starts blocking Azure, the warning will say so.

### Checking by hand

```bash
cd functions
npm run tc:dry-run         # parse the live Treasure Chest page and print what was found
npm run tc:run             # one real check now (ignores the schedule)
npm run spoilers:dry-run   # list pages + cards you own that are on them; saves nothing
npm run spoilers:run       # one real check now
```

### News feed (website only)

`functions/src/lib/monitors.config.js` also fetches mtgo.com/news and r/mtgo headlines every 30 minutes for the Highlights page. These never send Telegram messages. Check them with `npm run monitors:dry-run`.

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
   npm run monitors:run               # seed monitors (first run never notifies)
   ```

To use your own domain later: App Service → *Custom domains* → add the domain plus a free managed certificate.

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

**functions** (`local.settings.json` / Function App settings)

| Name | Notes |
|------|-------|
| `MONGODB_URI`, `MONGODB_DB` | same database as the website |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | leave empty to disable Telegram |
| `MONITOR_SCHEDULE` | NCRONTAB (6 fields, UTC). Default every 30 min |
| `PRICE_SYNC_SCHEDULE` | NCRONTAB, UTC. Default 10:20 UTC daily |
| `TC_WINDOW_DAYS_BEFORE` / `TC_WINDOW_DAYS_AFTER` | Treasure Chest fast-check window around "Next Update" (default 7 / 7) |
| `TC_IDLE_HOURS` | Treasure Chest check interval outside the window (default 24) |
| `SPOILER_HOURS` | MagicSpoiler active hours, Pacific (default `8-20`) |
| `NOTIFY_PRICE_TARGETS`, `NOTIFY_SWAPS`, `NOTIFY_SHORT_WATCH`, `NOTIFY_COLLECTION_MOVERS` | set to `true` to also get Telegram messages for these (all off by default) |
| `PRICE_ALERT_MIN_PCT` / `PRICE_ALERT_MIN_TIX` | thresholds for the collection-movers message, if turned on (default 25 % and 2 tix) |
| `WATCH_ALERT_PCT` | default daily-move alert for the short-term watch list (default 15) |
| `GOATBOTS_PRICES_URL` / `GOATBOTS_CARDS_URL` | override if GoatBots moves the files |

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

## Adding more tools later

The landing page (`web/views/home.ejs`) is a grid of tiles. Add a new tile, a router under `web/routes/`, and mount it in `server.js` behind `requireLogin` — everything else (auth, layout, DB) is shared.
