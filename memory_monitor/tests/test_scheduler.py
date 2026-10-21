from datetime import datetime
import unittest

from memory_monitor.scheduler import is_twse_revenue_poll_window


class SchedulerTests(unittest.TestCase):
    def test_twse_revenue_poll_window_is_monthly_5_to_10_every_two_hours(self):
        self.assertTrue(is_twse_revenue_poll_window(datetime(2026, 6, 5, 0, 0)))
        self.assertTrue(is_twse_revenue_poll_window(datetime(2026, 6, 10, 22, 30)))
        self.assertFalse(is_twse_revenue_poll_window(datetime(2026, 6, 4, 22, 0)))
        self.assertFalse(is_twse_revenue_poll_window(datetime(2026, 6, 11, 0, 0)))
        self.assertFalse(is_twse_revenue_poll_window(datetime(2026, 6, 7, 13, 0)))


if __name__ == "__main__":
    unittest.main()
