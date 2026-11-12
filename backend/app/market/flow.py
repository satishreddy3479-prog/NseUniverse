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
STALE_AFTER_S = 120.0  # no push for this long during the session: the figures are shown as stale
DEPTH_STALE_AFTER_S = 60.0  # a book imbalance older than this is not shown (missing stays missing)

COUNTER_GLITCH_FLOOR = 0.98  # a cumulative volume at least this share of the last one is a late or out-of-order figure, not a restart


@dataclass
class FlowTracker:
    symbol: str
    buy: int = 0
    sell: int = 0
    unclassified: int = 0
    by_quote: int = 0  # classified volume that used the bid/ask
    by_tick: int = 0  # classified volume that used the tick rule
    carried: int = 0  # classified volume restored from the stored minutes of the same day after a restart (its quote/tick split is not stored)
    since: datetime | None = None
    last_volume: int | None = None
    last_ltp: float | None = None
    last_side: int = 0
    day: str | None = None
    depth_sum: float = 0.0
    depth_n: int = 0
    last_imbalance: float | None = None
    last_spread: float | None = None  # best ask - best bid in points
    last_bid: float | None = None
    last_ask: float | None = None
    last_update: datetime | None = None
    last_depth_at: datetime | None = None  # when the order-book imbalance was last computed
    last_atp: float | None = (
        None  # the exchange's own day VWAP of the contract (average traded price)
    )
    restarts: int = 0  # times the cumulative volume counter fell by a lot and was taken as a new baseline (the flow already classified is kept)
    last_oi: int | None = None  # open interest as streamed; 0 or missing is never stored as a value
    minutes: dict[str, tuple[int, float, int]] = field(
        default_factory=dict
    )  # minute -> (cvd, ltp, volume)

    def reset(self) -> None:
        self.buy = self.sell = self.unclassified = self.by_quote = self.by_tick = self.carried = 0
        self.since = self.last_volume = self.last_ltp = None
        self.restarts = 0
        self.last_side = 0
        self.last_oi = None
        self.depth_sum, self.depth_n, self.last_imbalance, self.last_depth_at = 0.0, 0, None, None
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
        oi: int | None = None,
    ) -> None:
        if self.day is not None and day != self.day:
            self.reset()
        self.day = day
        self.last_update = at
        if oi is not None and oi > 0:
            self.last_oi = oi
        if bid is not None and ask is not None and ask >= bid:
            self.last_spread = ask - bid
            self.last_bid, self.last_ask = bid, ask
        if atp is not None and atp > 0:
            self.last_atp = atp
        if bid_qty is not None and ask_qty is not None and bid_qty + ask_qty > 0:
            self.last_imbalance = (bid_qty - ask_qty) / (bid_qty + ask_qty)
            self.last_depth_at = at
            self.depth_sum += self.last_imbalance
            self.depth_n += 1
        if volume is None or ltp is None:
            return
        if self.last_volume is not None and volume < self.last_volume:
            if volume >= self.last_volume * COUNTER_GLITCH_FLOOR:
                return  # a slightly older cumulative volume arriving late (or a quote from another source): not a restart, and not a basis for a delta
            # The cumulative counter fell by a lot: the feed restarted it. What was classified before is real, observed flow and is KEPT (12 Nov 2026: a
            # fall used to wipe the whole session's buy and sell volume, which left HDFCBANK and BHARTIARTL with 0.5% of the day after a restart); the
            # volume that traded while the counter was off is not classified, so the new baseline is simply the current figure.
            self.last_volume, self.last_ltp = volume, ltp
            self.restarts += 1
            self._mark(minute, ltp, volume)
            return
        if self.last_volume is None:
            # first push of the day (or after a restart of the backend): volume so far is not classified
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

    def restore(self, buy: int, sell: int) -> None:
        """Continue today's cumulative buy and sell volume after a restart of the backend, from the last stored minute of the same day.

        Only valid on a tracker that has not seen a push yet. The first live push stays a baseline: the volume that traded while the backend was down is
        NOT classified (it is missing, never guessed), so the cumulative counters keep growing and a rolling window across the restart is the sum of what
        was really observed. Without this every restart began the session figures again and made the rolling windows unavailable for their whole length."""
        if self.last_volume is not None or self.buy or self.sell:
            return
        self.buy, self.sell, self.carried = int(buy), int(sell), int(buy) + int(sell)

    def imbalance_at(self, now: datetime) -> float | None:
        """The latest book imbalance, or None when its depth push is older than DEPTH_STALE_AFTER_S."""
        if self.last_imbalance is None or self.last_depth_at is None:
            return None
        return self.last_imbalance if (now - self.last_depth_at).total_seconds() <= DEPTH_STALE_AFTER_S else None

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

    def public(self, now: datetime | None = None) -> dict[str, Any]:
        """The figures for the page. With ``now`` they also carry their age: ``stale`` when nothing was pushed for
        STALE_AFTER_S, and the book imbalance is left out (None) when its last depth push is older than DEPTH_STALE_AFTER_S."""
        classified = self.buy + self.sell
        total = classified + self.unclassified
        age = None if now is None or self.last_update is None else (now - self.last_update).total_seconds()
        depth_age = None if now is None or self.last_depth_at is None else (now - self.last_depth_at).total_seconds()
        depth_ok = self.last_imbalance is not None and (depth_age is None or depth_age <= DEPTH_STALE_AFTER_S)
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
            # share of the day's traded volume this tracker has seen at all: volume that traded before its first
            # push (opening auction, a restart of the backend) is not in CVD, so this can be well below 1
            "coverage_of_day_volume": None
            if not self.last_volume
            else round(min(1.0, total / self.last_volume), 3),
            "quote_rule_share": None if classified - self.carried <= 0 else round(self.by_quote / (classified - self.carried), 3),  # of the volume seen since this run began
            "restored_volume": self.carried,
            "volume": self.last_volume,
            "last_price": self.last_ltp,
            "vwap": self.last_atp,  # the exchange average traded price of the day (day VWAP)
            "bid": self.last_bid,
            "ask": self.last_ask,
            "depth_imbalance": round(self.last_imbalance, 3) if depth_ok and self.last_imbalance is not None else None,
            "depth_updated": None if self.last_depth_at is None else self.last_depth_at.isoformat(),
            "age_seconds": None if age is None else round(age, 1),
            "stale": None if age is None else age > STALE_AFTER_S,
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


def last_cumulative(samples: list[tuple[str, dict[str, Any]]], name: str) -> tuple[int, int] | None:
    """The cumulative (buy, sell) volume a tracker has OBSERVED today, from its per-minute samples (oldest first): the ``fut`` samples carry ``b`` and
    ``s`` for the future, the ``heavy5`` samples rows of ``[symbol, cvd, buy, sell, volume, ...]``. None when no sample has both figures.

    Normally this is the newest sample. If a stored figure FELL from one minute to the next, the tracker's counters were wiped in between (before 12 Nov
    2026 a restart could do that to a single stock): what it had observed before the fall is still real, so the observed total is the sum of the
    increases, and a fall counts the new, smaller figure as a fresh start. That repairs a session whose counters were wiped; nothing is estimated."""
    tot_b = tot_s = 0
    prev_b = prev_s = 0
    seen = False
    for _, pl in samples:
        if name == "NIFTYFUT":
            b, s_ = pl.get("b"), pl.get("s")
        else:
            b = s_ = None
            for r in pl.get("rows") or []:
                if isinstance(r, list) and len(r) >= 4 and r[0] == name:
                    b, s_ = r[2], r[3]
                    break
        if not (isinstance(b, (int, float)) and isinstance(s_, (int, float))):
            continue
        b, s_ = int(b), int(s_)
        tot_b += b - prev_b if b >= prev_b else b
        tot_s += s_ - prev_s if s_ >= prev_s else s_
        prev_b, prev_s = b, s_
        seen = True
    return (tot_b, tot_s) if seen else None
