"""Builds the market-intelligence service from the running application's services (called once from ``app.main``)."""

from __future__ import annotations

from datetime import UTC, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.intelligence.service import MarketIntelligence, parse_weights
from app.intelligence.store import IntelligenceStore
from app.market.futures_series import futures_series
from app.storage.observations import to_ms

IST = ZoneInfo("Asia/Kolkata")


def create(settings: Any, observations: Any, intraday: Any, market: Any, market_store: Any) -> MarketIntelligence:
    def expiry() -> str | None:
        """Nearest expiry with samples today, else on the latest earlier session (so the dashboard also reads after the close)."""
        today = datetime.now(IST).date()
        for back in range(9):
            day = today - timedelta(days=back)
            lo, hi = datetime.combine(day, time(9, 0), IST), datetime.combine(day, time(16, 0), IST)
            rows = observations.day_counts(settings.underlying, to_ms(lo), to_ms(hi))
            if rows:
                return str(rows[0][0])
        return None

    def futures() -> dict[str, Any]:
        return futures_series(market_store, observations, settings.underlying, rate=settings.risk_free_rate)

    def flow() -> dict[str, Any]:
        """Today's stored per-minute flow samples of the future and the heavyweights (read-only; written by the market sampler)."""
        start = datetime.combine(datetime.now(IST).date(), time(9, 0), IST).astimezone(UTC).isoformat()
        return {"fut": market_store.samples_since("fut", start), "heavy5": market_store.samples_since("heavy5", start)}

    def heavymeta() -> dict[str, Any]:
        return dict(market.heavy_meta())

    providers = {
        "flow": flow, "heavymeta": heavymeta, "ml": lambda: intraday.ml_digest(),
        "market": market.summary, "intraday": intraday.summary, "futures": futures,
        "skew": lambda e: intraday.iv_skew(e), "momentum": lambda e: intraday.iv_momentum(e),
        "positioning": lambda e: intraday.strike_positioning(e, "15"),
        "gex": lambda e: intraday.gex_history(e, None, "dynamic"), "vix": lambda: intraday.iv_chart(21),
    }
    return MarketIntelligence(
        providers=providers, store=IntelligenceStore(settings.data_dir), default_expiry=expiry,
        weights=parse_weights(settings.intelligence_weights), enabled=settings.intelligence_enabled,
    )
