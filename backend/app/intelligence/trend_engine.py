"""The intraday trend and regime reading of the NIFTY index, for the market-intelligence verdict (pure functions, no I/O).

A port of the Analyse > Trend & Regime page (frontend ``lib/trendRegime.ts`` and ``lib/trendStats.ts``) so that the server can put the same reading into the fused sentiment and into
the stored timeline. The rules are the page's, fixed in advance and not tuned: four readings (efficiency ratio, ADX, regression R^2, choppiness) are each scaled 0 to 1 between a
"no trend" and a "full trend" level and averaged into a trend score; classes by the cut-offs 0.30 / 0.45 / 0.65 with a 0.05 margin, a label needs 3 bars in a row to change,
the direction is the sign of the fitted slope and a direction the +DI / -DI lines contradict makes the label Mixed.

Bars are the stored one-minute index bars, grouped into 5-minute bars anchored at 09:15 IST. Every figure at bar i uses bars 0..i only (no look-ahead). This reading describes the
session so far; it is not a forecast and, apart from the daily version, has not been validated.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime, timedelta, timezone
from typing import Any

from app.intraday.regime import adx_series, choppiness, efficiency_ratio, regression
from app.prediction.targets import Bar

IST = timezone(timedelta(hours=5, minutes=30))
OPEN_MIN = 9 * 60 + 15
SCALES: dict[str, tuple[float, float]] = {"er": (0.15, 0.45), "adx": (15.0, 35.0), "r2": (0.2, 0.8), "chop": (61.8, 38.2)}
MIXED, WEAK, TREND, MARGIN, EPS = 0.30, 0.45, 0.65, 0.05, 1e-9
LOWER = (0.0, MIXED, WEAK, TREND)
TF = 5
WINDOW = 12
ADX_N = 14
MIN_DWELL = 3
FADE_BARS = 3  # a trend label whose last this-many 5-minute closes are all FADE_ATR under the window's high (over its low) is 'fading'
FADE_ATR = 2.0
MIN_WINDOW = 6
OR_MINUTES = 15
ATR_N = 14

UP_LABELS = ("Trending up", "Weak uptrend")
DOWN_LABELS = ("Trending down", "Weak downtrend")


def _num(x: Any) -> float | None:
    return float(x) if isinstance(x, (int, float)) and math.isfinite(x) else None


def _ist_minute(t: datetime) -> int:
    t = t.astimezone(IST)
    return t.hour * 60 + t.minute


def parse_bars(raw: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """The stored one-minute bars ({at, o, h, l, c}) as dicts with a datetime; a bar that cannot be real is skipped, never repaired."""
    out: list[dict[str, Any]] = []
    for b in raw:
        try:
            t = datetime.fromisoformat(str(b["at"]))
            o, h, lo, c = (float(b[k]) for k in ("o", "h", "l", "c"))
        except (KeyError, TypeError, ValueError):
            continue
        if not all(math.isfinite(v) and v > 0 for v in (o, h, lo, c)):
            continue
        out.append({"t": t if t.tzinfo else t.replace(tzinfo=UTC), "o": o, "h": h, "l": lo, "c": c})
    return out


def aggregate(bars: Sequence[Mapping[str, Any]], m: int = TF) -> list[dict[str, Any]]:
    """Group one-minute bars into m-minute bars anchored at 09:15 IST (the open of the first minute, the high, low and close over the group)."""
    out: list[dict[str, Any]] = []
    key: int | None = None
    for b in bars:
        k = (_ist_minute(b["t"]) - OPEN_MIN) // m
        if out and k == key:
            last = out[-1]
            last["h"], last["l"], last["c"] = max(last["h"], b["h"]), min(last["l"], b["l"]), b["c"]
        else:
            out.append(dict(b))
            key = k
    return out


def _bar(b: Mapping[str, Any], day: date) -> Bar:
    return Bar(session=day, open=b["o"], high=b["h"], low=b["l"], close=b["c"])


def _ramp(v: float | None, scale: tuple[float, float]) -> float | None:
    if v is None:
        return None
    a, b = scale
    return min(1.0, max(0.0, (v - a) / (b - a)))


def trend_score(m: Mapping[str, float | None]) -> tuple[float | None, dict[str, float | None]]:
    """The 0-1 score of each reading and their mean (None with fewer than three readings)."""
    scores = {k: _ramp(m.get(k), SCALES[k]) for k in ("er", "adx", "r2", "chop")}
    v = [x for x in scores.values() if x is not None]
    return (sum(v) / len(v) if len(v) >= 3 else None), scores


def _class_of(t: float) -> int:
    return 3 if t >= TREND else 2 if t >= WEAK else 1 if t >= MIXED else 0


def step_class(prev: int | None, t: float) -> int:
    """The class after this score given the previous one: up only when the score is MARGIN past the new class's lower bound, down only when MARGIN under its own."""
    if prev is None:
        return _class_of(t)
    p = prev
    while p < 3 and t >= LOWER[p + 1] + MARGIN - EPS:
        p += 1
    while p > 0 and t < LOWER[p] - MARGIN - EPS:
        p -= 1
    return p


def label_for(cls: int, m: Mapping[str, float | None]) -> str:
    """The label of a class with its direction; a direction the +DI / -DI lines contradict makes a trend class Mixed."""
    if cls == 0:
        return "Range-bound"
    if cls == 1:
        return "Mixed"
    slope = m.get("slope")
    if slope is None or slope == 0:
        return "Mixed"
    up = slope > 0
    pdi, mdi = m.get("plus_di"), m.get("minus_di")
    if pdi is not None and mdi is not None and ((pdi < mdi) if up else (mdi < pdi)):
        return "Mixed"
    return ("Trending up" if up else "Trending down") if cls == 3 else ("Weak uptrend" if up else "Weak downtrend")


def apply_dwell(raw: Sequence[str], min_dwell: int = MIN_DWELL) -> list[str]:
    """The shown label: it switches to a new label only after that label has been seen ``min_dwell`` times in a row."""
    out: list[str] = []
    shown: str | None = None
    cand: str | None = None
    count = 0
    for i, r in enumerate(raw):
        if i == 0:
            shown = r
        elif r == shown:
            cand, count = None, 0
        else:
            if r == cand:
                count += 1
            else:
                cand, count = r, 1
            if count >= min_dwell:
                shown, cand, count = r, None, 0
        out.append(shown or r)
    return out


def regime_series(bars1m: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """The regime at every 5-minute bar of the session so far: time, label, trend score (0-1, None while warming up), the four readings, +DI / -DI, slope and the agreement count."""
    bars = aggregate(bars1m)
    if not bars:
        return []
    day = bars[0]["t"].astimezone(IST).date()
    pb = [_bar(b, day) for b in bars]
    dmi = adx_series(pb, ADX_N)
    closes = [b["c"] for b in bars]
    rows: list[dict[str, Any]] = []
    cls: int | None = None
    for i, b in enumerate(bars):
        w = min(WINDOW, i)
        ok = w >= MIN_WINDOW
        reg = regression(closes[i + 1 - w : i + 1]) if ok else None
        m: dict[str, float | None] = {
            "er": efficiency_ratio(closes[i - w : i + 1]) if ok else None,
            "adx": dmi[i][2], "plus_di": dmi[i][0], "minus_di": dmi[i][1],
            "r2": reg[1] if reg else None, "slope": reg[0] if reg else None,
            "chop": choppiness(pb[i - w : i + 1]) if ok else None,
        }
        score, scores = trend_score(m)
        raw = "Warming up"
        if score is not None:
            cls = step_class(cls, score)
            raw = label_for(cls, m)
        rows.append({"t": b["t"], "metrics": m, "score": score, "scores": scores, "raw": raw, "window": w})
    shown = apply_dwell([r["raw"] for r in rows])
    for r, lab in zip(rows, shown, strict=True):
        r["label"] = lab
        vals = [x for x in r["scores"].values() if x is not None]
        r["agreement"] = None if lab in ("Mixed", "Warming up") else {
            "agree": sum(1 for x in vals if (x < 0.5 if lab == "Range-bound" else x > 0.5)), "of": len(vals)}
        r["fading"] = False
    for i, r in enumerate(rows):
        if fading(bars, i, r["label"]):
            r["label"], r["fading"], r["agreement"] = f"{r['label']} (fading)", True, None
    return rows


def fading(bars: Sequence[Mapping[str, Any]], i: int, label: str) -> bool:
    """A trend label that price has already walked back from: the last ``FADE_BARS`` 5-minute closes are all at least ``FADE_ATR`` ATR under the ``WINDOW``-bar high (an up label) or over its
    low (a down label). The label is late by construction (it reads the last 60 minutes), so this says so instead of waiting for the score to fall. Uses bars 0..i only."""
    up, down = label in UP_LABELS, label in DOWN_LABELS
    if not (up or down) or i < FADE_BARS:
        return False
    atr = _atr(bars[: i + 1])
    if atr is None or atr <= 0:
        return False
    window = bars[max(0, i + 1 - WINDOW): i + 1]
    last = [b["c"] for b in bars[i + 1 - FADE_BARS: i + 1]]
    if up:
        return bool(max(last) <= max(b["h"] for b in window) - FADE_ATR * atr)
    return bool(min(last) >= min(b["l"] for b in window) + FADE_ATR * atr)


def direction_of(label: str | None) -> int:
    return 1 if label in UP_LABELS else -1 if label in DOWN_LABELS else 0


def strength(score: float | None) -> float | None:
    """The trend score above the Mixed floor, rescaled to 0-1 (0.30 -> 0, 1.00 -> 1): a score inside the range-bound or mixed bands is no trend evidence."""
    return None if score is None else max(0.0, (score - MIXED) / (1.0 - MIXED))


def _atr(bars5: Sequence[Mapping[str, Any]], n: int = ATR_N) -> float | None:
    if len(bars5) < n + 1:
        return None
    s = 0.0
    for i in range(len(bars5) - n, len(bars5)):
        b, p = bars5[i], bars5[i - 1]["c"]
        s += max(b["h"] - b["l"], abs(b["h"] - p), abs(b["l"] - p))
    return s / n


def opening_range(bars1m: Sequence[Mapping[str, Any]], minutes: int = OR_MINUTES) -> dict[str, Any] | None:
    inside = [b for b in bars1m if _ist_minute(b["t"]) - OPEN_MIN < minutes]
    if not inside:
        return None
    complete = any(_ist_minute(b["t"]) - OPEN_MIN >= minutes for b in bars1m)
    return {"high": max(b["h"] for b in inside), "low": min(b["l"] for b in inside), "complete": complete, "minutes": minutes}


def assess(raw_bars: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """The trend reading now plus the session figures the verdict uses: the regime of the latest 5-minute bar, the session mean of the 5-minute closes, the 14-bar ATR, the opening range
    and where price sits against them, and a compact series of the day (time, score, label, direction, close) for the timeline."""
    bars1m = parse_bars(raw_bars)
    if not bars1m:
        return {"available": False, "reason": "no one-minute index bars are stored for this session yet"}
    series = regime_series(bars1m)
    bars5 = aggregate(bars1m)
    last_bar = bars1m[-1]
    closes = [b["c"] for b in bars5]
    mean = sum(closes) / len(closes)
    atr = _atr(bars5)
    last = series[-1]
    orr = opening_range(bars1m)
    price = last_bar["c"]
    beyond: float | None = None
    state: str | None = None
    if orr and orr["complete"]:
        state = "above" if price > orr["high"] else "below" if price < orr["low"] else "inside"
        beyond = price - orr["high"] if state == "above" else price - orr["low"] if state == "below" else 0.0
    return {
        "available": True, "bars_1m": len(bars1m), "bars_5m": len(bars5), "last_bar_at": last_bar["t"].isoformat(), "last_bar_end": (last_bar["t"] + timedelta(minutes=1)).isoformat(),
        "price": price, "label": last["label"], "score": None if last["score"] is None else round(last["score"], 4), "scores": last["scores"], "agreement": last["agreement"],
        "metrics": last["metrics"], "direction": direction_of(last["label"]), "strength": strength(last["score"]),
        "session_mean": round(mean, 2), "atr": None if atr is None else round(atr, 2),
        "from_mean_atr": None if atr is None or atr <= 0 else round((price - mean) / atr, 3),
        "opening_range": None if orr is None else {**orr, "state": state, "beyond_points": beyond, "beyond_atr": None if atr is None or atr <= 0 or beyond is None else round(beyond / atr, 3)},
        "series": [{"t": r["t"].isoformat(), "score": None if r["score"] is None else round(r["score"], 4), "label": r["label"], "dir": direction_of(r["label"])} for r in series],
    }
