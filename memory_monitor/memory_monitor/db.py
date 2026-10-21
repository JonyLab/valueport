from pathlib import Path
from typing import Iterable

from .config import MonitorConfig
from .logging_config import setup_logging


SCHEMA_PATH = Path(__file__).resolve().parents[1] / "sql" / "schema.sql"


def connect(database_url: str):
    import psycopg

    return psycopg.connect(database_url)


def initialize_schema(conn) -> None:
    conn.execute(SCHEMA_PATH.read_text(encoding="utf-8"))
    conn.commit()


def insert_spot_prices(conn, records: Iterable) -> int:
    rows = list(records)
    if not rows:
        return 0
    with conn.cursor() as cur:
        for row in rows:
            cur.execute(
                """
                INSERT INTO memory_spot_prices
                    (product_type, spot_avg_price, contract_price, price_spread)
                VALUES (%s, %s, %s, %s)
                """,
                (
                    row.product_type,
                    row.spot_avg_price,
                    row.contract_price,
                    row.price_spread,
                ),
            )
    conn.commit()
    return len(rows)


def upsert_revenue_rows(conn, records: Iterable) -> int:
    rows = list(records)
    if not rows:
        return 0
    with conn.cursor() as cur:
        for row in rows:
            cur.execute(
                """
                INSERT INTO taiwan_supply_chain_revenue
                    (report_month, company_code, company_name, current_month_revenue, mom_growth, yoy_growth)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (report_month, company_code)
                DO UPDATE SET
                    company_name = EXCLUDED.company_name,
                    current_month_revenue = EXCLUDED.current_month_revenue,
                    mom_growth = EXCLUDED.mom_growth,
                    yoy_growth = EXCLUDED.yoy_growth,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (
                    row.report_month,
                    row.company_code,
                    row.company_name,
                    row.current_month_revenue,
                    row.mom_growth,
                    row.yoy_growth,
                ),
            )
    conn.commit()
    return len(rows)


def main() -> None:
    config = MonitorConfig.from_env()
    setup_logging(config.log_level)
    with connect(config.require_database_url()) as conn:
        initialize_schema(conn)


if __name__ == "__main__":
    main()
