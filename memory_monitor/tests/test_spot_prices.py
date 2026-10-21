import unittest
from decimal import Decimal

from memory_monitor.supply.spot_prices import parse_spot_prices
from memory_monitor.supply.spot_prices import spot_records_from_text


class SpotPriceParserTests(unittest.TestCase):
    def test_parse_spot_prices_extracts_configured_products(self):
        page_text = """
        DRAM Spot Price
        DDR5 16Gb (2Gx8) 5600 4.180 4.080 4.120
        DDR5 16Gb (2Gx8) 4800 3.910 3.820 3.860
        DDR4 8Gb 1Gx8 3200 1.780 1.700 1.740
        """

        prices = parse_spot_prices(page_text)

        self.assertEqual(prices["DDR5_16Gb_5600"], Decimal("4.1200"))
        self.assertEqual(prices["DDR5_16Gb_4800"], Decimal("3.8600"))
        self.assertEqual(prices["DDR4_8Gb"], Decimal("1.7400"))

    def test_spot_records_apply_contract_prices_and_spreads(self):
        page_text = """
        DDR5 16Gb (2Gx8) 5600 4.180 4.080 4.120
        DDR5 16Gb (2Gx8) 4800 3.910 3.820 3.860
        DDR4 8Gb 1Gx8 3200 1.780 1.700 1.740
        """

        records = spot_records_from_text(page_text, {"DDR5_16Gb_5600": Decimal("3.9000")})

        self.assertEqual(records[0].contract_price, Decimal("3.9000"))
        self.assertEqual(records[0].price_spread, Decimal("0.2200"))


if __name__ == "__main__":
    unittest.main()
