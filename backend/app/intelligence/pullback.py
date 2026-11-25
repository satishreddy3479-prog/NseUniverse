"""Price-structure turn flag: spot has pulled back from a fresh session high (or bounced off a fresh low) after a real run.

The fused verdict is a level and the engine-based turn watch (``turn.py``) compares 5-minute averages 20 minutes apart, so both are late at a sharp turn: on 25 Nov 2026 NIFTY peaked
at 25,948 at 11:46 while the verdict stayed Bullish for another 45 minutes. This module reads only the stored per-minute spot of the session, rows 0..i (no look-ahead), and flags
the turn in plain price terms: how far spot is under the session high (or over the session low), in ATRs, how recent that extreme is, and how big the run into it was. The ATR is the
5-minute-bar ATR of the same minutes (anchored at 09:15 IST), the same unit the Market Intelligence page uses for its levels.

A description of price, not a forecast. The thresholds are fixed working values (``docs/decisions.md``), not trained or validated; every flag says what would cancel it.
Pure functions over rows from ``IntelligenceStore.rows`` (oldest first); a minute with no spot is skipped, never filled.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from typing import Any

IST = timezone(timedelta(hours=5, minutes=30))
OPEN_MIN = 9 * 60 + 15
TF = 5  # minutes per ATR bar
ATR_N = 14  # bars averaged (fewer while the session is young, never fewer than MIN_BARS)
MIN_BARS = 6  # 30 minutes of bars before any flag
PULL_ATR = 1.5  # spot this many ATRs under the session high (over the low) is a mild flag
STRONG_ATR = 2.5  # ... and this many a strong one
RUN_ATR = 2.0  # the run into the extreme must be at least this many ATRs (so a flat day's wiggles never qualify)
RUN_LOOKBACK = 60  # minutes before the extreme in which the run is measured
PULL_WINDOW = 45  # the extreme must be at most this many minutes old (30 / 45 / 60 were tried on the stored sessions: all three beat the 59 % base rate as a warning; 45 kept)
PERSIST_WINDOW = 4  # a flag counts only when present in at least PERSIST_MIN of the last PERSIST_WINDOW minutes
PERSIST_MIN = 3
MIN_ROWS = MIN_BARS * TF
NEUTRAL_CAP = 15.0  # the verdict's neutral band: a capped score sits just inside it


def _spot(r: Mapping[str, Any]) -> float | None:
    v = r.get("spot")
    return float(v) if isinstance(v, (int, float)) and math.isfinite(v) and v > 0 else None


def _bar_index(r: Mapping[str, Any]) -> int | None:
    try:
        t = datetime.fromisoformat(str(r["at"])).astimezone(IST)
    except (KeyError, ValueError, TypeError):
        return None
    return (t.hour * 60 + t.minute - OPEN_MIN) // TF


def atr_at(rows: Sequence[Mapping[str, Any]], end: int | None = None) -> float | None:
    """ATR (points) of the 5-minute bars made of the minute spots up to row ``end``: the mean true range of the last ``ATR_N`` complete bars
    (the bar still forming is left out). None before ``MIN_BARS`` complete bars."""
    i = len(rows) - 1 if end is None else end
    bars: list[list[float]] = []  # [high, low, close] per bar index, in order
    idx: list[int] = []
    for r in rows[: i + 1]:
        s, b = _spot(r), _bar_index(r)
        if s is None or b is None:
            continue
        if idx and idx[-1] == b:
            bars[-1][0], bars[-1][1], bars[-1][2] = max(bars[-1][0], s), min(bars[-1][1], s), s
        else:
            bars.append([s, s, s])
            idx.append(b)
    if len(bars) < MIN_BARS + 1:
        return None
    done = bars[:-1]
    trs = [max(b[0] - b[1], abs(b[0] - p[2]), abs(b[1] - p[2])) for p, b in zip(done, done[1:], strict=False)]
    trs = trs[-ATR_N:]
    return sum(trs) / len(trs) if len(trs) >= MIN_BARS - 1 else None


def _sig(kind: str, severity: str, extreme_i: int, now: float, extreme: float, run: float, atr: float, age: int, rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    high = kind == "pullback_from_high"
    drop = abs(extreme - now)
    side = "under the session high" if high else "over the session low"
    return {
        "id": kind, "direction": "bearish" if high else "bullish", "severity": severity,
        "title": ("Price is pulling back from the session high" if high else "Price is bouncing off the session low"),
        "evidence": [f"Spot {now:,.1f} is {drop:.0f} points ({drop / atr:.1f} ATR) {side} of {extreme:,.1f} reached {age} min ago",
                     f"the run into it was {run:.0f} points ({run / atr:.1f} ATR); 5-minute ATR {atr:.1f}"],
        "invalidation": "spot makes a new session high" if high else "spot makes a new session low",
        "drop_points": round(drop, 1), "drop_atr": round(drop / atr, 2), "run_atr": round(run / atr, 2), "minutes_since_extreme": age,
        "extreme": extreme, "extreme_at": rows[extreme_i].get("at"),
    }


def _raw_at(rows: Sequence[Mapping[str, Any]], i: int) -> dict[str, Any]:
    """One minute's flag before the persistence rule: {"signal": dict | None, "atr": float | None, "skipped": int}."""
    seen = [(j, s) for j in range(i + 1) if (s := _spot(rows[j])) is not None]
    skipped = i + 1 - len(seen)
    if i + 1 < MIN_ROWS or not seen or seen[-1][0] != i:
        return {"signal": None, "atr": None, "skipped": skipped}
    atr = atr_at(rows, i)
    if atr is None or atr <= 0:
        return {"signal": None, "atr": atr, "skipped": skipped}
    now = seen[-1][1]
    hi_j, hi = max(seen, key=lambda t: (t[1], -t[0]))  # the first time the high was made
    lo_j, lo = min(seen, key=lambda t: (t[1], t[0]))
    best: dict[str, Any] | None = None
    for kind, ext_j, ext in (("pullback_from_high", hi_j, hi), ("bounce_from_low", lo_j, lo)):
        high = kind == "pullback_from_high"
        age = i - ext_j
        move = (ext - now) if high else (now - ext)
        if age > PULL_WINDOW or move < PULL_ATR * atr:
            continue
        window = [s for j, s in seen if ext_j - RUN_LOOKBACK <= j <= ext_j]
        run = (ext - min(window)) if high else (max(window) - ext)
        if run < RUN_ATR * atr:
            continue
        sig = _sig(kind, "strong" if move >= STRONG_ATR * atr else "mild", ext_j, now, ext, run, atr, age, rows)
        if best is None or sig["drop_atr"] > best["drop_atr"]:
            best = sig
    return {"signal": best, "atr": atr, "skipped": skipped}


def assess_at(rows: Sequence[Mapping[str, Any]], end: int | None = None) -> dict[str, Any]:
    """The flag as of ``rows[end]`` (default the newest): ``signal`` is the persistent one or None; ``atr`` and ``skipped`` (minutes with no spot) are always reported."""
    i = len(rows) - 1 if end is None else end
    now = _raw_at(rows, i)
    out: dict[str, Any] = {"available": i + 1 >= MIN_ROWS and now["atr"] is not None, "signal": None, "atr": now["atr"], "skipped": now["skipped"],
                           "persistence": f"present in at least {PERSIST_MIN} of the last {PERSIST_WINDOW} minutes",
                           "note": "Price structure only: how far spot is from the session extreme, in ATRs. Provisional thresholds, not a forecast."}
    if now["signal"] is None:
        return out
    same = sum(1 for j in range(max(MIN_ROWS - 1, i - PERSIST_WINDOW + 1), i + 1) if (s := _raw_at(rows, j)["signal"]) is not None and s["id"] == now["signal"]["id"])
    if same >= PERSIST_MIN:
        out["signal"] = now["signal"]
    return out


def flags(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any] | None]:
    """The persistent flag at every row of the session (None where there is none), each from rows 0..i only."""
    return [assess_at(rows, i)["signal"] for i in range(len(rows))]


def replay(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Every minute's flag (id and severity or None), for calibration and tests."""
    return [{"at": r.get("at"), "spot": r.get("spot"), "id": None if s is None else s["id"], "severity": None if s is None else s["severity"]} for r, s in zip(rows, flags(rows), strict=True)]


def cap(score: float | None, flag: Mapping[str, Any] | None) -> tuple[float | None, dict[str, Any] | None]:
    """The verdict score after the turn cap, and why (None when not capped).

    Only a STRONG flag against the verdict caps it, and only to Neutral (score at most +-14): on the ten stored sessions a verdict that a mild flag opposed was still right
    62 % of the time (59 % overall), a verdict a strong flag opposed 44 % (73 minutes, a handful of independent turns: provisional). A score is never raised or flipped,
    and a Neutral or same-side verdict is untouched."""
    if score is None or flag is None or flag.get("severity") != "strong":
        return score, None
    bear = flag.get("direction") == "bearish"
    if (bear and score < NEUTRAL_CAP) or (not bear and score > -NEUTRAL_CAP):
        return score, None
    kind = "under the session high" if bear else "over the session low"
    capped = NEUTRAL_CAP - 1.0 if bear else -(NEUTRAL_CAP - 1.0)
    return capped, {"raw_score": round(score, 1), "capped_to": capped, "flag": flag["id"], "severity": flag["severity"], "drop_atr": flag["drop_atr"],
                    "reason": f"capped from {score:+.0f}: price is {flag['drop_points']:.0f} points ({flag['drop_atr']:.1f} ATR) {kind}"}
