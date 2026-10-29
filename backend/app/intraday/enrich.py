"""Extra dataset features (version if-2): implied volatility, futures VWAP and flow, breadth, breakout state.

Every value at sample time t is read as-of t: option prices of sample t (and earlier samples for changes), and recorded market
samples (futures, breadth, breakout) stamped at or before t and no older than MAX_AGE_MIN. A value that does not exist is None,
never zero: sessions recorded before the futures/breadth feeds existed simply have these columns missing, and the model sees a
missingness indicator instead of an invented number.
"""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Callable, Mapping, Sequence
from datetime import date, datetime, timedelta
from typing import Any

from app.intraday import volatility as vol
from app.intraday.features import Point

MAX_AGE_MIN = 3.0
IV_LAG_MIN = 15
EXTRA_FEATURES = ("iv_atm", "iv_chg_15m", "skew_25d", "fut_vwap_dist_pct", "fut_cvd_share", "fut_depth_imb", "ad_balance", "breadth_mom_15m", "breadth_eq_return", "breakout_state", "breakout_quality")  # fmt: skip

Series = list[tuple[datetime, dict[str, Any]]]


def _asof(series: Series, times: list[datetime], at: datetime, max_age_min: float = MAX_AGE_MIN) -> dict[str, Any] | None:
    i = bisect_right(times, at) - 1
    if i < 0 or at - times[i] > timedelta(minutes=max_age_min):
        return None
    return series[i][1]


def _bal(p: Mapping[str, Any] | None) -> float | None:
    if not p or p.get("advancing") is None or p.get("declining") is None or p["advancing"] + p["declining"] == 0:
        return None
    return float((p["advancing"] - p["declining"]) / (p["advancing"] + p["declining"]))


class Enricher:
    def __init__(self, points: Sequence[Point], expiry: date, prices_at: Callable[[int], dict[tuple[float, int], float | None]], market: Mapping[str, Series], rate: float = vol.DEFAULT_RATE) -> None:
        self.points, self.expiry, self.prices_at, self.rate = points, expiry, prices_at, rate
        self.market = {k: sorted(v, key=lambda x: x[0]) for k, v in market.items()}
        self.times = {k: [t for t, _ in v] for k, v in self.market.items()}
        self._iv: dict[int, dict[str, Any]] = {}
        self.has_market = bool(self.market.get("nifty50") or self.market.get("fut"))

    def _surface(self, i: int) -> dict[str, Any]:
        if i not in self._iv:
            p = self.points[i]
            sf = vol.surface(self.prices_at(i), p.spot, self.expiry, p.at, self.rate)
            self._iv[i] = sf if sf.get("status") == "ok" else {}
        return self._iv[i]

    def _m(self, kind: str, at: datetime) -> dict[str, Any] | None:
        return _asof(self.market.get(kind, []), self.times.get(kind, []), at)

    def __call__(self, i: int) -> dict[str, float | None]:
        """Features of sample i using only samples at or before it."""
        t = self.points[i].at
        out: dict[str, float | None] = dict.fromkeys(EXTRA_FEATURES)
        now = self._surface(i)
        out["iv_atm"] = now.get("atm_iv")
        out["skew_25d"] = now.get("skew_25d_put_minus_call")
        j = next((k for k in range(i - 1, -1, -1) if self.points[k].at <= t - timedelta(minutes=IV_LAG_MIN)), None)
        if j is not None and t - timedelta(minutes=IV_LAG_MIN) - self.points[j].at <= timedelta(minutes=MAX_AGE_MIN) and now.get("atm_iv") is not None:
            then = self._surface(j).get("atm_iv")
            out["iv_chg_15m"] = None if then is None else round(now["atm_iv"] - then, 4)
        fut = self._m("fut", t)
        if fut and fut.get("ltp") and fut.get("atp"):
            out["fut_vwap_dist_pct"] = round((fut["ltp"] - fut["atp"]) / fut["atp"] * 100, 5)
        if fut and fut.get("v"):
            out["fut_cvd_share"] = round(fut["cvd"] / fut["v"], 5) if fut.get("cvd") is not None else None
            out["fut_depth_imb"] = fut.get("di")
        br = self._m("nifty50", t)
        out["ad_balance"] = _bal(br)
        if br:
            out["breadth_eq_return"] = br.get("equal_weight_return")
        prev = _asof(self.market.get("nifty50", []), self.times.get("nifty50", []), t - timedelta(minutes=IV_LAG_MIN))
        if out["ad_balance"] is not None and _bal(prev) is not None:
            out["breadth_mom_15m"] = round(out["ad_balance"] - _bal(prev), 4)  # type: ignore[operator]
        if self.has_market and (br or fut):
            b = self._m("breakout", t)
            out["breakout_state"] = 0.0 if not b else (1.0 if b.get("dir") == "up" else -1.0) if b.get("status") == "CONFIRMED" else 0.0
            out["breakout_quality"] = None if not b else b.get("q")
        return out
