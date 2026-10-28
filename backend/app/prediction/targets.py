"""Forecast target (label) definitions; formulas are documented in
docs/prediction/target-definitions.md.

Conventions
-----------
* ``t`` is the *reference session*: the last regular session completed before the forecast cutoff.
* Returns are simple returns as fractions (0.01 = 1%), never percentages and never log returns.
* A label is only produced when every session it needs exists in the history and the sessions are
  consecutive according to the calendar. A missing day makes the label invalid; it is never filled.
* Nothing from session t+1 or later may ever be a feature. These functions are for labels only.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date
from statistics import stdev

from app.prediction.calendar import SessionCalendar, SessionLookup


class BarError(ValueError):
    """A price bar that cannot be real. Raised, never repaired."""


@dataclass(frozen=True)
class Bar:
    session: date
    open: float
    high: float
    low: float
    close: float

    def __post_init__(self) -> None:
        vals = (self.open, self.high, self.low, self.close)
        if any(not math.isfinite(v) or v <= 0 for v in vals):
            raise BarError(f"{self.session}: prices must be finite and positive")
        if self.high < max(self.open, self.close) or self.low > min(self.open, self.close):
            raise BarError(f"{self.session}: high/low do not contain open/close")


@dataclass(frozen=True)
class Thresholds:
    """Predefined event thresholds (fractions); configurable, to be reviewed on real data."""

    t1_return: tuple[float, ...] = (0.005, 0.01)
    t1_gap: tuple[float, ...] = (0.003, 0.005)
    t5_return: tuple[float, ...] = (0.01, 0.02)
    t5_adverse: float = (
        0.02  # a close-to-close drawdown from the reference close of at least this size
    )


@dataclass(frozen=True)
class T1Label:
    reference_session: date  # t
    target_session: date  # t+1 (next eligible regular session)
    reference_close: float
    gap: float  # open[t+1] / close[t] - 1       (the opening gap)
    close_to_close: float  # close[t+1] / close[t] - 1
    open_to_close: float  # close[t+1] / open[t+1] - 1
    range_pct: float  # (high[t+1] - low[t+1]) / close[t]
    positive: bool  # close_to_close > 0
    negative: bool  # close_to_close < 0
    large_up: dict[float, bool] = field(default_factory=dict)  # close_to_close >= +x
    large_down: dict[float, bool] = field(default_factory=dict)  # close_to_close <= -x
    gap_up: dict[float, bool] = field(default_factory=dict)  # gap >= +x
    gap_down: dict[float, bool] = field(default_factory=dict)  # gap <= -x


@dataclass(frozen=True)
class T5Label:
    reference_session: date  # t
    target_session: date  # t+5 (the fifth eligible regular session after t)
    reference_close: float
    ret5: float  # close[t+5] / close[t] - 1
    positive: bool
    negative: bool
    exceed_up: dict[float, bool]  # ret5 >= +x
    exceed_down: dict[float, bool]  # ret5 <= -x
    realized_vol: float  # sample std (ddof=1) of the five daily close-to-close returns, t+1..t+5
    adverse: bool  # min over t+1..t+5 of close/close[t]-1 <= -t5_adverse
    mfe: float  # max high over t+1..t+5 / close[t] - 1
    mae: float  # min low over t+1..t+5 / close[t] - 1


@dataclass
class LabelSet:
    t1: list[T1Label] = field(default_factory=list)
    t5: list[T5Label] = field(default_factory=list)
    skipped: list[tuple[date, str]] = field(default_factory=list)


_EPS = 1e-12  # float noise: 100.5/100 - 1 is 0.00499999999999989, which is a 0.5% move


def _ge(x: float, threshold: float) -> bool:
    return x >= threshold - _EPS


def _le(x: float, threshold: float) -> bool:
    return x <= threshold + _EPS


def _t1(t: Bar, n: Bar, th: Thresholds) -> T1Label:
    c2c = n.close / t.close - 1
    gap = n.open / t.close - 1
    return T1Label(
        reference_session=t.session,
        target_session=n.session,
        reference_close=t.close,
        gap=gap,
        close_to_close=c2c,
        open_to_close=n.close / n.open - 1,
        range_pct=(n.high - n.low) / t.close,
        positive=c2c > 0,
        negative=c2c < 0,
        large_up={x: _ge(c2c, x) for x in th.t1_return},
        large_down={x: _le(c2c, -x) for x in th.t1_return},
        gap_up={x: _ge(gap, x) for x in th.t1_gap},
        gap_down={x: _le(gap, -x) for x in th.t1_gap},
    )


def _t5(t: Bar, nxt: list[Bar], th: Thresholds) -> T5Label:
    closes = [t.close] + [b.close for b in nxt]
    daily = [closes[i + 1] / closes[i] - 1 for i in range(5)]
    ret5 = closes[5] / t.close - 1
    return T5Label(
        reference_session=t.session,
        target_session=nxt[-1].session,
        reference_close=t.close,
        ret5=ret5,
        positive=ret5 > 0,
        negative=ret5 < 0,
        exceed_up={x: _ge(ret5, x) for x in th.t5_return},
        exceed_down={x: _le(ret5, -x) for x in th.t5_return},
        realized_vol=stdev(daily),
        adverse=_le(min(c / t.close - 1 for c in closes[1:]), -th.t5_adverse),
        mfe=max(b.high for b in nxt) / t.close - 1,
        mae=min(b.low for b in nxt) / t.close - 1,
    )


def make_labels(
    bars: list[Bar], calendar: SessionLookup | None = None, thresholds: Thresholds | None = None
) -> LabelSet:
    """Build T+1 and T+5 labels for every reference session that has the sessions it needs.

    ``calendar`` decides which session follows which. With a forward ``TradingCalendar`` a missing
    day in the history is detected and the affected labels are skipped. Without one, sessions come
    from the history itself, so only suspiciously large gaps (> 5 calendar days) can be detected.
    """
    th = thresholds or Thresholds()
    ordered = sorted(bars, key=lambda b: b.session)
    if len({b.session for b in ordered}) != len(ordered):
        raise BarError("duplicate sessions in the history")
    cal: SessionLookup = calendar or SessionCalendar(b.session for b in ordered)
    out = LabelSet()
    for i, t in enumerate(ordered):
        # T+1: the very next eligible session must be the next bar
        if i + 1 >= len(ordered):
            break
        nb = ordered[i + 1]
        if calendar is None and (nb.session - t.session).days > 5:
            out.skipped.append((t.session, "gap of more than 5 calendar days in the history"))
            continue
        try:
            expected = cal.next_session(t.session, 1)
        except Exception as e:  # noqa: BLE001 - coverage errors are reported, not hidden
            out.skipped.append((t.session, f"calendar: {e}"))
            continue
        if expected != nb.session:
            out.skipped.append((t.session, f"missing session {expected} in the history"))
            continue
        out.t1.append(_t1(t, nb, th))
        # T+5: five consecutive eligible sessions
        window = ordered[i + 1 : i + 6]
        if len(window) < 5:
            continue
        try:
            ok = all(
                cal.next_session(a, 1) == b
                for a, b in zip(
                    [t.session] + [w.session for w in window[:-1]],
                    [w.session for w in window],
                    strict=True,
                )
            )
        except Exception as e:  # noqa: BLE001
            out.skipped.append((t.session, f"calendar: {e}"))
            continue
        if not ok:
            out.skipped.append((t.session, "five-session window is not consecutive"))
            continue
        out.t5.append(_t5(t, window, th))
    return out
