"""Daily trend / range regime of NIFTY 50 from the stored daily bars, with a validation study on the whole stored history.

The label is the same rule as the intraday one on the Analyse menu (frontend ``lib/trendRegime.ts``), applied to daily bars with a 20-day window:
four readings vote (efficiency ratio, ADX, regression R^2, choppiness index), three or more of one kind decide, and a shown label changes only after the
new one has held three days in a row. The thresholds are the textbook values fixed BEFORE the study (see ``THRESHOLDS``); none was tuned on this history.
Every figure at day t uses closes up to day t only.

Validation (``study``), stated in advance:
  * The claim: after a day labelled Trending, the next ``HORIZON`` days travel more in a straight line than after a day labelled Range-bound. The measure is
    the efficiency ratio of the next ``HORIZON`` closes (a forward-looking measure that no input of the label uses).
  * To keep the samples independent, only every ``HORIZON``-th day is used. The test is one-sided: Trending minus Range-bound mean forward efficiency
    ratio, with a permutation p-value (labels shuffled, ``PERMUTATIONS`` times, fixed seed).
  * The label counts as validated only if the difference is positive, p < 0.05, and the difference is positive in each of three equal chronological thirds.
  * The same is reported for the direction (Trending up against Trending down, forward ``HORIZON``-day return) and for forward realised volatility; those
    two are information only and never make a claim by themselves.
A failed criterion is reported as failed, and the page then labels the daily regime "descriptive, not validated".
"""

from __future__ import annotations

import math
import random
from datetime import date
from typing import Any

from app.intraday.hv import regular_bars
from app.prediction.targets import Bar

THRESHOLDS = {
    "er_trend": 0.35, "er_range": 0.20, "adx_trend": 25.0, "adx_range": 20.0,
    "r2_trend": 0.60, "r2_range": 0.30, "chop_trend": 38.2, "chop_range": 61.8, "votes_needed": 3,
}
WINDOW = 20
ADX_N = 14
MIN_DWELL = 3
HORIZON = 10
PERMUTATIONS = 5000
SEED = 20261123
TRENDING = ("Trending up", "Trending down")


def efficiency_ratio(closes: list[float]) -> float | None:
    """|net change| / sum of |changes| over the given closes; None when nothing moved or there are fewer than 2."""
    if len(closes) < 2:
        return None
    path = sum(abs(b - a) for a, b in zip(closes, closes[1:], strict=False))
    return None if path == 0 else abs(closes[-1] - closes[0]) / path


def regression(closes: list[float]) -> tuple[float, float | None] | None:
    """Slope per bar and R^2 of the closes on 0..n-1; R^2 is None for a flat line."""
    n = len(closes)
    if n < 3:
        return None
    xm = (n - 1) / 2
    ym = sum(closes) / n
    sxx = sum((i - xm) ** 2 for i in range(n))
    sxy = sum((i - xm) * (y - ym) for i, y in enumerate(closes))
    syy = sum((y - ym) ** 2 for y in closes)
    return sxy / sxx, (None if syy == 0 else sxy * sxy / (sxx * syy))


def _true_range(b: Bar, prev_close: float) -> float:
    return max(b.high - b.low, abs(b.high - prev_close), abs(b.low - prev_close))


def choppiness(bars: list[Bar]) -> float | None:
    """100 x log10(sum of true ranges / range) / log10(n) over bars[1:], with bars[0] giving the first previous close."""
    n = len(bars) - 1
    if n < 2:
        return None
    total = sum(_true_range(bars[i], bars[i - 1].close) for i in range(1, n + 1))
    rng = max(b.high for b in bars[1:]) - min(b.low for b in bars[1:])
    if rng <= 0 or total <= 0:
        return None
    return 100 * math.log10(total / rng) / math.log10(n)


def adx_series(bars: list[Bar], n: int = ADX_N) -> list[tuple[float | None, float | None, float | None]]:
    """Wilder's (+DI, -DI, ADX) for every bar; +DI / -DI from bar n, ADX from bar 2n - 1."""
    out: list[tuple[float | None, float | None, float | None]] = [(None, None, None)] * len(bars)
    if len(bars) < n + 1:
        return out
    tr, pdm, mdm = [0.0], [0.0], [0.0]
    for i in range(1, len(bars)):
        up = bars[i].high - bars[i - 1].high
        dn = bars[i - 1].low - bars[i].low
        tr.append(_true_range(bars[i], bars[i - 1].close))
        pdm.append(up if up > dn and up > 0 else 0.0)
        mdm.append(dn if dn > up and dn > 0 else 0.0)
    s_tr, s_p, s_m = sum(tr[1 : n + 1]), sum(pdm[1 : n + 1]), sum(mdm[1 : n + 1])
    dxs: list[float] = []
    adx_prev: float | None = None
    for i in range(n, len(bars)):
        if i > n:
            s_tr += tr[i] - s_tr / n
            s_p += pdm[i] - s_p / n
            s_m += mdm[i] - s_m / n
        p = None if s_tr == 0 else 100 * s_p / s_tr
        m = None if s_tr == 0 else 100 * s_m / s_tr
        a: float | None = None
        dx = None if p is None or m is None or p + m == 0 else 100 * abs(p - m) / (p + m)
        if dx is None:
            dxs, adx_prev = [], None
        else:
            dxs.append(dx)
            if adx_prev is None:
                if len(dxs) == n:
                    adx_prev = sum(dxs) / n
                    a = adx_prev
            else:
                adx_prev = (adx_prev * (n - 1) + dx) / n
                a = adx_prev
        out[i] = (p, m, a)
    return out


def classify(er: float | None, adx: float | None, plus_di: float | None, minus_di: float | None,
             r2: float | None, slope: float | None, chop: float | None) -> tuple[str, dict[str, int]]:
    """One bar's label from its four readings (the rule in the module docstring) and the vote counts."""
    t = THRESHOLDS
    trend = rng = evaluable = 0
    for v, is_t, is_r in (
        (er, er is not None and er >= t["er_trend"], er is not None and er <= t["er_range"]),
        (adx, adx is not None and adx >= t["adx_trend"], adx is not None and adx < t["adx_range"]),
        (r2, r2 is not None and r2 >= t["r2_trend"], r2 is not None and r2 <= t["r2_range"]),
        (chop, chop is not None and chop < t["chop_trend"], chop is not None and chop > t["chop_range"]),
    ):
        if v is None:
            continue
        evaluable += 1
        trend += is_t
        rng += is_r and not is_t
    votes = {"trend": trend, "range": rng, "evaluable": evaluable}
    if evaluable < 3:
        return "Warming up", votes
    if trend >= t["votes_needed"]:
        if slope is None or slope == 0:
            return "Unclear", votes
        up = slope > 0
        agrees = plus_di is None or minus_di is None or (plus_di >= minus_di if up else minus_di >= plus_di)
        return (("Trending up" if up else "Trending down") if agrees else "Unclear"), votes
    if rng >= t["votes_needed"]:
        return "Range-bound", votes
    return "Unclear", votes


def apply_dwell(raw: list[str], min_dwell: int = MIN_DWELL) -> list[str]:
    """Shown labels: a new label is shown only after it has been the bar's own label ``min_dwell`` times in a row."""
    out: list[str] = []
    shown = ""
    cand: str | None = None
    count = 0
    for i, r in enumerate(raw):
        if i == 0:
            shown = r
        elif r == shown:
            cand, count = None, 0
        else:
            count = count + 1 if r == cand else 1
            cand = r
            if count >= min_dwell:
                shown, cand, count = r, None, 0
        out.append(shown)
    return out


def label_series(bars: list[Bar]) -> list[dict[str, Any]]:
    """The regime at every bar (causal): label shown, label of the bar alone, and the readings."""
    dmi = adx_series(bars)
    rows: list[dict[str, Any]] = []
    raws: list[str] = []
    for i in range(len(bars)):
        er = reg = chop = None
        if i >= WINDOW:
            closes = [b.close for b in bars[i - WINDOW : i + 1]]
            er = efficiency_ratio(closes)
            reg = regression(closes[1:])  # the last WINDOW closes, as the intraday library does
            chop = choppiness(bars[i - WINDOW : i + 1])
        slope = reg[0] if reg else None
        r2 = reg[1] if reg else None
        raw, votes = classify(er, dmi[i][2], dmi[i][0], dmi[i][1], r2, slope, chop)
        raws.append(raw)
        rows.append({"er": er, "adx": dmi[i][2], "plus_di": dmi[i][0], "minus_di": dmi[i][1], "r2": r2, "slope": slope, "chop": chop, "raw": raw, "votes": votes})
    shown = apply_dwell(raws)
    for r, s in zip(rows, shown, strict=True):
        r["label"] = s
    return rows


def _mean(v: list[float]) -> float:
    return sum(v) / len(v)


def _perm_p(a: list[float], b: list[float], rng: random.Random) -> float | None:
    """One-sided permutation p-value of mean(a) - mean(b) being as large as observed (labels shuffled)."""
    if len(a) < 5 or len(b) < 5:
        return None
    obs = _mean(a) - _mean(b)
    pool = a + b
    na = len(a)
    hits = 0
    for _ in range(PERMUTATIONS):
        rng.shuffle(pool)
        if _mean(pool[:na]) - _mean(pool[na:]) >= obs:
            hits += 1
    return (hits + 1) / (PERMUTATIONS + 1)


def study(bars: list[Bar], rows: list[dict[str, Any]]) -> dict[str, Any]:
    """The validation study described in the module docstring."""
    samples: list[dict[str, Any]] = []
    start = WINDOW + 2 * ADX_N  # the first bar with all four readings
    for i in range(start, len(bars) - HORIZON, HORIZON):
        label = rows[i]["label"]
        if label not in (*TRENDING, "Range-bound", "Unclear"):
            continue
        fwd = [b.close for b in bars[i : i + HORIZON + 1]]
        fer = efficiency_ratio(fwd)
        if fer is None:
            continue
        rets = [math.log(b / a) for a, b in zip(fwd, fwd[1:], strict=False)]
        m = _mean(rets)
        rv = math.sqrt(sum((r - m) ** 2 for r in rets) / (len(rets) - 1) * 252) * 100
        samples.append({"date": bars[i].session, "label": label, "fer": fer, "ret": math.log(fwd[-1] / fwd[0]) * 100, "rv": rv})

    def group(names: tuple[str, ...], key: str, sub: list[dict[str, Any]] | None = None) -> list[float]:
        return [s[key] for s in (sub if sub is not None else samples) if s["label"] in names]

    trend_er = group(TRENDING, "fer")
    range_er = group(("Range-bound",), "fer")
    rng = random.Random(SEED)  # noqa: S311 - a reproducible permutation test, not cryptography
    diff = _mean(trend_er) - _mean(range_er) if trend_er and range_er else None
    p = _perm_p(trend_er, range_er, rng)
    thirds: list[dict[str, Any]] = []
    k = len(samples)
    for j in range(3):
        sub = samples[j * k // 3 : (j + 1) * k // 3]
        a, b = group(TRENDING, "fer", sub), group(("Range-bound",), "fer", sub)
        thirds.append({
            "from": str(sub[0]["date"]) if sub else None, "to": str(sub[-1]["date"]) if sub else None, "n_trending": len(a), "n_range": len(b),
            "diff": (_mean(a) - _mean(b)) if a and b else None,
        })
    consistent = all(t["diff"] is not None and t["diff"] > 0 for t in thirds)
    validated = bool(diff is not None and diff > 0 and p is not None and p < 0.05 and consistent)
    up, dn = group(("Trending up",), "ret"), group(("Trending down",), "ret")
    dir_diff = _mean(up) - _mean(dn) if up and dn else None
    dir_p = _perm_p(up, dn, rng)

    def stats(names: tuple[str, ...]) -> dict[str, Any]:
        e, r, v = group(names, "fer"), group(names, "ret"), group(names, "rv")
        return {"n": len(e), "forward_er": _mean(e) if e else None, "forward_return_pct": _mean(r) if r else None, "forward_rv": _mean(v) if v else None}

    return {
        "horizon_days": HORIZON, "window_days": WINDOW, "permutations": PERMUTATIONS, "seed": SEED, "samples": len(samples),
        "from": str(samples[0]["date"]) if samples else None, "to": str(samples[-1]["date"]) if samples else None,
        "groups": {"Trending up": stats(("Trending up",)), "Trending down": stats(("Trending down",)), "Trending": stats(TRENDING),
                   "Range-bound": stats(("Range-bound",)), "Unclear": stats(("Unclear",))},
        "claim": {"diff_forward_er": diff, "p_value": p, "thirds": thirds, "validated": validated,
                  "criterion": "Trending minus Range-bound mean forward efficiency ratio > 0, one-sided permutation p < 0.05, and > 0 in each chronological third"},
        "direction": {"diff_forward_return_pct": dir_diff, "p_value": dir_p, "information_only": True},
        "thresholds": THRESHOLDS,
    }


def daily_regime(bars: list[Bar], today: date, exclude: frozenset[date] | set[date] = frozenset(), series_len: int = 250) -> dict[str, Any]:
    """Current daily regime, its recent history, and the validation study. Final closes of regular sessions only."""
    reg = regular_bars(bars, exclude)
    if len(reg) < WINDOW + 2 * ADX_N + HORIZON + 10:
        return {"status": "not computed: too few stored daily bars", "bars": len(reg)}
    rows = label_series(reg)
    last = rows[-1]
    st = study(reg, rows)
    tail = list(range(max(0, len(reg) - series_len), len(reg)))
    return {
        "status": "ok", "as_of": str(reg[-1].session), "today": str(today), "bars": len(reg), "from": str(reg[0].session),
        "current": {"label": last["label"], "raw": last["raw"], "votes": last["votes"], **{k: last[k] for k in ("er", "adx", "plus_di", "minus_di", "r2", "slope", "chop")}},
        "series": {"dates": [str(reg[i].session) for i in tail], "close": [reg[i].close for i in tail], "label": [rows[i]["label"] for i in tail]},
        "study": st,
        "validated": st["claim"]["validated"],
        "method": "Four readings vote on the last 20 daily closes (efficiency ratio, ADX 14, R-squared, choppiness index); thresholds fixed before the study; a shown label needs 3 days in a row",
    }
