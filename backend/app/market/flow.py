"""Estimated order flow from the live feed: buy/sell volume, cumulative volume delta (CVD), depth imbalance.

Kotak's feed gives cumulative traded volume plus the best bid/ask and the depth quantities, not a
trade-by-trade tape with the aggressor side. Each volume increase between two pushes is therefore
classified by the quote rule (traded at or above the ask = buy, at or below the bid = sell) and, when the
price is between the quotes, by the tick rule (price up = buy, down = sell, unchanged = the previous side).
This is an *estimate*: pushes can bundle several trades, and volume that arrived before the first push we
saw is not classified (it stays missing, never guessed). Every figure is labelled estimated.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

MAX_MINUTES = 420
DIVERGENCE_WINDOW = 30  # minutes
MIN_DIVERGENCE_PRICE_PCT = 0.05  # a price move smaller than this is noise


@dataclass
class FlowTracker:
    symbol: str
    buy: int = 0
    sell: int = 0
    unclassified: int = 0
    by_quote: int = 0  # classified volume that used the bid/ask
    by_tick: int = 0  # classified volume that used the tick rule
    since: datetime | None = None
    last_volume: int | None = None
    last_ltp: float | None = None
    last_side: int = 0
    day: str | None = None
    depth_sum: float = 0.0
    depth_n: int = 0
    last_imbalance: float | None = None
    last_spread: float | None = None  # best ask - best bid in points
    last_update: datetime | None = None
    last_atp: float | None = (
        None  # the exchange's own day VWAP of the contract (average traded price)
    )
    minutes: dict[str, tuple[int, float, int]] = field(
        default_factory=dict
    )  # minute -> (cvd, ltp, volume)

    def reset(self) -> None:
        self.buy = self.sell = self.unclassified = self.by_quote = self.by_tick = 0
        self.since = self.last_volume = self.last_ltp = None
        self.last_side = 0
        self.depth_sum, self.depth_n, self.last_imbalance = 0.0, 0, None
        self.minutes.clear()

    def update(
        self,
        at: datetime,
        minute: str,
        day: str,
        volume: int | None,
        ltp: float | None,
        bid: float | None = None,
        ask: float | None = None,
        bid_qty: int | None = None,
        ask_qty: int | None = None,
        atp: float | None = None,
    ) -> None:
        if self.day is not None and day != self.day:
            self.reset()
        self.day = day
        self.last_update = at
        if bid is not None and ask is not None and ask >= bid:
            self.last_spread = ask - bid
        if atp is not None and atp > 0:
            self.last_atp = atp
        if bid_qty is not None and ask_qty is not None and bid_qty + ask_qty > 0:
            self.last_imbalance = (bid_qty - ask_qty) / (bid_qty + ask_qty)
            self.depth_sum += self.last_imbalance
            self.depth_n += 1
        if volume is None or ltp is None:
            return
        if self.last_volume is None or volume < self.last_volume:
            # first push of the day (or the counter restarted): volume so far is not classified
            if self.last_volume is not None:
                self.reset()
                self.day = day
            self.last_volume, self.last_ltp, self.since = volume, ltp, at
            self._mark(minute, ltp, volume)
            return
        delta = volume - self.last_volume
        if delta > 0:
            side = 0
            if ask is not None and ltp >= ask:
                side, self.by_quote = 1, self.by_quote + delta
            elif bid is not None and ltp <= bid:
                side, self.by_quote = -1, self.by_quote + delta
            elif self.last_ltp is not None and ltp != self.last_ltp:
                side = 1 if ltp > self.last_ltp else -1
                self.by_tick += delta
            elif self.last_side != 0:
                side = self.last_side
                self.by_tick += delta
            if side > 0:
                self.buy += delta
            elif side < 0:
                self.sell += delta
            else:
                self.unclassified += delta
            if side != 0:
                self.last_side = side
        self.last_volume, self.last_ltp = volume, ltp
        self._mark(minute, ltp, volume)

    def _mark(self, minute: str, ltp: float, volume: int) -> None:
        self.minutes[minute] = (self.buy - self.sell, ltp, volume)
        while len(self.minutes) > MAX_MINUTES:
            self.minutes.pop(next(iter(self.minutes)))

    def divergence(self) -> dict[str, Any] | None:
        """Price against CVD over the last window: they should agree; when they do not, the move is suspect."""
        keys = list(self.minutes)
        if len(keys) < DIVERGENCE_WINDOW:
            return None
        a, b = self.minutes[keys[-DIVERGENCE_WINDOW]], self.minutes[keys[-1]]
        if a[1] <= 0:
            return None
        price_pct = (b[1] - a[1]) / a[1] * 100
        d_cvd = b[0] - a[0]
        traded = b[2] - a[2]
        cvd_share = d_cvd / traded if traded > 0 else None
        if abs(price_pct) < MIN_DIVERGENCE_PRICE_PCT or cvd_share is None or abs(cvd_share) < 0.02:
            state = "no_clear_move"
        elif price_pct > 0 and d_cvd < 0:
            state = "bearish_divergence"  # price rose while sellers were the net aggressors
        elif price_pct < 0 and d_cvd > 0:
            state = "bullish_divergence"
        else:
            state = "confirmed"
        return {
            "window_minutes": DIVERGENCE_WINDOW,
            "price_change_pct": round(price_pct, 3),
            "cvd_change": d_cvd,
            "cvd_share_of_volume": None if cvd_share is None else round(cvd_share, 3),
            "state": state,
        }

    def public(self) -> dict[str, Any]:
        classified = self.buy + self.sell
        total = classified + self.unclassified
        return {
            "symbol": self.symbol,
            "estimated": True,
            "since": None if self.since is None else self.since.isoformat(),
            "buy_volume": self.buy,
            "sell_volume": self.sell,
            "unclassified_volume": self.unclassified,
            "cvd": self.buy - self.sell,
            "cvd_pct": None
            if classified == 0
            else round((self.buy - self.sell) / classified * 100, 2),
            "classified_share": None if total == 0 else round(classified / total, 3),
            "quote_rule_share": None if classified == 0 else round(self.by_quote / classified, 3),
            "volume": self.last_volume,
            "last_price": self.last_ltp,
            "depth_imbalance": None
            if self.last_imbalance is None
            else round(self.last_imbalance, 3),
            "depth_imbalance_avg": None
            if self.depth_n == 0
            else round(self.depth_sum / self.depth_n, 3),
            "divergence": self.divergence(),
            "updated": None if self.last_update is None else self.last_update.isoformat(),
        }


def volume_profile(
    sessions: list[list[tuple[int, float]]], min_sessions: int = 5
) -> dict[int, float] | None:
    """Typical share of the day's volume done by each minute of the session, from our own recordings.

    ``sessions`` = per past session a list of (minutes since the open, cumulative volume). Each session
    is turned into fractions of its final volume; the profile is the median fraction per minute.
    Returns None until ``min_sessions`` complete sessions exist.
    """
    fracs: list[dict[int, float]] = []
    for s in sessions:
        pts = sorted(s)
        if len(pts) < 100 or pts[-1][1] <= 0 or pts[-1][0] < 360:  # a nearly complete session only
            continue
        final = pts[-1][1]
        fracs.append({int(t): v / final for t, v in pts})
    if len(fracs) < min_sessions:
        return None
    out: dict[int, float] = {}
    for t in range(0, 376):
        vals = sorted(f[t] for f in fracs if t in f)
        if len(vals) >= min_sessions:
            out[t] = vals[len(vals) // 2]
    return out or None


def profile_fraction(profile: dict[int, float] | None, elapsed_minutes: float) -> float | None:
    if not profile:
        return None
    t = int(min(375, max(0, elapsed_minutes)))
    for k in range(t, max(-1, t - 6), -1):  # nearest recorded minute at or before t
        if k in profile:
            return profile[k] if profile[k] > 0 else None
    return None
