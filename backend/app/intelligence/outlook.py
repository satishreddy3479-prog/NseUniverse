"""The day outlook of the market-intelligence dashboard: sentiment through the day and what the evidence says to expect (pure functions, no I/O).

"Expected outcome" is deliberately NOT a forecast and not a probability model. It is made of four honest parts:

1. The size of the move the options market prices for each horizon (one standard deviation from the at-the-money implied volatility: spot x IV x sqrt(minutes / (252 x 375))),
   shown as a band around spot. Under the random-walk model behind that formula about 68 % of outcomes fall inside it; it carries no direction.
2. The lean of the fused sentiment (a call only when the score is outside +-15 and the evidence quality is at least 35), with the levels that would confirm or invalidate it.
3. What followed in the stored sessions when the verdict was in the same class: the share of snapshots after which price was higher, lower or flat, with a Wilson 95 % interval. The
   snapshots of one session overlap (one a minute), so these counts overstate how much independent evidence there is; the number of sessions is shown beside them.
4. A scorecard of today's own calls against what price then did, and the out-of-sample record of the verdict, with a plain grade of how established that record is.

History is re-scored with today's weights (a group missing from an old row is left out and the rest renormalised, exactly as the live fusion does), so old and new rows share one
definition of the verdict.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from statistics import median
from typing import Any

from app.intelligence import fusion as fz
from app.intelligence import validation as val

IST = timezone(timedelta(hours=5, minutes=30))
OPEN_MIN, CLOSE_MIN = 9 * 60 + 15, 15 * 60 + 30
#: the phases of the session in IST minutes: the opening hour (opening range and initial balance), then the usual daily rhythm
PHASES: list[tuple[str, int, int]] = [("Opening hour", 555, 615), ("Morning", 615, 720), ("Midday", 720, 810), ("Afternoon", 810, 885), ("Closing", 885, 930)]
HORIZON_MIN = (15, 30, 60)
LEAN_MIN_SCORE = val.NEUTRAL_BAND
LEAN_MIN_QUALITY = 35.0
MIN_DECIDED = val.MIN_SAMPLES
ESTABLISHED_SESSIONS = 20
MAX_PATH_POINTS = 240


def _num(x: Any) -> float | None:
    return float(x) if isinstance(x, (int, float)) and math.isfinite(x) else None


def _when(r: Mapping[str, Any]) -> datetime | None:
    try:
        return datetime.fromisoformat(str(r.get("at")))
    except (TypeError, ValueError):
        return None


def _ist_min(t: datetime) -> int:
    t = t.astimezone(IST)
    return t.hour * 60 + t.minute


def sigma_points(spot: float | None, iv_pct: float | None, minutes: float) -> float | None:
    """One standard deviation of the move over ``minutes`` of trading time, in points: spot x IV x sqrt(minutes / (252 x 375))."""
    if not spot or iv_pct is None or minutes <= 0:
        return None
    return spot * (iv_pct / 100.0) * math.sqrt(minutes / (252.0 * 375.0))


def lean(score: float | None, quality: float | None) -> dict[str, Any]:
    """A call only when the score is outside +-15 and the evidence quality (not a probability) is at least 35."""
    if score is None:
        return {"call": 0, "text": "no verdict: not enough evidence", "why": "insufficient data"}
    if abs(score) < LEAN_MIN_SCORE:
        return {"call": 0, "text": "no lean", "why": f"score {score:+.0f} is inside +-{LEAN_MIN_SCORE:.0f}"}
    if quality is None or quality < LEAN_MIN_QUALITY:
        return {"call": 0, "text": "no lean", "why": f"evidence quality {0 if quality is None else quality:.0f} is under {LEAN_MIN_QUALITY:.0f}: the groups disagree or the data is thin"}
    return {"call": 1 if score > 0 else -1, "text": "leans up" if score > 0 else "leans down", "why": f"score {score:+.0f} with evidence quality {quality:.0f}"}


# ------------------------------------------------------------------------------------------------ sentiment through the day
def path(rows: Sequence[Mapping[str, Any]], weights: Mapping[str, float]) -> list[dict[str, Any]]:
    """The recorded minutes of the session as chart points: time, spot, the verdict re-scored with today's weights, confidence and the trend reading (when it was recorded)."""
    keep = list(rows)
    if len(keep) > MAX_PATH_POINTS:
        step = math.ceil(len(keep) / MAX_PATH_POINTS)
        keep = [r for i, r in enumerate(keep) if i % step == 0 or i == len(keep) - 1]
    out = []
    for r in keep:
        m = r.get("metrics") or {}
        tr = m.get("trend") or {}
        eng = r.get("engines") or {}
        out.append({"at": r.get("at"), "spot": _num(r.get("spot")), "score": _round(val.rescore(r, weights)), "confidence": _num(r.get("confidence")),
                    "trend_score": _num(tr.get("score")), "trend_label": tr.get("label"), "trend_group": _round(_num(eng.get("trend")))})
    return out


def _round(x: float | None, n: int = 1) -> float | None:
    return None if x is None else round(x, n)


def phases(rows: Sequence[Mapping[str, Any]], weights: Mapping[str, float], *, now: datetime, live: bool, spot: float | None, iv_pct: float | None) -> list[dict[str, Any]]:
    """The session in five phases. A finished or running phase: the mean verdict, how price moved and the dominant trend label. A phase still to come: the move the options market prices for it."""
    now_min = _ist_min(now) if live else CLOSE_MIN + 1
    out: list[dict[str, Any]] = []
    for name, a, b in PHASES:
        state = "past" if now_min >= b else "now" if now_min >= a else "future"
        inside = [r for r in rows if (t := _when(r)) is not None and a <= _ist_min(t) < b]
        item: dict[str, Any] = {"name": name, "from": f"{a // 60:02d}:{a % 60:02d}", "to": f"{b // 60:02d}:{b % 60:02d}", "state": state, "minutes": b - a}
        scores = [s for r in inside if (s := val.rescore(r, weights)) is not None]
        spots = [s for r in inside if (s := _num(r.get("spot"))) is not None]
        labels = [(r.get("metrics") or {}).get("trend", {}).get("label") for r in inside]
        labels = [x for x in labels if x]
        if state != "future" and inside:
            mean = sum(scores) / len(scores) if scores else None
            item.update({"rows": len(inside), "mean_score": _round(mean), "class": fz.classify(mean) if mean is not None else None, "last_score": _round(scores[-1]) if scores else None,
                         "move_pct": None if len(spots) < 2 else round((spots[-1] / spots[0] - 1) * 100, 3), "high": max(spots) if spots else None, "low": min(spots) if spots else None,
                         "trend": Counter(labels).most_common(1)[0][0] if labels else None})
        elif state != "future":
            item.update({"rows": 0, "note": "no minutes were recorded in this phase"})
        if state in ("now", "future"):
            left = (b - max(a, now_min)) if state == "now" else (b - a)
            sd = sigma_points(spot, iv_pct, left)
            item.update({"expected_sd_points": None if sd is None else round(sd, 1), "expected_minutes": left})
        out.append(item)
    return out


# ------------------------------------------------------------------------------------------------ what followed in the stored sessions
def _bucket(forwards: Sequence[float]) -> dict[str, Any]:
    decided = [f for f in forwards if abs(f) >= val.FLAT_BAND_PCT]
    up = sum(1 for f in decided if f > 0)
    n = len(decided)
    ci = val.wilson(up, n) if n else None
    return {"n": len(forwards), "decided": n, "flat": len(forwards) - n, "up": up, "down": n - up, "up_share": None if n < MIN_DECIDED else round(up / n, 4),
            "up_ci95": None if n < MIN_DECIDED or ci is None else [round(ci[0], 4), round(ci[1], 4)], "mean_pct": None if not forwards else round(sum(forwards) / len(forwards), 4),
            "median_pct": None if not forwards else round(median(forwards), 4)}


def history(rows: Sequence[Mapping[str, Any]], weights: Mapping[str, float]) -> dict[str, Any]:
    """For each verdict class and each horizon, how price moved afterwards in the stored sessions (chronological, no look-ahead: a forward move is read only from later rows)."""
    classes: dict[str, dict[str, list[float]]] = {}
    sessions: dict[str, set[str]] = {}
    for h, minutes in (("15m", 15), ("30m", 30), ("60m", 60)):
        for o in val.outcomes(rows, h):
            if o["forward_pct"] is None:
                continue
            s = val.rescore(o["row"], weights)
            if s is None:
                continue
            cls = fz.classify(s)
            classes.setdefault(cls, {}).setdefault(str(minutes), []).append(float(o["forward_pct"]))
            sessions.setdefault(cls, set()).add(str(o["session"]))
    out: dict[str, Any] = {}
    for cls, by_h in classes.items():
        out[cls] = {"sessions": len(sessions[cls]), "horizons": {m: _bucket(v) for m, v in sorted(by_h.items(), key=lambda kv: int(kv[0]))}}
    return {"by_class": out, "sessions": len({str(r.get("session")) for r in rows}), "snapshots": len(rows), "flat_band_pct": val.FLAT_BAND_PCT, "min_decided": MIN_DECIDED,
            "caution": "Snapshots of one session overlap (one a minute), so these counts overstate how much independent evidence there is: read the number of sessions, not the number of snapshots. "
                       "Measured on the stored sessions only; not evidence of future accuracy."}


def scorecard(rows: Sequence[Mapping[str, Any]], weights: Mapping[str, float], *, step_min: int = 15, horizon: str = "30m") -> dict[str, Any]:
    """Today's own calls against what price then did: one row every ``step_min`` minutes, the verdict then and the move over the next 30 minutes (pending until the 30 minutes have passed)."""
    outs = val.outcomes(rows, horizon)
    keep: list[dict[str, Any]] = []
    last_t: datetime | None = None
    for o in outs:
        t = _when(o["row"])
        if t is None or (last_t is not None and (t - last_t).total_seconds() < step_min * 60):
            continue
        last_t = t
        score = val.rescore(o["row"], weights)
        call = 0 if score is None or abs(score) < LEAN_MIN_SCORE else (1 if score > 0 else -1)
        f = o["forward_pct"]
        if score is None:
            res = "no verdict"
        elif call == 0:
            res = "no call"
        elif f is None:
            res = "pending"
        elif abs(f) < val.FLAT_BAND_PCT:
            res = "flat"
        else:
            res = "hit" if (f > 0) == (call > 0) else "miss"
        keep.append({"at": o["at"], "spot": _num(o["row"].get("spot")), "score": _round(score), "class": fz.classify(score) if score is not None else None, "call": call, "forward_pct": f, "result": res})
    hits, misses = sum(1 for k in keep if k["result"] == "hit"), sum(1 for k in keep if k["result"] == "miss")
    return {"horizon_minutes": 30, "step_minutes": step_min, "rows": keep, "hits": hits, "misses": misses, "decided": hits + misses,
            "note": "A hit is a price move in the direction of the call (a call needs a score outside +-15); flat moves under 0.02 % and minutes with no call are not counted."}


def reliability(report: Mapping[str, Any] | None) -> dict[str, Any]:
    """A plain grade of how established the verdict's record is, from the stored validation (30-minute horizon): the pooled out-of-sample hit rate and its range, how many test sessions,
    and how many of them were above 50 %. 'Established' needs at least 20 test sessions; with fewer the record is early and says so."""
    if not report:
        return {"grade": "Not measured", "text": "the validation could not be read", "sessions": 0}
    wf = (report.get("walk_forward") or {}).get("30m") or {}
    folds = [f for f in wf.get("folds") or [] if isinstance(f.get("hit_rate"), (int, float))]
    pooled = wf.get("pooled_out_of_sample") or {}
    n_sessions = len(wf.get("folds") or [])
    above = sum(1 for f in folds if f["hit_rate"] > 0.5)
    rate, ci = pooled.get("hit_rate"), pooled.get("hit_rate_ci95")
    lo = ci[0] if isinstance(ci, (list, tuple)) and ci else rate
    if rate is None:
        grade, text = "Not established", "too few decided calls out of sample to report a hit rate"
    elif n_sessions < ESTABLISHED_SESSIONS:
        grade = "Early"
        text = (f"out of sample over {n_sessions} test sessions the 30-minute lean was right in {rate:.0%} of decided calls ({lo:.0%} or more by the pooled range), "
                f"and {above} of {len(folds)} sessions were above 50 %; with fewer than {ESTABLISHED_SESSIONS} sessions this is early evidence, not an established record")
    else:
        grade = "Established" if lo is not None and lo > 0.5 and above / max(1, len(folds)) >= 0.6 else "Not established"
        text = f"over {n_sessions} out-of-sample sessions: {rate:.0%} right ({above} of {len(folds)} sessions above 50 %)"
    return {"grade": grade, "text": text, "sessions": n_sessions, "hit_rate": rate, "hit_rate_ci95": ci, "sessions_above_50": above, "session_rates": [{"session": f.get("test_session"), "hit_rate": f["hit_rate"], "decided": f.get("decided")} for f in folds],
            "note": "Overlapping snapshots make the pooled range narrower than it should be; the per-session rates show the real spread."}


# ------------------------------------------------------------------------------------------------ levels and the plain reading
def levels(spot: float | None, trend: Mapping[str, Any] | None, gex: Mapping[str, Any] | None, atr: float | None) -> list[dict[str, Any]]:
    """The prices that would confirm or invalidate a lean, nearest first: the opening range, the session mean, the gamma flip and the walls."""
    items: list[tuple[str, float | None, str]] = []
    orr = (trend or {}).get("opening_range") if isinstance(trend, Mapping) else None
    if isinstance(orr, Mapping):
        items += [("Opening-range high", _num(orr.get("high")), "a close above it is a breakout; back inside it is a failed one"), ("Opening-range low", _num(orr.get("low")), "a close below it is a breakdown; back inside it is a failed one")]
    if isinstance(trend, Mapping):
        items.append(("Session mean", _num(trend.get("session_mean")), "price above it all session reads as strength, below it as weakness"))
    if isinstance(gex, Mapping):
        items += [("Gamma flip", _num(gex.get("flip")), "above it hedging tends to calm moves, below it to amplify them (model)"), ("Call wall", _num(gex.get("call_wall")), "the strike with the largest call gamma: a ceiling or a magnet"),
                  ("Put wall", _num(gex.get("put_wall")), "the strike with the largest put gamma: a floor or a magnet")]
    out = []
    for name, px, meaning in items:
        if px is None:
            continue
        d = None if spot is None else px - spot
        out.append({"name": name, "price": round(px, 2), "distance_points": None if d is None else round(d, 1), "distance_atr": None if d is None or not atr else round(d / atr, 2), "side": None if d is None else ("above" if d > 0 else "below" if d < 0 else "at"), "meaning": meaning})
    return sorted(out, key=lambda x: abs(x["distance_points"]) if x["distance_points"] is not None else 1e9)


def read_lines(now: Mapping[str, Any], expected: Sequence[Mapping[str, Any]], hist: Mapping[str, Any], rel: Mapping[str, Any], sc: Mapping[str, Any]) -> list[str]:
    """The reading in plain sentences, every one built from a number on the page."""
    out: list[str] = []
    s = now.get("score")
    if s is None:
        return ["There is not enough evidence for a verdict right now: " + str(now.get("reason") or "too few groups are available") + "."]
    out.append(f"Sentiment is {now['class']} ({s:+.0f}) with evidence quality {now.get('confidence') or 0:.0f}/100; {now.get('groups_bullish', 0):.0%} of the weight is bullish and {now.get('groups_bearish', 0):.0%} bearish.")
    tr = now.get("trend")
    if tr and tr.get("label"):
        out.append(f"The session regime is {tr['label']} (trend score {round((tr.get('score') or 0) * 100)}/100).")
    ln = now.get("lean") or {}
    e30 = next((e for e in expected if e["minutes"] == 30), None)
    if e30 and e30.get("sd_points") is not None:
        out.append(f"The options market prices about ±{e30['sd_points']:.0f} points over the next 30 minutes (one standard deviation, no direction); the verdict {ln.get('text', 'has no lean')} ({ln.get('why', '')}).")
    cls = now.get("class")
    h = ((hist.get("by_class") or {}).get(cls) or {}).get("horizons", {}).get("30")
    if h and h.get("up_share") is not None:
        lo, hi = h["up_ci95"]
        out.append(f"In the stored sessions, after a {cls} verdict price was higher 30 minutes later in {h['up_share']:.0%} of {h['decided']} decided snapshots (range {lo:.0%} to {hi:.0%}, {(hist['by_class'][cls]['sessions'])} sessions; the snapshots overlap).")
    elif cls:
        out.append(f"There are too few stored snapshots after a {cls} verdict to say what usually followed.")
    out.append(f"Record of the verdict: {rel.get('grade', 'Not measured')}. {rel.get('text', '')}.")
    if sc.get("decided"):
        out.append(f"Today so far: {sc['hits']} of {sc['decided']} decided 30-minute calls were right.")
    return out


# ------------------------------------------------------------------------------------------------ assembly
def build(*, now: datetime, session: str, live: bool, rows: Sequence[Mapping[str, Any]], history_rows: Sequence[Mapping[str, Any]], weights: Mapping[str, float], summary: Mapping[str, Any],
          trend: Mapping[str, Any] | None, validation_report: Mapping[str, Any] | None) -> dict[str, Any]:
    sent = summary.get("sentiment") or {}
    pulse = summary.get("pulse") or {}
    spot = _num(pulse.get("spot"))
    iv = _num(pulse.get("atm_iv"))
    score, conf = _num(sent.get("score")), _num(sent.get("confidence"))
    minutes_left = max(1.0, CLOSE_MIN - _ist_min(now)) if live else 0.0
    horizons = []
    for m in HORIZON_MIN:
        sd = sigma_points(spot, iv, m) if live else None
        horizons.append({"minutes": m, "label": f"Next {m} minutes", "sd_points": None if sd is None else round(sd, 1), "low": None if sd is None or spot is None else round(spot - sd, 1), "high": None if sd is None or spot is None else round(spot + sd, 1)})
    sd_close = sigma_points(spot, iv, minutes_left) if live else None
    horizons.append({"minutes": round(minutes_left), "label": "To the close", "sd_points": None if sd_close is None else round(sd_close, 1), "low": None if sd_close is None or spot is None else round(spot - sd_close, 1),
                     "high": None if sd_close is None or spot is None else round(spot + sd_close, 1)})
    hist = history(history_rows, weights)
    rel = reliability(validation_report)
    sc = scorecard(rows, weights)
    tr = trend if isinstance(trend, Mapping) and trend.get("available") else None
    now_view: dict[str, Any] = {"score": score, "class": sent.get("class"), "confidence": conf, "groups_bullish": _num(sent.get("groups_bullish")), "groups_bearish": _num(sent.get("groups_bearish")),
                                "coverage": _num(sent.get("coverage")), "reason": sent.get("reason"), "lean": lean(score, conf), "regime": (summary.get("regime") or {}).get("name"),
                                "trend": None if tr is None else {"label": tr.get("label"), "score": tr.get("score"), "direction": tr.get("direction"), "agreement": tr.get("agreement"), "session_mean": tr.get("session_mean"), "from_mean_atr": tr.get("from_mean_atr")}}
    atr = _num((tr or {}).get("atr"))
    return {
        "generated_at": now.isoformat(timespec="seconds"), "session": session, "live": live, "spot": spot, "atm_iv": iv, "now": now_view,
        "path": path(rows, weights), "phases": phases(rows, weights, now=now, live=live, spot=spot, iv_pct=iv), "expected": horizons, "levels": levels(spot, tr, summary.get("gex"), atr),
        "history": hist, "scorecard": sc, "reliability": rel, "read": read_lines(now_view, horizons, hist, rel, sc),
        "limits": ["Descriptive evidence, not a forecast: no model here predicts price.", "The bands are one standard deviation of a random walk with the option-implied volatility; they carry no direction.",
                   "History is re-scored with today's provisional weights and overlaps (one snapshot a minute); read the number of sessions.", "A group with no data is left out, never scored neutral."],
    }
