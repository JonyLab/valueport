import os
import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Optional


DEFAULT_TWSE_REVENUE_URLS = [
    "https://openapi.twse.com.tw/v1/opendata/t187ap05_L",
    "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O",
]


def load_env_file(path: Optional[Path] = None) -> None:
    env_path = path or Path.cwd() / ".env"
    if not env_path.exists():
        package_env = Path(__file__).resolve().parents[1] / ".env"
        env_path = package_env if package_env.exists() else env_path
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _bool_from_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


@dataclass(frozen=True)
class MonitorConfig:
    database_url: str
    spot_url: str
    twse_revenue_urls: list[str]
    headless: bool
    playwright_timeout_ms: int
    log_level: str
    contract_prices: dict[str, Decimal]

    @classmethod
    def from_env(cls) -> "MonitorConfig":
        load_env_file()
        return cls(
            database_url=os.environ.get("DATABASE_URL", ""),
            spot_url=os.environ.get("MEMORY_SPOT_URL", "https://www.dramexchange.com/"),
            twse_revenue_urls=parse_url_list(
                os.environ.get("TWSE_REVENUE_URLS")
                or os.environ.get("TWSE_REVENUE_URL")
                or ",".join(DEFAULT_TWSE_REVENUE_URLS)
            ),
            headless=_bool_from_env("MEMORY_HEADLESS", True),
            playwright_timeout_ms=int(os.environ.get("MEMORY_PLAYWRIGHT_TIMEOUT_MS", "45000")),
            log_level=os.environ.get("LOG_LEVEL", "INFO"),
            contract_prices=parse_contract_prices(os.environ.get("MEMORY_CONTRACT_PRICES_JSON", "{}")),
        )

    def require_database_url(self) -> str:
        if not self.database_url:
            raise RuntimeError("DATABASE_URL is required for database writes")
        return self.database_url


def parse_contract_prices(raw: str) -> dict[str, Decimal]:
    try:
        payload = json.loads(raw or "{}")
    except json.JSONDecodeError:
        raise ValueError("MEMORY_CONTRACT_PRICES_JSON must be a JSON object") from None
    if not isinstance(payload, dict):
        raise ValueError("MEMORY_CONTRACT_PRICES_JSON must be a JSON object")
    parsed: dict[str, Decimal] = {}
    for key, value in payload.items():
        try:
            parsed[str(key)] = Decimal(str(value)).quantize(Decimal("0.0001"))
        except InvalidOperation:
            raise ValueError(f"invalid contract price for {key!r}: {value!r}") from None
    return parsed


def parse_url_list(raw: str) -> list[str]:
    urls = [part.strip() for part in (raw or "").split(",") if part.strip()]
    if not urls:
        raise ValueError("TWSE_REVENUE_URLS must include at least one URL")
    return urls
