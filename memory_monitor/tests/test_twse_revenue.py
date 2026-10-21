import unittest
from decimal import Decimal

from memory_monitor.demand.twse_revenue import (
    parse_growth_percent,
    parse_number,
    parse_report_month,
    parse_twse_revenue_rows,
)


class TwseRevenueParserTests(unittest.TestCase):
    def test_parse_report_month_accepts_roc_and_gregorian_values(self):
        self.assertEqual(parse_report_month("11506"), "2026-06")
        self.assertEqual(parse_report_month("202606"), "2026-06")
        self.assertEqual(parse_report_month("2026-06"), "2026-06")

    def test_parse_number_removes_commas_and_blank_markers(self):
        self.assertEqual(parse_number("1,234,567"), Decimal("1234567"))
        self.assertIsNone(parse_number(""))
        self.assertIsNone(parse_number("--"))

    def test_parse_growth_percent_stores_decimal_rate(self):
        self.assertEqual(parse_growth_percent("15.25"), Decimal("0.1525"))
        self.assertEqual(parse_growth_percent("-3.1%"), Decimal("-0.0310"))
        self.assertIsNone(parse_growth_percent("不適用"))

    def test_parse_twse_revenue_rows_filters_target_companies(self):
        rows = [
            {
                "資料年月": "11506",
                "公司代號": "3260",
                "公司名稱": "威剛",
                "營業收入-當月營收": "4,200,000",
                "營業收入-上月比較增減(%)": "16.2",
                "營業收入-去年同月增減(%)": "22.5",
            },
            {
                "資料年月": "11506",
                "公司代號": "9999",
                "公司名稱": "非目標",
                "營業收入-當月營收": "1",
                "營業收入-上月比較增減(%)": "1",
                "營業收入-去年同月增減(%)": "1",
            },
        ]

        parsed = parse_twse_revenue_rows(rows)

        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0].report_month, "2026-06")
        self.assertEqual(parsed[0].company_code, "3260")
        self.assertEqual(parsed[0].current_month_revenue, Decimal("4200000"))
        self.assertEqual(parsed[0].mom_growth, Decimal("0.1620"))


if __name__ == "__main__":
    unittest.main()
