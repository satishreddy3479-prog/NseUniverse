"""Opening-range breakout state, breakout quality and swing structure from the sampled spot path (pure, no I/O).

Definitions (all reproducible; nothing uses a bar that is still forming):
* Minute close: the last stored spot sample of an IST minute. The sampler stores about one spot per
  minute, so a "candle" here is a sample, not an exchange OHLC; highs/lows are sampled extremes.
* Completed minute: a minute strictly before the minute of ``now``.
* Opening range (OR) of N minutes: high/low of samples from 09:15 up to 09:15+N. It is "forming" until N
  minutes have passed. Width = high - low.
* Breakout candidate: after the OR ends, a completed minute close above OR high (up) or below OR low
  (down). The scan keeps the first candidate and walks forward, so replay gives the same answer.
* Buffer = BUFFER_FRAC x OR width. "Beyond" means close beyond the boundary; "clear" means beyond boundary +/- buffer.
Status of the latest candidate:
  UNCONFIRMED  the first close beyond the boundary, not yet DEVELOPING
  DEVELOPING   >= 2 consecutive closes beyond the boundary
  CONFIRMED    >= CONFIRM_CLOSES consecutive closes clear of the buffer, still beyond at the last close
  FAILED       was DEVELOPING/CONFIRMED (or 2+ closes beyond) and a later close is back inside the range
  INVALIDATED  a later close beyond the OPPOSITE boundary
  EXPIRED      still only UNCONFIRMED/DEVELOPING EXPIRE_MIN minutes after the first close beyond
Quality score (0-100) is NOT a probability: weighted mean of the available components, each 0..1:
  distance 25  (distance beyond the boundary in OR widths, capped at 1)
  follow-through 20  (consecutive closes beyond / CONFIRM_CLOSES, capped at 1)
  vwap 20  (NIFTY future above its day VWAP for an up break, below for a down break: 1/0)
  volume 15  (futures volume vs normal: 1 at >=1.2x, 0 at <=0.7x, linear between)
  breadth 20  (NIFTY 50 advance/decline balance in the break direction: (balance+1)/2 for up, (1-balance)/2 for down)
Components without data are left out and the weights renormalised; coverage = weight share available; with
coverage < 0.5 no score is given.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from app.intraday.features import IST, OPEN, Point

BUFFER_FRAC = 0.10
CONFIRM_CLOSES = 3
EXPIRE_MIN = 30
MIN_COVERAGE = 0.5
WEIGHTS = {"distance": 25, "follow_through": 20, "vwap": 20, "volume": 15, "breadth": 20}
SWING_K = 2  # a swing needs K points each side (5-minute closes): confirmed only K points later
STRUCTURE_STEP_MIN = 5


@dataclass(frozen=True)
class Close:
    minute: int  # minutes since 09:15
    price: float
    high: float
    low: float


def minute_closes(points: Sequence[Point], now: datetime) -> list[Close]:
    """One entry per completed minute that has at least one sample."""
    cur = _minute(now)
    acc: dict[int, list[float]] = {}
    for p in points:
        m = _minute(p.at)
        if m < cur:
            acc.setdefault(m, []).append(p.spot)
    return [Close(m, v[-1], max(v), min(v)) for m, v in sorted(acc.items())]


def _minute(t: datetime) -> int:
    x = t.astimezone(IST)
    return x.hour * 60 + x.minute - (OPEN.hour * 60 + OPEN.minute)


def opening_range(points: Sequence[Point], now: datetime, minutes: int) -> dict[str, Any]:
    inside = [p.spot for p in points if 0 <= _minute(p.at) < minutes]
    elapsed = _minute(now)
    if not inside:
        return {
            "minutes": minutes,
            "state": "no_data",
            "high": None,
            "low": None,
            "mid": None,
            "width": None,
        }
    hi, lo = max(inside), min(inside)
    return {"minutes": minutes, "state": "forming" if elapsed < minutes else "complete", "high": hi, "low": lo,
            "mid": (hi + lo) / 2, "width": hi - lo, "samples": len(inside)}  # fmt: skip


def scan_breakout(
    closes: Sequence[Close], hi: float, lo: float, or_minutes: int
) -> dict[str, Any] | None:
    """Status of the latest breakout candidate after the opening range, or None when no close has left the range."""
    width = hi - lo
    if width <= 0:
        return None
    buf = BUFFER_FRAC * width
    after = [c for c in closes if c.minute >= or_minutes]
    cand: dict[str, Any] | None = None
    for c in after:
        side = "up" if c.price > hi else "down" if c.price < lo else None
        if cand is None:
            if side:
                cand = _new(c, side, hi, lo, buf)
            continue
        d = cand["direction"]
        if cand["status"] in TERMINAL:
            # a finished candidate is replaced only by a break the other way, or by a fresh break after a close back inside
            if side is None:
                cand["rearm"] = True
            elif side != d or cand.get("rearm"):
                old = cand["status"]
                cand = _new(c, side, hi, lo, buf)
                cand["previous"] = f"{d} {old}"
            continue
        cand["last_minute"] = c.minute
        if side == d:
            cand["beyond"] += 1
            cand["clear"] = cand["clear"] + 1 if _clear(c.price, d, hi, lo, buf) else 0
            cand["max_ext"] = max(cand["max_ext"], _ext(c.price, d, hi, lo))
            cand["status"] = (
                "CONFIRMED"
                if cand["clear"] >= CONFIRM_CLOSES
                else "DEVELOPING"
                if cand["beyond"] >= 2
                else "UNCONFIRMED"
            )
        elif side is None:
            cand["status"] = "FAILED"  # back inside the range after leaving it
            cand["failed_minute"] = c.minute
        else:
            cand["status"] = "INVALIDATED"
            cand["failed_minute"] = c.minute
        if (
            cand["status"] in ("UNCONFIRMED", "DEVELOPING")
            and c.minute - cand["first_minute"] >= EXPIRE_MIN
        ):
            cand["status"] = "EXPIRED"
    if cand is None:
        return None
    last = after[-1].price if after else None
    cand["last_price"] = last
    cand["extension_ow"] = None if last is None else round(_ext(last, cand["direction"], hi, lo), 3)
    cand["invalidation"] = (
        hi if cand["direction"] == "up" else lo
    )  # back through this level = failed
    return cand


TERMINAL = ("FAILED", "INVALIDATED", "EXPIRED")


def _new(c: Close, side: str, hi: float, lo: float, buf: float) -> dict[str, Any]:
    return {"direction": side, "first_minute": c.minute, "beyond": 1, "clear": int(_clear(c.price, side, hi, lo, buf)), "status": "UNCONFIRMED",
            "max_ext": _ext(c.price, side, hi, lo), "last_minute": c.minute}  # fmt: skip


def _clear(price: float, side: str, hi: float, lo: float, buf: float) -> bool:
    return price > hi + buf if side == "up" else price < lo - buf


def _ext(price: float, side: str, hi: float, lo: float) -> float:
    w = hi - lo
    return ((price - hi) if side == "up" else (lo - price)) / w if w > 0 else 0.0


def quality(
    cand: dict[str, Any],
    *,
    vwap_side: str | None,
    rel_volume: float | None,
    ad_balance: float | None,
) -> dict[str, Any]:
    """Breakout quality 0-100 (a score, not a probability) with every component shown."""
    d = cand["direction"]
    comp: dict[str, float | None] = {
        "distance": min(1.0, max(0.0, cand["extension_ow"] or 0.0))
        if cand.get("extension_ow") is not None
        else None,
        "follow_through": min(1.0, cand["clear"] / CONFIRM_CLOSES),
        "vwap": None if vwap_side is None else 1.0 if vwap_side == d else 0.0,
        "volume": None if rel_volume is None else min(1.0, max(0.0, (rel_volume - 0.7) / 0.5)),
        "breadth": None
        if ad_balance is None
        else ((ad_balance + 1) / 2 if d == "up" else (1 - ad_balance) / 2),
    }
    have = {k: v for k, v in comp.items() if v is not None}
    wsum = sum(WEIGHTS[k] for k in have)
    coverage = wsum / sum(WEIGHTS.values())
    score = (
        None
        if coverage < MIN_COVERAGE
        else round(sum(WEIGHTS[k] * v for k, v in have.items()) / wsum * 100, 1)
    )
    return {"score": score, "coverage": round(coverage, 2), "components": {k: None if v is None else round(v, 3) for k, v in comp.items()},
            "missing": [k for k, v in comp.items() if v is None], "weights": WEIGHTS, "is_probability": False}  # fmt: skip


def swings(closes: Sequence[Close]) -> list[dict[str, Any]]:
    """Swing highs/lows on 5-minute closes, each confirmed only after SWING_K later points (no look-ahead)."""
    pts: dict[int, float] = {}
    for c in closes:
        pts[c.minute // STRUCTURE_STEP_MIN] = c.price
    ks = sorted(pts)
    v = [pts[k] for k in ks]
    out: list[dict[str, Any]] = []
    for i in range(SWING_K, len(v) - SWING_K):
        w = v[i - SWING_K : i + SWING_K + 1]
        if v[i] == max(w) and w.count(v[i]) == 1:
            out.append({"kind": "high", "price": v[i], "minute": ks[i] * STRUCTURE_STEP_MIN})
        elif v[i] == min(w) and w.count(v[i]) == 1:
            out.append({"kind": "low", "price": v[i], "minute": ks[i] * STRUCTURE_STEP_MIN})
    return out


def structure(closes: Sequence[Close]) -> dict[str, Any]:
    sw = swings(closes)
    highs, lows = [s for s in sw if s["kind"] == "high"], [s for s in sw if s["kind"] == "low"]
    hh = len(highs) >= 2 and highs[-1]["price"] > highs[-2]["price"]
    lh = len(highs) >= 2 and highs[-1]["price"] < highs[-2]["price"]
    hl = len(lows) >= 2 and lows[-1]["price"] > lows[-2]["price"]
    ll = len(lows) >= 2 and lows[-1]["price"] < lows[-2]["price"]
    if len(highs) < 2 or len(lows) < 2:
        label = "insufficient"
    elif hh and hl:
        label = "uptrend (higher highs, higher lows)"
    elif lh and ll:
        label = "downtrend (lower highs, lower lows)"
    else:
        label = "mixed"
    last = closes[-1].price if closes else None
    bos = None
    if last is not None and highs and last > highs[-1]["price"]:
        bos = "change_of_character_up" if lh else "break_of_structure_up"
    elif last is not None and lows and last < lows[-1]["price"]:
        bos = "change_of_character_down" if hl else "break_of_structure_down"
    return {"label": label, "swing_highs": highs[-3:], "swing_lows": lows[-3:], "last_swing_high": highs[-1]["price"] if highs else None,
            "last_swing_low": lows[-1]["price"] if lows else None, "break": bos, "swing_rule": f"{SWING_K} points each side of 5-minute closes, confirmed {SWING_K * STRUCTURE_STEP_MIN} min later"}  # fmt: skip


def analyze(
    points: Sequence[Point],
    now: datetime,
    *,
    or_minutes: tuple[int, ...] = (15, 30),
    vwap_side: str | None = None,
    rel_volume: float | None = None,
    ad_balance: float | None = None,
    live: bool = True,
) -> dict[str, Any]:
    """Everything for the dashboard widget. ``live`` False -> the result is labelled HISTORICAL and carries no breakout call."""
    closes = minute_closes(points, now)
    out: dict[str, Any] = {"as_of": now.isoformat(), "data": "LIVE" if live else "HISTORICAL", "completed_minutes": len(closes),
                           "candle_note": "Candles are sampled spot (about one per minute); highs/lows are sampled extremes.", "ranges": [], "breakout": None, "structure": structure(closes) if closes else None}  # fmt: skip
    for n in or_minutes:
        r = opening_range(points, now, n)
        out["ranges"].append(r)
        if not live or r["state"] != "complete" or r["width"] in (None, 0):
            continue
        cand = scan_breakout(closes, r["high"], r["low"], n)
        if cand is not None and (out["breakout"] is None or n == or_minutes[0]):
            cand["or_minutes"] = n
            cand["quality"] = quality(
                cand, vwap_side=vwap_side, rel_volume=rel_volume, ad_balance=ad_balance
            )
            out["breakout"] = cand
    return out
