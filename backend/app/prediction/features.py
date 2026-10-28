"""Point-in-time technical features from NIFTY 50 daily bars (feature set ``tech-v1``).

Every feature for reference session ``t`` uses bars up to and including ``t`` and nothing later;
``tests`` change future bars and require identical features. Inputs are the 15:30 IST close, so
these features are available at any cutoff after the reference close. No VIX, global or news
inputs yet (their publication times are not verified).
"""

from __future__ import annotations

import math
from datetime import date

from app.prediction.targets import Bar

FEATURE_VERSION = "tech-v1"
FEATURE_NAMES: tuple[str, ...] = (
    "ret_1d", "ret_5d", "ret_20d", "gap_today", "open_to_close_today", "close_position",
    "range_today", "vol_10d", "vol_20d", "vol_ratio_10_60", "dist_sma20", "dist_sma50",
    "drawdown_60d",
)  # fmt: skip
MIN_HISTORY = 61  # bars needed before the first feature row (60-day windows need 60 returns)


def _std(xs: list[float]) -> float:
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def build_features(bars: list[Bar]) -> dict[date, list[float]]:
    """Feature row for each session that has enough past history. ``bars`` must be sorted."""
    n = len(bars)
    closes = [b.close for b in bars]
    rets = [0.0] + [closes[i] / closes[i - 1] - 1 for i in range(1, n)]
    out: dict[date, list[float]] = {}
    for i in range(MIN_HISTORY - 1, n):
        b, c = bars[i], closes[i]
        span = b.high - b.low
        vol10, vol20, vol60 = (_std(rets[i - k + 1 : i + 1]) for k in (10, 20, 60))
        out[b.session] = [
            rets[i],
            c / closes[i - 5] - 1,
            c / closes[i - 20] - 1,
            b.open / closes[i - 1] - 1,
            c / b.open - 1,
            (c - b.low) / span if span > 0 else 0.5,
            span / c,
            vol10,
            vol20,
            vol10 / vol60 if vol60 > 0 else 1.0,
            c / (sum(closes[i - 19 : i + 1]) / 20) - 1,
            c / (sum(closes[i - 49 : i + 1]) / 50) - 1,
            c / max(closes[i - 59 : i + 1]) - 1,
        ]
    return out
