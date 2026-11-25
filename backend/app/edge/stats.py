"""Does an indicator have an edge? The statistics behind the Edge monitor (pure functions over stored calls, no I/O).

An indicator's hit rate means nothing alone: in a month when NIFTY rose on 15 of 18 days "always buy" is right about 55-60 % of the time. So each hit rate is compared with two baselines
computed from the same stored windows: (1) the market-wide drift: the hit rate a coin with the same long / short mix would have, given how often price went up over ALL stored sessions
("edge over drift"); (2) the same-day drift: the same, but with each day's own up share ("timing edge": being right about WHEN within a day, not only about the day). A "calm" call (the
straddle seller score) is compared with how often that hour of the day was calm anyway. Sessions, not minutes, are the unit of evidence (minutes of one day overlap): the interval is a
bootstrap over sessions. No label is "Edge" before ``MIN_SESSIONS`` sessions and ``MIN_CALLS`` decided calls, whatever the numbers say.
"""

from __future__ import annotations

import random
from collections import defaultdict
from collections.abc import Mapping, Sequence
from typing import Any

from app.edge.calls import HORIZONS, INDICATORS, ist_minute

MIN_SESSIONS = 20
MIN_CALLS = 100
BOOT = 2000
PRIMARY = 30  # the horizon the status label is read from
RECENT = 8  # sessions in the "lately" comparison


def _share(wins: Sequence[Mapping[str, Any]], calm: bool = False) -> float | None:
    if calm:
        n = sum(w["n"] for w in wins)
        return None if n == 0 else sum(w["calm"] for w in wins) / n
    up, down = sum(w["up"] for w in wins), sum(w["down"] for w in wins)
    return None if up + down == 0 else up / (up + down)


class _Base:
    """Baselines of one horizon: pooled and per-session up shares, and calm shares by hour."""

    def __init__(self, windows: Sequence[Mapping[str, Any]], horizon: int) -> None:
        ws = [w for w in windows if w["horizon"] == horizon]
        self.up_all = _share(ws)
        self.by_session: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
        self.by_hour: dict[int, list[Mapping[str, Any]]] = defaultdict(list)
        for w in ws:
            self.by_session[w["session"]].append(w)
            self.by_hour[w["hour"]].append(w)
        self.calm_all = _share(ws, calm=True)

    def expected(self, kind: str, call: Mapping[str, Any]) -> tuple[float | None, float | None]:
        """(drift baseline, same-day baseline) probability that this call is a hit by luck."""
        if kind == "calm":
            m = ist_minute(call["at"])
            hour = None if m is None else m // 60
            drift = _share(self.by_hour.get(hour, []), calm=True) if hour is not None else None
            return drift, _share(self.by_session.get(call["session"], []), calm=True)
        up_s = _share(self.by_session.get(call["session"], []))
        if call["side"] > 0:
            return self.up_all, up_s
        return (None if self.up_all is None else 1 - self.up_all), (None if up_s is None else 1 - up_s)


def _edges(calls: Sequence[Mapping[str, Any]], base: _Base, kind: str) -> dict[str, Any]:
    """Pooled figures over the decided calls given (all sessions, or a bootstrap resample)."""
    hits = n = 0
    ed: list[float] = []
    et: list[float] = []
    for c in calls:
        if c["result"] not in ("hit", "miss"):
            continue
        d, t = base.expected(kind, c)
        hit = c["result"] == "hit"
        n += 1
        hits += hit
        if d is not None:
            ed.append(hit - d)
        if t is not None:
            et.append(hit - t)
    return {"n": n, "hits": hits, "hit_rate": None if n == 0 else hits / n, "edge_drift": None if not ed else sum(ed) / len(ed), "edge_timing": None if not et else sum(et) / len(et)}


def _ci(vals: list[float]) -> list[float] | None:
    if len(vals) < 50:
        return None
    vals.sort()
    return [round(vals[int(0.025 * len(vals))], 4), round(vals[int(0.975 * len(vals)) - 1], 4)]


def _core(indicator: str, horizon: int, mine: Sequence[Mapping[str, Any]], base: _Base, seed: int) -> dict[str, Any]:
    kind = INDICATORS[indicator]["kind"]
    tot = _edges(mine, base, kind)
    by_s: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for c in mine:
        by_s[c["session"]].append(c)
    sessions = sorted(s for s, v in by_s.items() if any(c["result"] in ("hit", "miss") for c in v))
    rng = random.Random(seed)  # noqa: S311 - a bootstrap resample, not a secret
    bd: list[float] = []
    bt: list[float] = []
    if len(sessions) >= 3:
        for _ in range(BOOT):
            pick = [rng.choice(sessions) for _ in sessions]
            e = _edges([c for s in pick for c in by_s[s]], base, kind)
            if e["edge_drift"] is not None:
                bd.append(e["edge_drift"])
            if e["edge_timing"] is not None:
                bt.append(e["edge_timing"])
    out: dict[str, Any] = {"horizon": horizon, "sessions": len(sessions), "calls": tot["n"], "hits": tot["hits"], "hit_rate": _r(tot["hit_rate"]), "edge_drift": _r(tot["edge_drift"]),
                           "edge_drift_ci": _ci(bd), "edge_timing": _r(tot["edge_timing"]), "edge_timing_ci": _ci(bt),
                           "baseline_drift": None if tot["hit_rate"] is None or tot["edge_drift"] is None else _r(tot["hit_rate"] - tot["edge_drift"])}
    recent = sessions[-RECENT:]
    if len(recent) >= 3 and len(recent) < len(sessions):
        r = _edges([c for s in recent for c in by_s[s]], base, kind)
        out["recent"] = {"sessions": len(recent), "calls": r["n"], "hit_rate": _r(r["hit_rate"]), "edge_drift": _r(r["edge_drift"])}
    out["series"] = _series(sessions, by_s, base, kind)
    return out


def summarise_one(indicator: str, horizon: int, calls: Sequence[Mapping[str, Any]], windows: Sequence[Mapping[str, Any]], *, seed: int = 20261125) -> dict[str, Any]:
    """All stored sessions, and (for an indicator whose rule was found or tuned on stored data) the fresh sessions after that date, which alone decide the label."""
    mine = [c for c in calls if c["indicator"] == indicator and c["horizon"] == horizon]
    base = _Base(windows, horizon)
    out = _core(indicator, horizon, mine, base, seed)
    tuned = INDICATORS[indicator].get("tuned_through")
    if tuned:
        fresh = _core(indicator, horizon, [c for c in mine if c["session"] > tuned], base, seed)
        fresh["status"], fresh["status_text"] = status(fresh)
        out["fresh"], out["tuned_through"] = fresh, tuned
        out["status"] = fresh["status"]
        out["status_text"] = (f"Found in the sessions up to {tuned}, so those cannot prove it. " + fresh["status_text"]) if fresh["sessions"] < MIN_SESSIONS else fresh["status_text"]
        out["in_sample_text"] = f"In the sessions it was found in ({out['sessions']}): {_pts(out['edge_drift'])} over luck. Not evidence."
    else:
        out["status"], out["status_text"] = status(out)
    return out


def _pts(x: float | None) -> str:
    return "no figure" if x is None else f"{x * 100:+.1f} points"


def _r(x: float | None) -> float | None:
    return None if x is None else round(x, 4)


def _series(sessions: Sequence[str], by_s: Mapping[str, Sequence[Mapping[str, Any]]], base: _Base, kind: str) -> list[dict[str, Any]]:
    """Session by session: that day's own figures and the running totals (this is the picture of an edge appearing, or not)."""
    out = []
    acc: list[Mapping[str, Any]] = []
    for s in sessions:
        acc += by_s[s]
        day, cum = _edges(by_s[s], base, kind), _edges(acc, base, kind)
        out.append({"session": s, "calls": day["n"], "hit_rate": _r(day["hit_rate"]), "edge_drift": _r(day["edge_drift"]), "cum_calls": cum["n"], "cum_hit_rate": _r(cum["hit_rate"]),
                    "cum_baseline": None if cum["hit_rate"] is None or cum["edge_drift"] is None else _r(cum["hit_rate"] - cum["edge_drift"])})
    return out


def status(s: Mapping[str, Any]) -> tuple[str, str]:
    """The label and one plain sentence. 'Edge' needs MIN_SESSIONS sessions and MIN_CALLS calls and an interval that stays above zero."""
    n, ns = s["calls"], s["sessions"]
    d, ci = s["edge_drift"], s["edge_drift_ci"]
    if n == 0 or d is None:
        return "too_early", f"0 of {MIN_SESSIONS} sessions scored yet."
    if ns < MIN_SESSIONS or n < MIN_CALLS:
        lean = "above" if d > 0 else "below"
        return "too_early", f"{ns} of {MIN_SESSIONS} sessions needed ({n} decided calls, {MIN_CALLS} needed): {abs(d) * 100:.1f} points {lean} luck so far, which is not yet evidence either way."
    if ci is None:
        return "too_early", "Not enough sessions to put an interval on it."
    tci = s["edge_timing_ci"]
    if ci[0] > 0:
        if tci is not None and tci[0] > 0:
            return "timing_edge", f"{d * 100:+.1f} points over the market drift (interval {ci[0] * 100:+.1f} to {ci[1] * 100:+.1f}) and over the same day's own drift: it times moves within the day."
        return "edge", f"{d * 100:+.1f} points over the market drift (interval {ci[0] * 100:+.1f} to {ci[1] * 100:+.1f}), but not over each day's own drift: it reads the day's direction, not the timing."
    if ci[1] < 0:
        return "worse", f"{d * 100:+.1f} points against luck (interval {ci[0] * 100:+.1f} to {ci[1] * 100:+.1f}): it has done worse than chance."
    return "no_edge", f"{d * 100:+.1f} points over luck but the interval ({ci[0] * 100:+.1f} to {ci[1] * 100:+.1f}) includes zero: no edge shown."


def summarise(calls: Sequence[Mapping[str, Any]], windows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Every indicator at every horizon, with the status read at the primary horizon."""
    items = []
    for key, meta in INDICATORS.items():
        by_h = {str(h): summarise_one(key, h, calls, windows) for h in HORIZONS}
        p = by_h[str(PRIMARY)]
        items.append({"id": key, "name": meta["name"], "kind": meta["kind"], "claim": meta["claim"], "status": p["status"], "status_text": p["status_text"], "primary": PRIMARY, "horizons": by_h})
    return {"indicators": items, "min_sessions": MIN_SESSIONS, "min_calls": MIN_CALLS, "primary_horizon": PRIMARY}


def headline(items: Sequence[Mapping[str, Any]], sessions: int) -> str:
    """One sentence for the top of the page."""
    labels = [i["status"] for i in items]
    if sessions == 0:
        return "No finished session has been scored yet."
    ready = sum(x in ("edge", "timing_edge") for x in labels)
    if sessions < MIN_SESSIONS:
        return (f"{sessions} sessions scored; {MIN_SESSIONS} are needed before any indicator can be called an edge. So far none can be called proven or useless: read the direction of each bar, not the label.")
    if ready == 0:
        return f"{sessions} sessions scored: no indicator has shown an edge over luck. Do not rely on them for timing."
    return f"{sessions} sessions scored: {ready} of {len(items)} indicators show an edge over luck (see the labels); the rest do not."
