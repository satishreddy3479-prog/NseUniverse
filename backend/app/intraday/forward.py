"""Forward check of the rules-based intraday sentiment (pure, no I/O).

Every minute the page stores a score *before* the rest of the day is known (the append-only ``scores`` ledger). This
module asks, afterwards, what NIFTY did next: for each stored score, the move over the following 15, 30 and 60 minutes
taken from the same stored spot path (no interpolation: a horizon needs a stored sample within 3 minutes before the
target time). Scores are grouped as bullish (>= +0.2), bearish (<= -0.2) and neutral, and each group's mean forward
move and share of up-moves are shown next to the same numbers for all scores.

This is a scoreboard, not a model: no probability is produced, and nothing is concluded before ``MIN_SESSIONS`` sessions.
Overlapping minutes are not independent, so the verdict counts sessions, never samples.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import Any

HORIZONS = (15, 30, 60)
SLACK_MIN = 3.0
BULL, BEAR = 0.2, -0.2
MIN_SESSIONS = 20


def _t(s: str) -> datetime:
    return datetime.fromisoformat(s)


def forward_returns(rows: Sequence[dict[str, Any]], horizon: int) -> list[float | None]:
    """Forward return in percent for each row of ONE session (oldest first), from rows after it only."""
    pts = [(_t(r["sample_utc"]), r["spot"]) for r in rows]
    out: list[float | None] = []
    j = 0
    for i, (t0, s0) in enumerate(pts):
        if s0 is None or not s0 > 0:
            out.append(None)
            continue
        target = t0 + timedelta(minutes=horizon)
        if pts[-1][0] < target - timedelta(minutes=SLACK_MIN):
            out.append(None)
            continue
        j = max(j, i + 1)
        best = None
        while j < len(pts) and pts[j][0] <= target:
            if pts[j][1] is not None:
                best = pts[j]
            j += 1
        j = max(i + 1, j - 1)  # the next row may need the last sample at or before its own target
        if best is None or best[0] < target - timedelta(minutes=SLACK_MIN):
            out.append(None)
        else:
            out.append((best[1] / s0 - 1) * 100)
    return out


def _group(score: float | None) -> str | None:
    if score is None or not math.isfinite(score):
        return None
    return "bullish" if score >= BULL else "bearish" if score <= BEAR else "neutral"


def score_forward(sessions: dict[str, Sequence[dict[str, Any]]]) -> dict[str, Any]:
    """``sessions`` maps a session date to its stored score rows (oldest first)."""
    horizons: dict[str, Any] = {}
    for h in HORIZONS:
        acc: dict[str, list[float]] = {"bullish": [], "neutral": [], "bearish": [], "all": []}
        seen: dict[str, set[str]] = {k: set() for k in acc}
        for sess, rows in sessions.items():
            fwd = forward_returns(rows, h)
            for r, f in zip(rows, fwd, strict=True):
                g = _group(r.get("score"))
                if g is None or f is None:
                    continue
                for k in (g, "all"):
                    acc[k].append(f)
                    seen[k].add(sess)
        horizons[str(h)] = {
            k: {"n": len(v), "sessions": len(seen[k]), "mean_fwd_pct": None if not v else round(sum(v) / len(v), 4),
                "share_up": None if not v else round(sum(1 for x in v if x > 0) / len(v), 4)}
            for k, v in acc.items()
        }
    n_sessions = sum(1 for rows in sessions.values() if any(r.get("score") is not None for r in rows))
    ok = n_sessions >= MIN_SESSIONS
    return {
        "sessions": n_sessions, "min_sessions": MIN_SESSIONS, "horizons": horizons,
        "conclusion": None if ok else f"no conclusion: {n_sessions} session(s) stored, {MIN_SESSIONS} needed",
        "note": "Scores were stored in real time before each outcome. Overlapping minutes are not independent: the gate counts sessions.",
    }  # fmt: skip
