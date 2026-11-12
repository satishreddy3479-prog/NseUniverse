"""Early-turn watch: what CHANGED in the last 15-30 minutes, read from the stored per-minute timeline only.

The fused score is a level: slow structural readings (OI walls, PCR) can hold it up while the flow engines have already turned, and a
slow 100-point fall never moves a threshold-crossing alert. This module compares smoothed readings now against the same readings 20 minutes
ago, per engine, and reports where the engines disagree or deteriorate together. It is a description of evidence, not a forecast: nothing here
is validated as predictive (the stored history is too short; see ``docs/decisions.md``), and every signal says what would invalidate it.
Pure functions over rows from ``IntelligenceStore.rows``; nothing is computed from raw feeds and no value is invented (a missing reading is skipped).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

SMOOTH = 5  # minutes averaged at each end, so one noisy minute cannot fire a signal
LOOKBACK = 20  # minutes between the two smoothed readings
FLOW_ENGINES = ("structure", "participation")  # the engines that move with traded flow; "positioning" reads standing OI levels
ENGINES = ("positioning", "orderflow", "volatility", "structure", "participation")
FLOW_DROP = 12.0  # points: smoothed change of each flow engine that counts as a turn
SCORE_DROP = 20.0  # points: smoothed change of the fused score that counts as a slide
BREADTH_DROP = 8.0  # points: smoothed change an engine needs to count as deteriorating (or improving)
BREADTH_MIN = 3  # engines that must agree
MIN_ROWS = LOOKBACK + SMOOTH + 1
OI_GAP_MIN_ROWS = 60  # minutes of recorded OI day-change totals before the gap signal can compare against 'typical'
OI_GAP_MULT = 2.0  # a 20-minute gap move this many times the day's median counts (provisional, untested)
PERSIST_WINDOW = 6  # a signal counts as active only when it was present in at least PERSIST_MIN of the last PERSIST_WINDOW minutes (no flicker)
PERSIST_MIN = 4
# breadth is context only: it flickers on both stored sessions, so it never sets the lean or the alert, it only supports the other signals


def _mean(vals: Sequence[float | None]) -> float | None:
    v = [x for x in vals if x is not None]
    return sum(v) / len(v) if v else None


def _series(rows: Sequence[Mapping[str, Any]], getter: Any) -> list[float | None]:
    out: list[float | None] = []
    for r in rows:
        try:
            v = getter(r)
        except (KeyError, TypeError):
            v = None
        out.append(None if v is None else float(v))
    return out


def smoothed_change(series: Sequence[float | None], end: int | None = None) -> tuple[float | None, float | None]:
    """(smoothed value now, change against ``LOOKBACK`` minutes earlier) for the point at index ``end`` (default: the last). None if either end has no reading."""
    i = len(series) - 1 if end is None else end
    if i - LOOKBACK - SMOOTH + 1 < 0:
        return None, None
    now = _mean(series[i - SMOOTH + 1: i + 1])
    then = _mean(series[i - LOOKBACK - SMOOTH + 1: i - LOOKBACK + 1])
    return now, (None if now is None or then is None else now - then)


def _sig(id_: str, direction: str, title: str, evidence: list[str], invalidation: str) -> dict[str, Any]:
    return {"id": id_, "direction": direction, "title": title, "evidence": evidence, "invalidation": invalidation}


def _raw_at(rows: Sequence[Mapping[str, Any]], end: int | None = None) -> dict[str, Any]:
    """One minute's signals before the persistence rule."""
    i = len(rows) - 1 if end is None else end
    if i + 1 < MIN_ROWS:
        return {"available": False, "reason": f"needs {MIN_ROWS} stored minutes of this session; {max(0, i + 1)} so far", "signals": [], "changes": {}}
    eng = {k: smoothed_change(_series(rows, lambda r, k=k: r["engines"].get(k)), i) for k in ENGINES}
    score = smoothed_change(_series(rows, lambda r: r["score"]), i)
    spot = _series(rows, lambda r: r["spot"])
    sp_now, sp_chg = smoothed_change(spot, i)
    sp_pct = None if sp_now is None or sp_chg is None or sp_now - sp_chg == 0 else sp_chg / (sp_now - sp_chg) * 100
    changes = {"score": {"now": score[0], "change": score[1]}, **{k: {"now": v[0], "change": v[1]} for k, v in eng.items()},
               "spot": {"now": sp_now, "change": sp_chg, "change_pct": sp_pct}, "lookback_min": LOOKBACK}
    sigs: list[dict[str, Any]] = []
    price_txt = "" if sp_pct is None else f"; NIFTY itself {sp_pct:+.2f}% over the same {LOOKBACK} min"

    fcm = [eng[k][1] for k in FLOW_ENGINES]
    if all(c is not None for c in fcm):
        fc = [float(c) for c in fcm if c is not None]
        lv = eng["positioning"][0]
        if all(c <= -FLOW_DROP for c in fc):
            held = lv is not None and lv > 0
            sigs.append(_sig("flow_turn_down", "bearish", "Traded flow is turning down" + (" while OI levels still look bullish" if held else ""),
                             [f"Structure {fc[0]:+.0f} and Participation {fc[1]:+.0f} points in {LOOKBACK} min" + price_txt] + ([f"Positioning (OI levels) still {lv:+.0f}"] if held else []),
                             "both flow engines recover above their reading from 20 minutes ago"))
        elif all(c >= FLOW_DROP for c in fc):
            held = lv is not None and lv < 0
            sigs.append(_sig("flow_turn_up", "bullish", "Traded flow is turning up" + (" while OI levels still look bearish" if held else ""),
                             [f"Structure {fc[0]:+.0f} and Participation {fc[1]:+.0f} points in {LOOKBACK} min" + price_txt] + ([f"Positioning (OI levels) still {lv:+.0f}"] if held else []),
                             "both flow engines fall back below their reading from 20 minutes ago"))
    s_chg = score[1]
    if s_chg is not None and abs(s_chg) >= SCORE_DROP:
        d = "bearish" if s_chg < 0 else "bullish"
        sigs.append(_sig(f"score_slide_{'down' if s_chg < 0 else 'up'}", d, f"Fused score sliding {'down' if s_chg < 0 else 'up'}", [f"Score {s_chg:+.0f} points in {LOOKBACK} min (now {score[0]:+.0f})" + price_txt],
                         "the score moves back over half of that change"))
    chg = {k: v[1] for k, v in eng.items() if v[1] is not None}
    down = [k for k, c in chg.items() if c <= -BREADTH_DROP]
    up = [k for k, c in chg.items() if c >= BREADTH_DROP]
    if len(down) >= BREADTH_MIN:
        sigs.append(_sig("breadth_down", "bearish", f"{len(down)} of {len(ENGINES)} engines deteriorating together", [", ".join(f"{k} {chg[k]:+.0f}" for k in down) + price_txt], "fewer than three engines keep falling"))
    elif len(up) >= BREADTH_MIN:
        sigs.append(_sig("breadth_up", "bullish", f"{len(up)} of {len(ENGINES)} engines improving together", [", ".join(f"{k} {chg[k]:+.0f}" for k in up) + price_txt], "fewer than three engines keep rising"))
    gap = _series(rows, lambda r: r["metrics"]["pe_oi_chg"] - r["metrics"]["ce_oi_chg"])
    g_now, g_chg = smoothed_change(gap, i)
    if g_chg is not None and g_now is not None and sum(v is not None for v in gap[: i + 1]) >= OI_GAP_MIN_ROWS:
        past = [c for j in range(MIN_ROWS - 1, i + 1) if (c := smoothed_change(gap, j)[1]) is not None]
        typical = sorted(abs(c) for c in past)[len(past) // 2] if past else 0.0
        changes["oi_gap"] = {"now": g_now, "change": g_chg}
        if typical > 0 and abs(g_chg) >= OI_GAP_MULT * typical:
            dn = g_chg < 0
            sigs.append(_sig("breadth_oi_gap_" + ("down" if dn else "up"), "bearish" if dn else "bullish",
                             f"Put minus call open-interest change {'falling' if dn else 'rising'} faster than usual today",
                             [f"Gap (put OI day change minus call OI day change) {g_chg:+,.0f} contracts in {LOOKBACK} min, {abs(g_chg) / typical:.1f}x today's typical 20-minute move" + price_txt,
                              "uncalibrated: no stored history yet to test it, so it supports the other signals and never sets the lean or an alert"],
                             "the gap's 20-minute change falls back inside its typical range"))
    # the same signals while price has barely moved are the early ones: say so
    early = sp_pct is not None and abs(sp_pct) < 0.15
    for s in sigs:
        s["early"] = bool(early)
    bear, bull = (sum(s["direction"] == d and not s["id"].startswith("breadth") for s in sigs) for d in ("bearish", "bullish"))
    lean = "bearish" if bear > bull else "bullish" if bull > bear else ("mixed" if bear else "none")
    return {"available": True, "signals": sigs, "lean": lean, "strength": max(bear, bull), "changes": changes}


def assess_at(rows: Sequence[Mapping[str, Any]], end: int | None = None) -> dict[str, Any]:
    """The turn assessment as of ``rows[end]`` (default: the newest stored minute); ``rows`` are oldest first. A signal is reported only when it persisted."""
    i = len(rows) - 1 if end is None else end
    now = _raw_at(rows, i)
    if not now["available"]:
        return now
    seen: dict[str, int] = {}
    for j in range(max(MIN_ROWS - 1, i - PERSIST_WINDOW + 1), i + 1):
        for s in _raw_at(rows, j)["signals"]:
            seen[s["id"]] = seen.get(s["id"], 0) + 1
    latest = {s["id"]: s for s in now["signals"]}
    sigs = [latest[k] for k in latest if seen.get(k, 0) >= PERSIST_MIN]
    bear, bull = (sum(s["direction"] == d and not s["id"].startswith("breadth") for s in sigs) for d in ("bearish", "bullish"))
    lean = "bearish" if bear > bull else "bullish" if bull > bear else ("mixed" if bear else "none")
    return {**now, "signals": sigs, "lean": lean, "strength": max(bear, bull), "persistence": f"present in at least {PERSIST_MIN} of the last {PERSIST_WINDOW} minutes",
            "note": "Compares the last 5 minutes with the same 5-minute average 20 minutes earlier. Evidence of change, not a forecast; thresholds are provisional."}


def replay(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Every minute's assessment, to see when each signal switched on (used by the tests and the calibration notes)."""
    return [{"at": rows[i]["at"], "spot": rows[i]["spot"], **{k: v for k, v in assess_at(rows, i).items() if k in ("lean", "strength", "signals")}} for i in range(len(rows))]
