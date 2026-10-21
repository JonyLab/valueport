import logging
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Optional

from memory_monitor.config import MonitorConfig
from memory_monitor.db import connect, insert_spot_prices
from memory_monitor.logging_config import setup_logging


LOGGER = logging.getLogger(__name__)

PRODUCT_MATCHERS = {
    "DDR5_16Gb_5600": ("DDR5", "16Gb", "5600"),
    "DDR5_16Gb_4800": ("DDR5", "16Gb", "4800"),
    "DDR4_8Gb": ("DDR4", "8Gb"),
}


@dataclass(frozen=True)
class SpotPriceRecord:
    product_type: str
    spot_avg_price: Decimal
    contract_price: Optional[Decimal] = None

    @property
    def price_spread(self) -> Optional[Decimal]:
        if self.contract_price is None:
            return None
        return self.spot_avg_price - self.contract_price


def _parse_decimal(value: str) -> Optional[Decimal]:
    try:
        return Decimal(value).quantize(Decimal("0.0001"))
    except InvalidOperation:
        return None


def parse_spot_prices(page_text: str) -> dict[str, Decimal]:
    prices: dict[str, Decimal] = {}
    lines = [line.strip() for line in page_text.splitlines() if line.strip()]
    for product_type, tokens in PRODUCT_MATCHERS.items():
        matched_line = next(
            (line for line in lines if all(token.lower() in line.lower() for token in tokens)),
            "",
        )
        if not matched_line:
            LOGGER.warning("spot product not found in page text: product_type=%s", product_type)
            continue
        numbers = re.findall(r"\d+\.\d+", matched_line)
        if not numbers:
            LOGGER.warning("spot product found without numeric price: product_type=%s", product_type)
            continue
        avg_price = _parse_decimal(numbers[-1])
        if avg_price is None:
            LOGGER.warning("spot product has invalid avg price: product_type=%s value=%s", product_type, numbers[-1])
            continue
        prices[product_type] = avg_price
    return prices


def spot_records_from_text(
    page_text: str,
    contract_prices: Optional[dict[str, Decimal]] = None,
) -> list[SpotPriceRecord]:
    prices = parse_spot_prices(page_text)
    contracts = contract_prices or {}
    return [
        SpotPriceRecord(
            product_type=key,
            spot_avg_price=value,
            contract_price=contracts.get(key),
        )
        for key, value in prices.items()
    ]


def fetch_spot_price_page_text(config: MonitorConfig) -> str:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=config.headless)
        try:
            page = browser.new_page()
            page.goto(config.spot_url, wait_until="networkidle", timeout=config.playwright_timeout_ms)
            return page.locator("body").inner_text(timeout=config.playwright_timeout_ms)
        finally:
            browser.close()


def collect_spot_prices(config: MonitorConfig) -> int:
    LOGGER.info("fetch spot price page: url=%s", config.spot_url)
    text = fetch_spot_price_page_text(config)
    records = spot_records_from_text(text, config.contract_prices)
    LOGGER.info("parsed spot price records: count=%s", len(records))
    with connect(config.require_database_url()) as conn:
        written = insert_spot_prices(conn, records)
    LOGGER.info("wrote spot price records: count=%s", written)
    return written


def main() -> None:
    config = MonitorConfig.from_env()
    setup_logging(config.log_level)
    try:
        collect_spot_prices(config)
    except Exception:
        LOGGER.exception("spot price collection failed")
        raise


if __name__ == "__main__":
    main()
