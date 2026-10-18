# 估值钟摆 · 看板 (Valuation Pendulum Watchlist)

## Overview

A Cloudflare Worker serving a **multi-user valuation-pendulum watchlist** platform. Each user
gets a private dashboard to manage their own watchlist and a public read-only board at
`/b/<slug>`. Users register with a one-time activation code issued by the station-master
(owner). Live stock quotes and search hints are proxied server-side from Tencent Finance
(`qt.gtimg.cn` / `smartbox.gtimg.cn`), so the browser never makes cross-origin requests.
Sessions are stateless HMAC-signed cookies (`SESSION_SECRET`). The owner backend is gated by
`ADMIN_PASSWORD`.

**Real-time quotes:** if `LONGBRIDGE_APP_KEY` / `LONGBRIDGE_APP_SECRET` / `LONGBRIDGE_ACCESS_TOKEN` are set as Worker secrets, `/api/quotes` pulls real-time prices from LongPort/Longbridge OpenAPI over its WebSocket long-connection (OTP → auth → QuerySecurityQuote cmd 11, parsed in `src/longbridge.js`); any symbol it can't return falls back to Tencent's delayed feed. Without the secrets it's Tencent-only. The access token expires — refresh it in the Longbridge developer portal and re-run `wrangler secret put LONGBRIDGE_ACCESS_TOKEN`.

**Languages:** the UI is bilingual (中文 / English). Switch language in the board's Settings tab; login, register and valuation pages have their own switcher; the choice persists in `localStorage` (`pendulum_lang`) and defaults to the browser language. Dictionaries live in `public/shared/i18n.js`; the owner backend (`/owner`) is Chinese-only.

## Entry Points

| URL | Description |
|-----|-------------|
| `/login` | User login page — after signing in (or registering) you land on `/portfolio` |
| `/register` | New-user registration (requires an activation code) |
| `/b/<slug>` | The board page — read-only for visitors; the signed-in owner edits items via dialogs and opens Settings (top-right) for text/colors/board config |
| `/app` | Legacy entry — 302 redirect to your `/b/<slug>` (or `/login`) |
| `/owner` | Station-master backend — issue activation codes, manage users, reset passwords |
| `/portfolio` | Signed-in user's Portfolio — linked broker accounts (Longbridge / IBKR Flex / manual + CSV), total assets and holdings mapped onto the board's valuation zones |

## Architecture

```
Cloudflare Worker (src/index.js)  — Hono router
│
├── src/auth.js        HMAC-SHA-256 stateless session tokens; signToken/verifyToken
│                      carry {role, uid} claims (role: "user" | "owner")
├── src/password.js    PBKDF2-SHA256 password hashing (hashPassword / verifyPassword)
├── src/codes.js       Unambiguous base32 activation-code generator (generateCode)
├── src/users.js       Username/slug validation and DB-row ↔ camelCase mapping
├── src/items.js       Watchlist item validation and DB-row ↔ camelCase mapping
├── src/quotes.js      Tencent Finance GBK response parsers (quotes + hints)
│
├── public/login.html  Login page
├── public/register.html  Registration page (activation code required)
├── public/index.html  Unified board page (visitor read-only / owner edit-in-place)
├── public/owner.html  Station-master backend (codes, users, password reset)
└── public/shared/
    ├── core.js        Pure business logic ESM module (pendulum math, no DOM)
    ├── gauge.js       Canvas/SVG gauge renderer
    ├── market.js      Map of market code → Chinese label (e.g. us→美股, sh→沪A)
    └── styles.css     Shared stylesheet

D1 database (binding: DB)
├── users             — id, username, pass_hash, pass_salt, board_slug, board_name, created_at
├── items             — id, user_id, ticker, name, symbol, fair_low, fair_high, mos, ext,
│                       sort_order, updated_at
├── settings          — (user_id, key) composite PK; public keys: default_mos, default_ext
│                       (new-stock defaults); internal: _ai_usage, _ai_active
└── activation_codes  — code (PK), used_by (user id), created_at, used_at
```

### Cookie names

| Cookie | Scope |
|--------|-------|
| `pendulum_user` | Authenticated user session (`{role:"user", uid:<id>}`) |
| `pendulum_owner` | Station-master session (`{role:"owner"}`) |

Both are `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`.

### Test workspace (`vitest.workspace.js`)

| Project | Runner | Covers |
|---------|--------|--------|
| `core` | Node (vitest default) | `test-core/core.test.js` — pure pendulum logic |
| `worker` | `@cloudflare/vitest-pool-workers` | `test/*.test.js` — auth, password, codes, users, items, quotes, routes |

## Local Development

### Prerequisites

- Node.js 18+ and npm
- No Cloudflare account needed for local dev

### Setup

```bash
npm install
```

Create `.dev.vars` in the project root (gitignored):

```ini
ADMIN_PASSWORD = "dev-pass"
SESSION_SECRET = "dev-secret-please-change"
```

Initialise the local D1 database (creates `.wrangler/state/v3/d1/`):

```bash
npm run db:init
```

### Run locally

```bash
npm run dev
```

Then open:

- http://localhost:8787/login — user login
- http://localhost:8787/register — new-user registration
- http://localhost:8787/app — legacy redirect to your board (or `/login` if not authenticated)
- http://localhost:8787/owner — station-master backend (enter `dev-pass`)
- http://localhost:8787/b/\<slug\> — public board for a registered user

### Tests

```bash
npm test          # runs all vitest tests across core + worker projects
```

## Deployment (fresh)

The steps below require a Cloudflare account and `wrangler login` (run once).

```bash
# 1. Create the D1 database and note the database_id in the output
npx wrangler d1 create pendulum-db

# 2. Copy the database_id printed above into wrangler.toml:
#    database_id = "<the-id-from-step-1>"

# 3. Apply the schema to the remote database
npx wrangler d1 execute pendulum-db --remote --file=./schema.sql

# 4. Set secrets (you will be prompted to enter values)
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET

# 5. Deploy
npm run deploy
```

After deploying:
1. Open `/owner` and log in with your `ADMIN_PASSWORD`.
2. Generate activation codes and share them with new users.
3. New users visit `/register`, enter their username, password, and activation code.

> **Note:** `wrangler.toml` ships with `database_id = "PLACEHOLDER_RUN_d1_create_TO_FILL"`.
> Replace this with the real ID returned by `d1 create` before deploying.

## Migration (existing single-board DB to multi-user)

If you have an existing single-board deployment (pre-multi-user schema), run the migration
script **once** against your remote D1 database:

```bash
npx wrangler d1 execute pendulum-db --remote --file=./migrate-to-multiuser.sql
```

What the migration does:

- Creates `users` and `activation_codes` tables if they do not exist.
- Seeds a placeholder user (id=1, username `owner`, board slug `main`) with an **empty
  password** — this user cannot log in until their password is reset.
- Adds a `user_id` column to `items` (defaults to 1, attributing all existing items to the
  placeholder owner user).
- Rebuilds `settings` with the composite `(user_id, key)` primary key, migrating all existing
  settings rows to user 1.

After running the migration:

1. Make sure `ADMIN_PASSWORD` and `SESSION_SECRET` secrets are set (via `wrangler secret put`).
2. Deploy the new worker (`npm run deploy`).
3. Open `/owner`, log in with your `ADMIN_PASSWORD`.
4. Find the `owner` user in the Users table and click **Reset Password** to get a temporary
   password — the placeholder user has an empty password hash and cannot log in until reset.
5. Log in at `/login` as `owner` with the temporary password, then manage items/settings from
   your board page `/b/<slug>`.
6. Generate activation codes for additional users via `/owner`.

New deployments should use `schema.sql` directly and skip this migration entirely.

## Portfolio

Each user can link their own brokerage accounts on `/portfolio`. Holdings and cash are stored as a snapshot per account (`broker_accounts`, `holdings`, `cash_balances`), priced with the same quote source as the board (Longbridge first, Tencent fallback), converted with ECB reference FX rates (Frankfurter), and mapped onto the user's own board items to show how much of the portfolio sits in each valuation zone.

| Source | How | Freshness |
|--------|-----|-----------|
| Longbridge | User's own App Key / App Secret / Access Token → `GET /v1/asset/stock` + `/v1/asset/account` (`src/brokers/longbridge-assets.js`) | Live, on "Sync" |
| IBKR | Flex Web Service token + Activity Flex Query ID (Open Positions + Cash Report) → SendRequest / GetStatement (`src/brokers/ibkr-flex.js`) | End of day |
| Manual / CSV | Hand-entered rows, or a broker holdings export with English or Chinese headers (`src/brokers/csv.js`) | Whenever edited |

**Asset curve.** There is no historical data from brokers, so the curve is recorded going forward: a daily Cron Trigger (`wrangler.toml` `[triggers]`, 22:30 UTC — after the US close) syncs every Longbridge / IBKR account and writes one snapshot per user per day into `portfolio_snapshots` (total + each account, stored in USD, HKD and CNY at that day's FX). Opening the Portfolio page also refreshes today's row. It does not back-fill from today's holdings × past prices, because past positions were different.

**Target allocation.** Users can set an intended weight per symbol (percent of total assets, cash included) plus a cash target, stored as one JSON plan per user in `portfolio_plans`. Drift is flagged with the 5/25 rule: off target by more than `band` points (default 5) or more than `rel`% of the target (default 25), whichever is tighter. Suggested actions combine drift with the board's valuation zone (overweight + overvalued → trim; underweight + strike zone / undervalued → add; underweight but overvalued → wait), and targets for board items you don't hold yet show up as planned positions.

**Credentials** are validated, encrypted with AES-256-GCM (`src/crypto.js`) using the `CREDENTIALS_KEY` Worker secret, and never returned by any endpoint — the API only reports whether credentials exist plus the last four characters of the key / query ID. They are used only to read positions and balances.

Setup for an existing deployment:

```bash
# 1. New tables
npx wrangler d1 execute pendulum-db --remote --file=./migrations/2026-10-17-portfolio.sql
npx wrangler d1 execute pendulum-db --remote --file=./migrations/2026-10-17-portfolio-history.sql
npx wrangler d1 execute pendulum-db --remote --file=./migrations/2026-10-17-portfolio-plan.sql
npx wrangler d1 execute pendulum-db --remote --file=./migrations/2026-10-17-ai-models.sql
# 2. Encryption key for broker credentials (32 random bytes, base64). Keep it stable: rotating it makes stored credentials unreadable.
openssl rand -base64 32 | npx wrangler secret put CREDENTIALS_KEY
```

For local dev, add `CREDENTIALS_KEY = "<base64 32 bytes>"` to `.dev.vars` and run the migration with `--local`.

## AI valuation assistant

Both AI features are grounded: `public/shared/valuation/facts.js` turns the annual reports into verified statements (revenue trend, loss years, negative free-cash-flow years, earnings / cash-flow stability verdicts, capex jumps, net cash, dividend record — "no dividend record found" when neither the dividend history nor the quote has one), and the prompts require every claim about stability, dividends, growth or debt to match them. The method picker has **Ask AI to recommend**: the model reads the company's business and financials and marks one primary method plus one or two cross-checks on the method cards (cached per stock for the session). Each saved valuation card has **AI review**: it sends the card's assumptions with the verified facts, the latest actuals (`latestMetrics`) and code-computed comparisons of each assumption against the latest value (`assumptionChecks`: below both cases / between / above both — the model only explains, it doesn't compare numbers) and stores the verdict on the card as `review` (validated in `src/items.js`). The valuation workbench has an **Ask AI** drawer: chat about the stock, and the model returns suggested inputs for the current method (conservative / optimistic, with reasons) that you preview and apply to the form with one click (undoable). The server sends the model the stock, the known financials and the current method's fields; the model replies with prose plus a ```json block, which `src/ai.js` validates against the field list. No native tool calling is needed, so any provider works.

**Per-user models.** Settings only configure; the AI panel switches. Under board settings → **AI models** a user adds their own OpenAI-compatible or Anthropic models (name, model, base URL, key; several allowed, stored in `ai_models` with the key encrypted by `CREDENTIALS_KEY`, never returned — only the last four characters). The model switcher at the top of the AI panel picks among the site default, a few Workers AI models (no setup) and those custom models; the choice applies to chat, method recommendations and reviews. Requests on the user's own key skip the site's daily limit. Base URLs must be https; "Test connection" sends one tiny request with the unsaved form values.

The site default provider is configured with:

| Var | Default | Notes |
|-----|---------|-------|
| `AI_PROVIDER` | `workers-ai` | `workers-ai` (uses the `[ai]` binding, no key), `openai` (any OpenAI-compatible API), `anthropic` |
| `AI_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` / `gpt-4o-mini` / `claude-sonnet-5-5` | Per provider |
| `AI_BASE_URL` | Official endpoint | For `openai` / `anthropic`; point at any compatible service |
| `AI_API_KEY` | — | Secret, for `openai` / `anthropic`: `npx wrangler secret put AI_API_KEY` |

Set `AI_PROVIDER` / `AI_MODEL` / `AI_BASE_URL` under `[vars]` in `wrangler.toml`. Each user gets 100 AI messages per day on the site default / Workers AI. Workers AI runs on your Cloudflare account even in `wrangler dev`, so local chats count toward usage.

## Macro

`/macro` follows `docs/macro-design.md`: no forecasts, only how expensive each market is versus its own history ("water level") and long rates ("gravity"), ending at the user's own strike zone. `src/macro.js` pulls monthly series into `macro_series` — multpl (Shiller CAPE, 10-year Treasury, 10-year real yield), FRED public CSV (non-financial corporate equity and GDP for market cap / GDP; optional, 10 s timeout), eastmoney (all-A-share P/E since 2017, China 10-year) — at most once a week from the daily cron, or on the first request when the table is empty. Each indicator becomes a percentile of its own history; a market's level is the average "expensiveness" percentile, mapped to the five pendulum zones (0–10 strike … 90–100 bubble). Hong Kong is a placeholder until long Hang Seng valuation history is wired in.

```bash
npx wrangler d1 execute pendulum-db --remote --file=./migrations/2026-10-18-macro.sql
```

## API Reference

### Public

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config?slug=<slug>` | Board data: `{board, items, settings}` for the given slug; 404 if unknown |
| GET | `/api/quotes?symbols=usAAPL,usGOOGL` | Live prices proxied from Tencent Finance |
| GET | `/api/hints?q=apple` | Search hints proxied from Tencent Finance |

### Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/register` | `{username, password, code}` → sets user cookie; 400/409 on error |
| POST | `/api/login` | `{username, password}` → sets user cookie; 401 on failure |
| POST | `/api/logout` | Clears user cookie |
| GET | `/api/me` | `{username, board}` for current session; 401 if unauthenticated |

### User (requires `pendulum_user` cookie)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/my/items` | List current user's items |
| POST | `/api/my/items` | Create item → 201 `{ok, id}` |
| PUT | `/api/my/items/:id` | Update item; 404 if not owned |
| DELETE | `/api/my/items/:id` | Delete item; 404 if not owned |
| GET | `/api/my/settings` | Get current user's settings |
| PUT | `/api/my/settings` | Update settings (partial) |
| PUT | `/api/my/board` | `{slug, name}` → update board metadata; 409 on slug conflict |

### Portfolio (requires `pendulum_user` cookie; every query is scoped to the session's `uid`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/my/portfolio?base=USD` | Accounts, holdings, cash, quotes, previous closes, FX rates into `base`, and the user's board items (fair ranges) |
| GET | `/api/my/portfolio/history?days=365` | Daily snapshots `{day, accountId (0 = total), USD, HKD, CNY}`, oldest first |
| GET | `/api/my/portfolio/accounts` | List accounts (`hasCreds`, `credHint`, `lastSyncAt`, `lastError`) — never credentials |
| POST | `/api/my/portfolio/accounts` | `{broker: "longbridge"\|"ibkr"\|"manual", name, creds?}` → 201 `{ok, id, sync}`; broker accounts sync once immediately |
| PUT | `/api/my/portfolio/accounts/:id` | `{name?, creds?}` — rename / replace credentials |
| DELETE | `/api/my/portfolio/accounts/:id` | Delete the account and its snapshot |
| POST | `/api/my/portfolio/accounts/:id/sync` | Pull the latest snapshot from the broker; failures are stored in `lastError` |
| PUT | `/api/my/portfolio/accounts/:id/holdings` | Manual accounts only: replace `{positions, cash}` |
| GET | `/api/my/portfolio/plan` | `{plan: {targets: {symbol: pct}, cash, band, rel}}` (defaults when unset; also included in `GET /api/my/portfolio`) |
| PUT | `/api/my/portfolio/plan` | Replace the plan; weights 0–100, all targets + cash ≤ 100, `band` 0.5–30, `rel` 5–100 |
| POST | `/api/my/portfolio/accounts/:id/import` | Manual accounts only: `{text}` CSV → replaces positions, keeps cash; returns `{imported, unsupported, errors}` |

### AI (requires `pendulum_user` cookie)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/my/ai/models` | `{active, site, workers: [...], custom: [{id: "m:<n>", kind, name, model, baseUrl, keyHint}]}` — never keys |
| PUT | `/api/my/ai/active` | `{id: "default" \| "wa:<model>" \| "m:<n>"}` — switch the model in use |
| POST | `/api/my/ai/models` | `{provider: "openai"\|"anthropic", name, model, baseUrl, apiKey}` → 201 `{id}` (max 10) |
| PUT | `/api/my/ai/models/:n` | Same body; omit `apiKey` to keep the saved one |
| DELETE | `/api/my/ai/models/:n` | Delete; if it was in use, the site default is used again |
| POST | `/api/my/ai/models/test` | Same body (plus `id` to reuse a saved key); one tiny request without saving → `{ok, reply, ms, model}` or `{ok: false, error}` |
| POST | `/api/my/ai/review` | `{lang, stock, method, valuedAt, fields, result:{low,high,price}, verified, metrics, comparisons}` → `{review:{overall: "hold"\|"watch"\|"broken", summary, checks:[{k, status, reason}], at}}`; 502 `bad_ai_output` if the model ignores the format; shares the daily limit |
| POST | `/api/my/ai/method` | `{lang, stock, facts, methods:[{key,title,subtitle}]}` → `{reply, picks:[{key, role: "primary"\|"check", reason}]}`; shares the daily limit |
| POST | `/api/my/ai/valuation` | `{lang, messages:[{role,content}], context:{stock, method, mode, fields, facts}}` → `{reply, params, reasons}`; 429 after 100/day, 502 if the provider fails |

### Macro (public)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/macro` | `{updatedAt, markets: [{key, level, zone, indicators: [{key, value, unit, date, since, pct, expensive, cheapHigh}]} \| {key, pending}], gravity: {us: {ey, y10, real}, cn: {ey, y10}}}`; refreshes in the background when older than 7 days |

### Station-master (requires `pendulum_owner` cookie)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/owner/login` | `{password}` → sets owner cookie; 401 on failure |
| POST | `/api/owner/logout` | Clears owner cookie |
| GET | `/api/owner/codes` | List all activation codes with usage status |
| POST | `/api/owner/codes` | `{count}` → mint 1-50 codes; returns `{ok, created:[...]}` |
| GET | `/api/owner/users` | List all registered users |
| POST | `/api/owner/users/:id/reset` | Reset a user's password → `{ok, password:"<temp>"}` |

Any unmatched `/api/*` path returns a JSON 404. All other paths are served from the `public/`
static-asset directory via the `ASSETS` binding.

## Notes

- `compatibility_flags = ["nodejs_compat"]` is required (already set in `wrangler.toml`) for
  the `TextDecoder("gbk")` used in GBK-encoded Tencent Finance responses.
- Quote and hint endpoints are proxied server-side to avoid browser CORS restrictions.
- Sessions are stateless: the worker holds no state beyond D1. Rotating `SESSION_SECRET`
  invalidates all existing sessions immediately.
- All user data operations are strictly isolated by `uid` extracted from the verified session
  token — a user cannot read or modify another user's items or settings.
