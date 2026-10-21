import unittest
from decimal import Decimal

from memory_monitor.demo import render_dashboard


class DemoRenderTests(unittest.TestCase):
    def test_render_dashboard_contains_core_kpis(self):
        html = render_dashboard(
            spot_rows=[
                {
                    "product_type": "DDR5_16Gb_5600",
                    "spot_avg_price": Decimal("4.1200"),
                    "contract_price": Decimal("3.9000"),
                    "price_spread": Decimal("0.2200"),
                    "crawl_date": "2026-06-26 17:26",
                }
            ],
            revenue_rows=[
                {
                    "report_month": "2026-05",
                    "company_code": "3260",
                    "company_name": "威剛",
                    "current_month_revenue": Decimal("12942597.00"),
                    "mom_growth": Decimal("0.2261"),
                    "yoy_growth": Decimal("2.1044"),
                },
                {
                    "report_month": "2026-05",
                    "company_code": "2330",
                    "company_name": "台積電",
                    "current_month_revenue": Decimal("416975163.00"),
                    "mom_growth": Decimal("0.0152"),
                    "yoy_growth": Decimal("0.3009"),
                }
            ],
            generated_at="2026-06-26 17:30",
        )

        self.assertIn("Memory Supply-Demand Monitor", html)
        self.assertIn("DDR5 Spot Premium", html)
        self.assertIn("5.64%", html)
        self.assertIn("威剛", html)
        self.assertIn("22.61%", html)
        self.assertIn("Market View", html)
        self.assertIn("需求修复", html)
        self.assertIn("需求改善需要价格确认", html)
        self.assertIn("Spot-Contract Spread", html)
        self.assertIn("Revenue MoM Pulse", html)
        self.assertIn("Spot Price Trend", html)
        self.assertIn("Revenue MoM Trend", html)
        self.assertIn("MoM 15% threshold", html)
        self.assertIn("The Cycle Clock", html)
        self.assertIn("结构性牛市", html)
        self.assertIn("Data Sufficiency", html)
        self.assertIn("现货趋势样本不足", html)
        pulse_html = html[html.index("Revenue MoM Pulse") :]
        self.assertLess(pulse_html.index("3260 威剛"), pulse_html.index("2330 台積電"))


if __name__ == "__main__":
    unittest.main()
