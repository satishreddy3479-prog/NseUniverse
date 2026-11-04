"""Swing setup scorer: standard library only (the server has no pandas).

A port of research/swing/indicators.py (the reconstructed original rules), evaluated at ONE bar:
only bars up to and including that bar are read, so truncating the data never changes a value.
tests/unit/test_swing_indicators.py checks it against the pandas version on random and real data.

Where the research code uses pandas semantics the same is done here: exponential averages start at
the first bar (adjust=False) and are missing until their minimum period, rolling windows need a
full window, and any missing value in a window makes the result missing (never zero-filled).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

Number = float | None


@dataclass(frozen=True)
class Bars:
    """Daily bars, oldest first. `bench` is the NIFTY 50 close on the same dates (None if missing)."""

    dates: list[str]
    o: list[float]
    h: list[float]
    low: list[float]
    c: list[float]
    v: list[float]
    bench: list[Number]

    def __len__(self) -> int:
        return len(self.c)


@dataclass(frozen=True)
class Setup:
    """Everything the paper engine needs from the close of one session."""

    date: str
    close: float
    score: float          # 0 when the trend template, data or history is not satisfied
    pillars: tuple[int, int, int, int]
    pivot: float | None
    dist_pct: float | None
    atr14: float | None
    ema10: float | None
    vol_sma20: float | None
    archetype: str
    mrs: float | None


def _ewm(x: list[float], alpha: float, min_periods: int) -> list[Number]:
    out: list[Number] = []
    prev = 0.0
    for i, v in enumerate(x):
        prev = v if i == 0 else (1 - alpha) * prev + alpha * v
        out.append(prev if i + 1 >= min_periods else None)
    return out


def _mean(x: list[float], a: int, b: int) -> float:
    return sum(x[a:b]) / (b - a)


def _std0(x: list[float], a: int, b: int) -> float:
    m = _mean(x, a, b)
    return math.sqrt(sum((t - m) ** 2 for t in x[a:b]) / (b - a))


def _have(*xs: Number) -> bool:
    return all(x is not None for x in xs)


def _squeeze(c: list[float], ema20: list[Number], atr20: list[Number], j: int) -> bool:
    if j < 19 or ema20[j] is None or atr20[j] is None:
        return False
    mid, sd = _mean(c, j - 19, j + 1), _std0(c, j - 19, j + 1)
    return (mid + 2 * sd) < (ema20[j] + 1.5 * atr20[j]) and (mid - 2 * sd) > (ema20[j] - 1.5 * atr20[j])  # type: ignore[operator]


def analyse(b: Bars, i: int | None = None) -> Setup | None:
    """Score the setup at the close of bar `i` (default: the last bar). None if there is no bar."""
    n = len(b)
    if n == 0:
        return None
    i = n - 1 if i is None else i
    h, low, c, v = b.h[: i + 1], b.low[: i + 1], b.c[: i + 1], b.v[: i + 1]
    date, close = b.dates[i], c[i]
    empty = Setup(date, close, 0.0, (0, 0, 0, 0), None, None, None, None, None, "CLASSIC_PIVOT", None)

    tr = [h[0] - low[0]] + [max(h[k] - low[k], abs(h[k] - c[k - 1]), abs(low[k] - c[k - 1])) for k in range(1, i + 1)]
    atr14 = _ewm(tr, 1 / 14, 14)
    atr20 = _ewm(tr, 1 / 20, 20)
    ema10 = _ewm(c, 2 / 11, 10)
    ema20 = _ewm(c, 2 / 21, 20)
    if i < 199 or not _have(atr14[i], ema20[i], ema10[i]):
        return empty
    sma50, sma200 = _mean(c, i - 49, i + 1), _mean(c, i - 199, i + 1)
    vol20 = _mean(v, i - 19, i + 1)
    h252 = max(h[max(0, i - 251): i + 1])  # min_periods=200 is met by the i >= 199 guard above

    # trend template gate (score is 0 unless all five hold)
    gate = (close >= 0.98 * ema20[i] and close >= 0.95 * sma50 and close >= 0.98 * sma200  # type: ignore[operator]
            and sma50 >= 0.98 * sma200 and h[i] >= 0.80 * h252)

    # market-relative strength: Mansfield RS = (RS / SMA50(RS) - 1) * 10, RS = close / NIFTY close
    def mrs_at(j: int) -> Number:
        if j < 49:
            return None
        win = b.bench[j - 49: j + 1]
        if any(x is None or x <= 0 for x in win):
            return None
        rs = [c[j - 49 + k] / win[k] for k in range(50)]  # type: ignore[operator]
        return (rs[-1] / (sum(rs) / 50) - 1.0) * 10.0

    mrs, mrs5 = mrs_at(i), mrs_at(i - 5)

    # pivot: highest high of the 20 bars BEFORE this one
    pivot = max(h[i - 20: i]) if i >= 20 else None
    dist = (close - pivot) / pivot * 100 if pivot else None

    # NATR "percentile": min-max scaling of NATR over the last 126 bars (>= 20 values)
    natr: list[Number] = []
    for k in range(i + 1):
        a14 = atr14[k]
        natr.append(a14 / c[k] * 100 if a14 is not None else None)
    win126 = [x for x in natr[max(0, i - 125): i + 1] if x is not None]
    natr_now = natr[i]
    natr_pct: Number = None
    if len(win126) >= 20 and natr_now is not None:
        lo, hi = min(win126), max(win126)
        natr_pct = (natr_now - lo) / (hi - lo + 1e-6)

    rng = [h[k] - low[k] for k in range(i + 1)]

    # Pillar 1: squeeze and contraction (30)
    sq = _squeeze(c, ema20, atr20, i)
    dur = 0
    j = i
    while j >= 0 and _squeeze(c, ema20, atr20, j):
        dur += 1
        j -= 1
    nr7 = i >= 6 and rng[i] <= min(rng[i - 6: i + 1])
    nr4 = i >= 3 and rng[i] <= min(rng[i - 3: i + 1])
    inside = h[i] < h[i - 1] and low[i] > low[i - 1]
    p1 = (12 if sq else 0) + (6 if 3 <= dur <= 18 else 3 if dur > 18 else 0)
    p1 += 0 if natr_pct is None else 6 if natr_pct <= 0.25 else 3 if natr_pct <= 0.40 else 0
    p1 += 4 if nr7 else 2 if nr4 else 0
    p1 += 2 if inside else 0

    # Pillar 2: institutional accumulation (30)
    def flow(k: int) -> float:
        r = rng[k]
        return 0.0 if r == 0 else ((c[k] - low[k]) - (h[k] - c[k])) / r * v[k]

    vol_sum20 = sum(v[i - 19: i + 1])
    cmf = sum(flow(k) for k in range(i - 19, i + 1)) / vol_sum20 if vol_sum20 else None
    up_v = sum(v[k] for k in range(i - 49, i + 1) if k >= 1 and c[k] > c[k - 1])
    dn_v = sum(v[k] for k in range(i - 49, i + 1) if k >= 1 and c[k] < c[k - 1])
    udv = up_v / dn_v if dn_v else None
    vdu = _mean(v, i - 2, i + 1) / _mean(v, i - 49, i + 1)

    def pocket(k: int) -> bool:
        if k < 11 or not c[k] > c[k - 1]:
            return False
        downs = [v[m] for m in range(k - 10, k) if c[m] < c[m - 1]]
        return bool(downs) and v[k] > max(downs)

    pp5 = i >= 4 and any(pocket(k) for k in range(i - 4, i + 1))
    p2 = 0 if cmf is None else 10 if cmf >= 0.15 else 6 if cmf >= 0.05 else 2 if cmf >= 0.0 else 0
    p2 += 0 if udv is None else 8 if udv >= 1.30 else 5 if udv >= 1.10 else 0
    p2 += 6 if vdu <= 0.60 else 3 if vdu <= 0.80 else 0
    p2 += 6 if pp5 else 0

    # Pillar 3: relative strength (20)
    p3 = (7 if (mrs is not None and mrs > 0) else 0) + (5 if (mrs is not None and mrs5 is not None and mrs > mrs5) else 0)
    p3 += 5 if (close > ema20[i] and ema20[i] > sma50) else 0  # type: ignore[operator]
    p3 += 3 if sma50 > sma200 else 0

    # Pillar 4: pivot proximity and base tension (20)
    p4 = 0
    if dist is not None:
        p4 += 12 if -2.5 <= dist < 0 else 0
        p4 += 7 if -4.0 <= dist < -2.5 else 0
        p4 += 8 if 0.0 <= dist <= 0.8 else 0
    r5 = max(h[i - 4: i + 1]) - min(low[i - 4: i + 1])
    r20 = max(h[i - 19: i + 1]) - min(low[i - 19: i + 1])
    if r20 != 0:
        t = r5 / r20
        p4 += 8 if t <= 0.45 else 4 if t <= 0.65 else 0

    valid = gate and pivot is not None and mrs is not None and natr_pct is not None
    ath_prior = max(h[:i])
    coil = _mean(rng, i - 9, i + 1) / _mean(rng, i - 19, i - 9) if i >= 19 and _mean(rng, i - 19, i - 9) else None
    sv = sum(v[i - 19: i - 9])
    dry = sum(v[i - 9: i + 1]) / sv if i >= 19 and sv else None
    if pivot is not None and pivot >= ath_prior * 0.985:
        arche = "BLUE_SKY"
    elif coil is not None and dry is not None and coil <= 0.85 and dry <= 0.85:
        arche = "VCP"
    else:
        arche = "CLASSIC_PIVOT"
    return Setup(
        date, close, float(p1 + p2 + p3 + p4) if valid else 0.0, (p1, p2, p3, p4), pivot, dist,
        atr14[i], ema10[i], vol20, arche, mrs,
    )


def stage2_ok(closes: list[float], long: bool = True) -> bool | None:
    """Index trend gate at the last close: above 0.98 x SMA50 (and x SMA200 when `long`).
    None when there is not enough history, so a missing gate is never read as open or closed."""
    need = 200 if long else 50
    if len(closes) < need:
        return None
    last = closes[-1]
    ok = last >= 0.98 * _mean(closes, len(closes) - 50, len(closes))
    if long:
        ok = ok and last >= 0.98 * _mean(closes, len(closes) - 200, len(closes))
    return ok
