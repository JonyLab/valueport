import logging
import time
from datetime import datetime

from memory_monitor.config import MonitorConfig
from memory_monitor.demand.twse_revenue import collect_twse_revenue
from memory_monitor.logging_config import setup_logging
from memory_monitor.supply.spot_prices import collect_spot_prices


LOGGER = logging.getLogger(__name__)


def is_twse_revenue_poll_window(now: datetime) -> bool:
    return 5 <= now.day <= 10 and now.hour % 2 == 0


def guarded_job(name: str, func, config: MonitorConfig) -> None:
    try:
        LOGGER.info("start scheduled job: name=%s", name)
        func(config)
        LOGGER.info("finish scheduled job: name=%s", name)
    except Exception:
        LOGGER.exception("scheduled job failed: name=%s", name)


def guarded_twse_window_job(config: MonitorConfig) -> None:
    now = datetime.now()
    if not is_twse_revenue_poll_window(now):
        LOGGER.debug("skip TWSE revenue job outside polling window: now=%s", now.isoformat())
        return
    guarded_job("twse-revenue", collect_twse_revenue, config)


def run_scheduler(config: MonitorConfig) -> None:
    from apscheduler.schedulers.background import BackgroundScheduler
    from apscheduler.triggers.cron import CronTrigger

    scheduler = BackgroundScheduler(timezone="Asia/Shanghai")
    scheduler.add_job(
        guarded_job,
        CronTrigger(hour="11,17", minute=30),
        args=["spot-prices", collect_spot_prices, config],
        id="spot-prices",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    scheduler.add_job(
        guarded_twse_window_job,
        CronTrigger(hour="*/2", minute=0),
        args=[config],
        id="twse-revenue-window",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    scheduler.start()
    LOGGER.info("scheduler started: timezone=Asia/Shanghai jobs=%s", len(scheduler.get_jobs()))
    try:
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        LOGGER.info("scheduler stopping")
        scheduler.shutdown()


def main() -> None:
    config = MonitorConfig.from_env()
    setup_logging(config.log_level)
    run_scheduler(config)


if __name__ == "__main__":
    main()
