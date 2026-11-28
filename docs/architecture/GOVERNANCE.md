# ValuePort Architecture Governance & Progress Map

> Maintained continuously during architectural entropy reduction.
> Branch / Worktree: isolated Orca worktree (`menhaden`), base commit `d8b1e18`.

## 1. Baseline Snapshot (2026-11-28)

- **Test baseline**: `npm test` — 63 test files, 642 tests passing (`core` + `worker`); `memory_monitor` Python unittest — 8 tests passing.
- **Total source footprint** (`src/` + `public/`): 26,726 lines across JS/HTML (plus 523 lines in `public/shared/styles.css`).
- **Circular dependencies**: 0 (baseline clean; will be locked via automated test).
- **God files identified**:
  - `public/index.html` — 4,147 lines (1,462 CSS + 2,492 JS inline)
  - `public/portfolio.html` — 2,938 lines (460 CSS + 2,391 JS inline)
  - `public/shared/valuation-ui.js` — 1,948 lines
  - `src/ai.js` — 1,184 lines (7 AI endpoints + model CRUD + provider adapters + quota)
  - `public/shared/valuation/thesis-guide-ui.js` — 944 lines
  - `public/shared/rebalance.js` — 881 lines
  - `public/macro.html` — 838 lines (159 CSS + 590 JS inline)
  - `public/shared/ai-panel.js` (722 lines) + `public/shared/global-ai.js` (594 lines)
  - `src/portfolio.js` — 642 lines
  - `src/official-management-research.js` — 574 lines
  - `public/shared/alert-banner.js` — 573 lines
  - `public/admin.html` — 535 lines (**dead legacy single-user page calling deleted `/api/admin/*` endpoints**)
  - `src/index.js` — 440 lines (public market proxy + auth + user CRUD + owner admin + SPA routing)

## 2. Target Layered Architecture

```
public/*.html                 Thin semantic shells + modulepreload manifest
public/shared/*.css           Design system (styles.css) + page stylesheets
public/shared/dom.js          Canonical DOM, icon (ri), escape, logo & number helpers
public/shared/storage-keys.js Canonical localStorage/sessionStorage key registry
public/shared/valuation/*     Pure domain logic (shared with Worker) + focused UI modules
public/shared/board/*         Watchlist & stock detail page modules
public/shared/portfolio/*     Portfolio page modules
public/shared/ai-drawer.js    Shared AI drawer primitives (model picker, error text, copy, markdown-lite)
---------------------------------------------------------------------------------
src/index.js                  Thin Worker composition root + error handler + cron
src/routes/*                  HTTP route registrars (market, account/board, owner)
src/ai/*                      Cohesive AI subsystem (provider, shared, valuation, method, thesis, review-brief, portfolio-query)
src/portfolio/*               Cohesive portfolio subsystem (storage, fx, accounts, routes)
src/brokers/*                 Broker adapters + shared broker primitives (common.js)
src/lib/*                     Canonical server utilities (edge cache, UTC date, etc.)
```

### Dependency Direction Rules
1. `public/shared/` MUST NEVER import from `src/`.
2. `src/` MAY import ONLY pure, DOM-free domain modules from `public/shared/` (e.g. `valuation/*.js` non-UI files, `feedback-core.js`, `macro-board.js`, `metric-spark.js`, `pf-query.js`).
3. Zero circular dependencies across all JS modules.
4. No duplicate implementations of canonical primitives (`ri`, `el`, `b64ToBytes`, `normCur`, `authError`, `hasLongbridgeCreds`, edge cache helpers).

## 3. State Ownership Map

| State / Storage | Owner | Scope | Notes |
|---|---|---|---|
| D1 `users`, `items`, `settings`, `activation_codes` | Worker (`src/routes/account.js`, `src/routes/owner.js`) | Server persistent | Scoped strictly by verified `uid` |
| D1 `broker_accounts`, `holdings`, `cash_balances`, `portfolio_snapshots`, `portfolio_plans` | `src/portfolio-storage.js` + `src/portfolio.js` | Server persistent (AES-256-GCM) | Fail-closed HTTP 503 on crypto error |
| D1 `ai_models`, `ai_chats`, `usage_daily` | `src/ai/*`, `src/ai-chats.js`, `src/usage.js` | Server persistent | Custom AI keys AES-256-GCM encrypted |
| D1 `macro_series`, `macro_meta`, `management_research_*`, `business_report_snapshots` | `src/macro.js`, `src/management-research-store.js`, `src/business-report.js` | Server public cache | Shared across users, no user PII |
| Cookies `pendulum_user`, `pendulum_owner` | `src/auth.js` | Stateless HMAC-SHA256 | `HttpOnly; Secure; SameSite=Strict` |
| `localStorage` (`pendulum_lang`, `pf_base`, `pf_hide`, `macro_last_visit`, macro prefs, per-symbol FP) | `public/shared/storage-keys.js` + `navboot.js` | Client preferences | Synced across tabs |
| `sessionStorage` (`owner_slug`, `pf_user`, `board_cache_*`, `pf_cache_*`, `fb_cap`, `gai_cap`, `gai_open`, `gai_chat_*`, `ai_pick_*`) | `public/shared/storage-keys.js` + `navboot.js` | Tab session cache | Cleared on logout |

## 4. Environment Variable Ownership Map

| Env / Secret | Canonical Owner | Consumers |
|---|---|---|
| `DB` | Cloudflare D1 binding | All persistence modules |
| `ASSETS` | Cloudflare static assets | `src/index.js` |
| `SESSION_SECRET`, `ADMIN_PASSWORD` | Auth / Owner routes | `src/routes/account.js`, `src/routes/owner.js` |
| `CREDENTIALS_KEY` | `src/crypto.js` | `src/portfolio*.js`, `src/ai/*`, `src/jev.js` |
| `LONGBRIDGE_APP_KEY/SECRET/ACCESS_TOKEN` | `src/longbridge.js` (`hasLongbridgeCreds`) | Market routes, research, management research |
| `AI`, `AI_PROVIDER`, `AI_MODEL`, `AI_BASE_URL`, `AI_API_KEY`, `ZHIPU_API_KEY` | `src/ai/provider.js` | AI routes |
| `TAVILY_API_KEY` | `src/web-search.js` | `src/ai/*`, `src/official-management-research.js` |
| `FINNHUB_API_KEY` | `src/finnhub.js` | Market financials route |
| `SEC_USER_AGENT` | `src/official-management-research.js` | SEC EDGAR fallback |
| `GITHUB_TOKEN`, `FEEDBACK_REPO` | `src/feedback.js` | Feedback route |

## 5. Governance Task Pool & Progress Log

- [x] **Batch 1**: Delete dead `public/admin.html` and obsolete admin-only CSS rules
- [x] **Batch 2**: Unify backend crypto (`b64ToBytes`), broker (`normCur`, `authError`), and Longbridge (`hasLongbridgeCreds`, `signedGet` reuse in `getOtp`) primitives
- [x] **Batch 3**: Unify backend edge-cache & UTC-date utilities (`src/lib/runtime.js`) across research, business-report, usage, feedback, ai, portfolio
- [x] **Batch 4**: Decompose `src/ai.js` (1,184 lines) into cohesive `src/ai/*` modules
- [x] **Batch 5**: Decompose `src/index.js` (440 lines) into focused route registrars (`src/routes/*`)
- [x] **Batch 6**: Decompose `src/portfolio.js` (642 lines) into cohesive submodules
- [x] **Batch 7**: Create canonical `public/shared/dom.js` and `public/shared/storage-keys.js`; migrate all frontend callers
- [x] **Batch 8**: Extract shared AI drawer utilities between `public/shared/ai-panel.js` and `public/shared/global-ai.js`
- [ ] **Batch 9**: Extract `public/macro.html` inline CSS/JS into `public/shared/macro-page.css` and `public/shared/macro-page.js`
- [ ] **Batch 10**: Extract & modularize `public/portfolio.html` inline CSS/JS into `public/shared/portfolio-page.css` and `public/shared/portfolio/*`
- [ ] **Batch 11**: Extract & modularize `public/index.html` inline CSS/JS into `public/shared/board-page.css` and `public/shared/board/*`
- [ ] **Batch 12**: Decompose `public/shared/valuation-ui.js` (1,948 lines) into cohesive submodules
- [ ] **Batch 13**: Add automated architecture fitness test suite (`test-core/architecture.test.js`) + verify CI coverage

## 6. Deferred / Needs Product Confirmation

*(None yet — items requiring breaking API/data changes or product decisions will be recorded here.)*
