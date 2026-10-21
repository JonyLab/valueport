# Memory Monitor Aggregators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add executable Python collectors for DRAM spot prices and TWSE monthly revenue, with PostgreSQL writes and tests.

**Architecture:** Create an isolated `memory_monitor/` Python package inside the existing repo. Parser functions are pure and unit-tested; browser, HTTP, and database side effects live at command boundaries.

**Tech Stack:** Python 3.10+, Playwright, requests, psycopg, PostgreSQL, unittest.

---

### Task 1: Package Skeleton And Schema

**Files:**
- Create: `memory_monitor/pyproject.toml`
- Create: `memory_monitor/README.md`
- Create: `memory_monitor/.env.example`
- Create: `memory_monitor/sql/schema.sql`
- Create: `memory_monitor/memory_monitor/__init__.py`

- [x] Define package metadata, dependencies, console scripts, PRD schema, and environment documentation.

### Task 2: TWSE Revenue Collector

**Files:**
- Create: `memory_monitor/tests/test_twse_revenue.py`
- Create: `memory_monitor/memory_monitor/demand/twse_revenue.py`

- [x] Write failing tests for ROC month parsing, number parsing, percent parsing, and company filtering.
- [x] Implement parser and fetch command.
- [x] Run `python3 -m unittest discover -s memory_monitor/tests`.

### Task 3: Spot Price Collector

**Files:**
- Create: `memory_monitor/tests/test_spot_prices.py`
- Create: `memory_monitor/memory_monitor/supply/spot_prices.py`

- [x] Write failing tests for extracting DDR5 and DDR4 average prices from representative page text.
- [x] Implement Playwright-backed collection and pure text parsing.
- [x] Run `python3 -m unittest discover -s memory_monitor/tests`.

### Task 4: Shared Config, Logging, And Database Writes

**Files:**
- Create: `memory_monitor/memory_monitor/config.py`
- Create: `memory_monitor/memory_monitor/db.py`
- Create: `memory_monitor/memory_monitor/logging_config.py`

- [x] Implement environment config, logging setup, PostgreSQL connection helpers, schema initializer, and insert/upsert functions.
- [x] Keep optional dependencies imported at runtime boundaries.
- [x] Run unit tests and Python compilation.

### Task 5: Contract Prices And Scheduler

**Files:**
- Modify: `memory_monitor/memory_monitor/config.py`
- Modify: `memory_monitor/memory_monitor/supply/spot_prices.py`
- Create: `memory_monitor/memory_monitor/scheduler.py`
- Modify: `memory_monitor/pyproject.toml`
- Modify: `memory_monitor/README.md`
- Test: `memory_monitor/tests/test_spot_prices.py`
- Test: `memory_monitor/tests/test_scheduler.py`

- [x] Add contract-price JSON parsing and spread calculation.
- [x] Add an APScheduler entrypoint for PRD collection windows.
- [x] Run unit tests and Python compilation.
