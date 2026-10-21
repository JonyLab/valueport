# Memory Monitor Aggregators Design

## Scope

Build the first executable slice of the Memory Supply-Demand Monitor as an isolated Python subsystem under `memory_monitor/`. This slice covers:

- Module 1 Requirement 1: daily DRAM spot-price collection with Playwright.
- Module 2: TWSE monthly revenue collection through the official OpenAPI endpoint.
- PostgreSQL schema and write paths for the PRD tables touched by those collectors.

The existing Cloudflare Worker watchlist remains unchanged.

## Architecture

The subsystem is a small Python package with explicit command modules. Collectors parse raw upstream data into typed records, then hand records to a PostgreSQL repository. Network/browser dependencies are optional until the relevant command runs, which keeps parsing tests lightweight.

Configuration comes from environment variables. `DATABASE_URL` is required for database writes. Supply-side browser settings use `MEMORY_SPOT_URL`, `MEMORY_HEADLESS`, and `MEMORY_PLAYWRIGHT_TIMEOUT_MS`. The revenue collector defaults to the TWSE listed-company endpoint `https://openapi.twse.com.tw/v1/opendata/t187ap05_L` plus the TPEx OTC-company endpoint `https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O`, because the PRD’s original `t187ap05_P` endpoint currently does not include the target company codes.

Contract-price baselines are supplied through `MEMORY_CONTRACT_PRICES_JSON`. When a product has a configured contract price, the spot collector writes both `contract_price` and `price_spread`.

## Data Flow

Spot-price command:

1. Launch Chromium through Playwright.
2. Open the configured price-board URL.
3. Extract visible text from the page.
4. Match configured DRAM product labels and parse average prices.
5. Insert rows into `memory_spot_prices`.

TWSE revenue command:

1. Fetch JSON from the official TWSE OpenAPI endpoint.
2. Keep only 2408, 3260, 6239, and 2330.
3. Convert ROC `資料年月` values to `YYYY-MM`.
4. Convert reported percentage values into decimal rates.
5. Upsert rows into `taiwan_supply_chain_revenue`.

## Error Handling And Logging

Collectors log source URLs, matched record counts, skipped records, and write counts. Network, browser, and database errors are logged with stack traces and cause non-zero CLI exits. Parsers tolerate missing fields by skipping incomplete records instead of inventing data.

The optional scheduler entrypoint runs in Asia/Shanghai time. It schedules spot prices at 11:30 and 17:30 daily and gates TWSE polling to every two hours between each month’s 5th and 10th days.

## Testing

Use standard-library `unittest` so the parsing suite runs even before optional production dependencies are installed. Tests cover:

- TWSE report-month normalization.
- Numeric and percent parsing.
- TWSE target-company filtering.
- Spot-price extraction from representative page text.
- Contract-price spread calculation.
- TWSE scheduler polling-window logic.

Integration with real PostgreSQL and Playwright is configured through environment variables and documented, but not required for the lightweight unit suite.
