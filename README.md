# Vault — personal site + MTGO collection manager

Two deployables that share one MongoDB database:

```
mtgo-manager/
├── web/         Express website (Azure App Service)
│                login → landing page → MTGO manager (highlights, collection browser, CSV upload)
└── functions/   Azure Functions app (timer triggers)
                 siteMonitor  – every 30 min: watch sites, save highlights, Telegram alerts
                 priceSync    – daily: GoatBots cards + prices → value history, tracked-card history,
                                alerts for price targets, version swaps, short-term watch list, collection movers
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
| `highlights`    | functions/siteMonitor| News items shown on the MTGO front page |
| `monitor_state` | functions/siteMonitor| What each monitor has already seen, last run, last error |
| `meta`          | functions/priceSync  | Last price sync time |
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

### Watch lists, price targets and version swaps
Each has its own page in the MTGO menu. Cards are picked with a search box that covers every printing on MTGO (from GoatBots' card list, refreshed daily). Until the first daily job has run, the search only finds cards in your own collection.

| Page | What it shows | Telegram |
|------|---------------|----------|
| **Short watch** | price, 1-day and 7-day change, change since added, 30-day chart | daily digest of cards that moved more than their alert % (default 15 %, per card) |
| **Long watch** | price, 30- and 90-day change, change since added, 6-month chart, notes | none |
| **Targets** | three groups: *reached*, *getting close* (within the card's "close" %, default 10 %), *waiting*. Buy targets (≤) or sell targets (≥) | once when a target is reached. It re-arms if the price moves back, or if you edit the target |
| **Swaps** | the version you own next to the one you want, the price gap, total saving across your copies | once when the wanted version becomes cheaper by at least your minimum saving. It re-arms when the gap closes |

Items move between the short- and long-term lists with one click. Charts start from the day a card is added (price history is only kept for tracked cards so the database stays small) and fill in as the daily job runs. All alerts are checked once a day, after the price update.

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

## 4. Monitors

Monitors are defined in **`functions/src/lib/monitors.config.js`**. Out of the box:

| id | Watches | Saved as highlight | Telegram |
|----|---------|--------------------|----------|
| `mtgo-news` | mtgo.com/news — new articles. Weekly announcement posts are opened and their body is scanned, since Treasure Chest changes are usually buried there. | all new articles | Treasure Chest + reprint matches |
| `reddit-mtgo` | r/mtgo RSS | only posts matching Treasure Chest / reprint keywords | no |
| `example-page-watch` | template: alert when any single page's text changes | — | disabled |

**Before deploying, check that the selectors still match the live sites:**

```bash
npm run monitors:dry-run              # no DB writes, no Telegram — just prints what it would find
npm run monitors:dry-run mtgo-news    # one monitor
```

If a monitor extracts nothing, the site's HTML changed (or it now needs JavaScript): adjust `itemSelector` / `hrefPattern`. The website also flags a monitor in red when its last run extracted nothing or failed.

Adding a site is a few lines — e.g. watch a set's release page and buzz your phone when it changes:

```js
{ id: 'mh4-release', label: 'MH4 release page', enabled: true, type: 'page',
  url: 'https://example.com/some-page', contentSelector: 'main',
  rules: [], default: { category: 'reprint', notify: true, keep: true } },
```

The first successful run of any monitor saves what it finds but sends nothing, so you don't get 30 messages for old articles.

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

**functions** (`local.settings.json` / Function App settings)

| Name | Notes |
|------|-------|
| `MONGODB_URI`, `MONGODB_DB` | same database as the website |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | leave empty to disable Telegram |
| `MONITOR_SCHEDULE` | NCRONTAB (6 fields, UTC). Default every 30 min |
| `PRICE_SYNC_SCHEDULE` | NCRONTAB, UTC. Default 10:20 UTC daily |
| `PRICE_ALERTS` | `true` → daily Telegram digest of big movers among cards you own |
| `PRICE_ALERT_MIN_PCT` / `PRICE_ALERT_MIN_TIX` | thresholds for the digest (default 25 % and 2 tix) |
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
cd web && npm test          # + login, upload, card search, watch lists, targets, swaps through the real server
cd functions && npm test    # + daily job: prices, history, target/swap/watch alerts (GoatBots + Telegram faked)
```

## Adding more tools later

The landing page (`web/views/home.ejs`) is a grid of tiles. Add a new tile, a router under `web/routes/`, and mount it in `server.js` behind `requireLogin` — everything else (auth, layout, DB) is shared.
