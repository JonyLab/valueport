import logging
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Iterable, Mapping, Optional

from memory_monitor.config import MonitorConfig
from memory_monitor.db import connect, upsert_revenue_rows
from memory_monitor.logging_config import setup_logging


LOGGER = logging.getLogger(__name__)

TARGET_COMPANIES = {
    "2408": "南亚科",
    "3260": "威刚",
    "6239": "力成",
    "2330": "台积电",
}


@dataclass(frozen=True)
class RevenueRecord:
    report_month: str
    company_code: str
    company_name: str
    current_month_revenue: Decimal
    mom_growth: Optional[Decimal]
    yoy_growth: Optional[Decimal]


def parse_report_month(value: str) -> str:
    raw = (value or "").strip()
    if re.fullmatch(r"\d{4}-\d{2}", raw):
        return raw
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 5:
        year = int(digits[:3]) + 1911
        month = int(digits[3:])
    elif len(digits) == 6:
        year = int(digits[:4])
        month = int(digits[4:])
    else:
        raise ValueError(f"unsupported report month: {value!r}")
    if not 1 <= month <= 12:
        raise ValueError(f"unsupported report month: {value!r}")
    return f"{year:04d}-{month:02d}"


def parse_number(value: object) -> Optional[Decimal]:
    raw = str(value or "").strip().replace(",", "")
    if raw in {"", "--", "-", "不適用", "不适用", "NA", "N/A"}:
        return None
    try:
        return Decimal(raw)
    except InvalidOperation:
        return None


def parse_growth_percent(value: object) -> Optional[Decimal]:
    raw = str(value or "").strip().replace("%", "")
    parsed = parse_number(raw)
    if parsed is None:
        return None
    return (parsed / Decimal("100")).quantize(Decimal("0.0001"))


def _first_present(row: Mapping[str, object], keys: Iterable[str]) -> object:
    for key in keys:
        if key in row and row[key] not in (None, ""):
            return row[key]
    return ""


def parse_twse_revenue_rows(rows: Iterable[Mapping[str, object]]) -> list[RevenueRecord]:
    records: list[RevenueRecord] = []
    for row in rows:
        code = str(_first_present(row, ["公司代號", "公司代码", "company_code", "CompanyCode"])).strip()
        if code not in TARGET_COMPANIES:
            continue
        revenue = parse_number(
            _first_present(row, ["營業收入-當月營收", "营业收入-当月营收", "current_month_revenue"])
        )
        if revenue is None:
            LOGGER.warning("skip TWSE row with missing revenue: company_code=%s", code)
            continue
        try:
            report_month = parse_report_month(str(_first_present(row, ["資料年月", "资料年月", "report_month"])))
        except ValueError:
            LOGGER.warning("skip TWSE row with unsupported report month: company_code=%s", code)
            continue
        company_name = str(
            _first_present(row, ["公司名稱", "公司名称", "company_name"]) or TARGET_COMPANIES[code]
        ).strip()
        records.append(
            RevenueRecord(
                report_month=report_month,
                company_code=code,
                company_name=company_name,
                current_month_revenue=revenue,
                mom_growth=parse_growth_percent(
                    _first_present(row, ["營業收入-上月比較增減(%)", "营业收入-上月比较增减(%)", "mom_growth"])
                ),
                yoy_growth=parse_growth_percent(
                    _first_present(row, ["營業收入-去年同月增減(%)", "营业收入-去年同月增减(%)", "yoy_growth"])
                ),
            )
        )
    return records


def fetch_twse_revenue_rows(url: str) -> list[Mapping[str, object]]:
    import requests

    response = requests.get(url, timeout=30)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list):
        raise ValueError("TWSE response must be a JSON array")
    return payload


def collect_twse_revenue(config: MonitorConfig) -> int:
    rows = []
    for url in config.twse_revenue_urls:
        LOGGER.info("fetch revenue rows: url=%s", url)
        rows.extend(fetch_twse_revenue_rows(url))
    records = parse_twse_revenue_rows(rows)
    LOGGER.info("parsed TWSE target revenue records: count=%s", len(records))
    with connect(config.require_database_url()) as conn:
        written = upsert_revenue_rows(conn, records)
    LOGGER.info("wrote TWSE revenue records: count=%s", written)
    return written


def main() -> None:
    config = MonitorConfig.from_env()
    setup_logging(config.log_level)
    try:
        collect_twse_revenue(config)
    except Exception:
        LOGGER.exception("TWSE revenue collection failed")
        raise


if __name__ == "__main__":
    main()
