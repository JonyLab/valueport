# 估值钟摆 · 看板 (Valuation Pendulum Watchlist)

## Overview

A Cloudflare Worker that serves a public read-only valuation-pendulum board at `/` and a
password-protected configuration backend at `/admin`. Watchlist items (tickers, fair-value
bands, margin-of-safety thresholds) are persisted in a Cloudflare D1 SQLite database. Live
stock quotes and search hints are proxied server-side from Tencent Finance
(`qt.gtimg.cn` / `smartbox.gtimg.cn`), so the browser never makes cross-origin requests.
A single `ADMIN_PASSWORD` secret gates the admin panel; sessions are stateless HMAC-signed
cookies (`SESSION_SECRET`).

## Architecture

```
Cloudflare Worker (src/index.js)  — Hono router
│
├── src/auth.js        HMAC-SHA-256 stateless session tokens (sign / verify)
├── src/items.js       Watchlist item validation and DB-row ↔ camelCase mapping
├── src/quotes.js      Tencent Finance GBK response parsers (quotes + hints)
│
├── public/index.html  Public read-only pendulum board
├── public/admin.html  Password-protected config UI (CRUD)
└── public/shared/
    ├── core.js        Pure business logic ESM module (pendulum math, no DOM)
    ├── gauge.js       Canvas/SVG gauge renderer
    ├── market.js      Market-hours helper
    └── styles.css     Shared stylesheet

D1 database (binding: DB)
└── items table — ticker, name, symbol, fair_low, fair_high, mos, ext, sort_order, updated_at
```

### Test workspace (`vitest.workspace.js`)

| Project   | Runner                          | Covers                          |
|-----------|---------------------------------|---------------------------------|
| `core`    | Node (vitest default)           | `test-core/core.test.js` — pure logic |
| `worker`  | `@cloudflare/vitest-pool-workers` | `src/*.test.js` — auth, items, quotes, routes |

## Local Development

### Prerequisites

- Node.js 18+ and npm
- No Cloudflare account needed for local dev

### Setup

```bash
npm install
```

Create `.dev.vars` in the project root (this file is gitignored):

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
- http://localhost:8787/ — public pendulum board
- http://localhost:8787/admin — config backend (login with `dev-pass`)

### Tests

```bash
npm test          # runs all 40 vitest tests (no network, no Cloudflare account)
```

## Deployment

The steps below require a Cloudflare account and `wrangler login` (run once in your terminal).
You only need to do this — do not run these commands locally in this repo without an account.

```bash
# 1. Create the D1 database and note the database_id in the output
npx wrangler d1 create pendulum-db

# 2. Copy the database_id printed above into wrangler.toml:
#    database_id = "<the-id-from-step-1>"
#    (replace the PLACEHOLDER_RUN_d1_create_TO_FILL value)

# 3. Apply the schema to the remote database
npx wrangler d1 execute pendulum-db --remote --file=./schema.sql

# 4. Set secrets (you will be prompted to enter values)
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET

# 5. Deploy
npm run deploy
```

> **Note:** `wrangler.toml` ships with `database_id = "PLACEHOLDER_RUN_d1_create_TO_FILL"`.
> You must replace this with the real ID returned by `d1 create` before deploying.

## API Reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/config` | Public | Returns all watchlist items as JSON |
| GET | `/api/quotes?symbols=usAAPL,usGOOGL` | Public | Live prices proxied from Tencent |
| GET | `/api/hints?q=apple` | Public | Search hints proxied from Tencent |
| POST | `/api/login` | — | `{"password":"…"}` → sets session cookie |
| POST | `/api/logout` | Cookie | Clears session cookie |
| GET | `/api/admin/items` | Cookie | List all items (admin) |
| POST | `/api/admin/items` | Cookie | Create item |
| PUT | `/api/admin/items/:id` | Cookie | Update item |
| DELETE | `/api/admin/items/:id` | Cookie | Delete item |

Any unmatched `/api/*` path returns a JSON 404. All other paths are served from the `public/`
static-asset directory via the `ASSETS` binding.

## Notes

- `compatibility_flags = ["nodejs_compat"]` is required (already set in `wrangler.toml`) for
  the `TextDecoder("gbk")` used in GBK-encoded Tencent Finance responses.
- Quote and hint endpoints are proxied server-side to avoid browser CORS restrictions and
  JSONP dependencies — the browser only calls same-origin `/api/*` routes.
- Sessions are stateless: the worker holds no state beyond D1. Rotating `SESSION_SECRET`
  invalidates all existing sessions immediately.
