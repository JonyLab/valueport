# Memory Supply-Demand Monitor

This Python subsystem implements the first collectors from the PRD:

- DRAM spot-price collection through Playwright.
- TWSE monthly revenue collection through the official OpenAPI endpoint.
- PostgreSQL schema initialization and writes.

## Setup

```bash
cd memory_monitor
python3.10 -m venv .venv
. .venv/bin/activate
pip install -e .
playwright install chromium
cp .env.example .env
```

Set `DATABASE_URL` in `.env` or export it in the shell.

`MEMORY_CONTRACT_PRICES_JSON` is optional. When present, spot-price rows include
`contract_price` and `price_spread`:

```json
{"DDR5_16Gb_5600":"3.90","DDR5_16Gb_4800":"3.70","DDR4_8Gb":"1.60"}
```

## Commands

```bash
memory-monitor-init-db
memory-monitor-twse-revenue
MEMORY_SPOT_URL="https://example.com/price-board" memory-monitor-spot-prices
memory-monitor-demo
memory-monitor-scheduler
```

Revenue collection defaults to the TWSE listed-company endpoint plus the TPEx
OTC-company endpoint so the PRD targets are covered:

- `2330`, `2408`, `6239`: TWSE `t187ap05_L`
- `3260`: TPEx `mopsfin_t187ap05_O`

The scheduler uses Asia/Shanghai time:

- Spot prices: daily at 11:30 and 17:30.
- TWSE revenue: every two hours from the 5th through the 10th day of each month.

## Tests

The unit tests avoid optional production dependencies:

```bash
PYTHONPATH=memory_monitor python3 -m unittest discover -s memory_monitor/tests
```
