"""Leak-free evaluation of options-derived signals against what NIFTY did next (registry ids: ``backtest_*``).

Pure functions over a list of snapshots (``Snap``: time, session, spot and the features known at that time). Rules that keep it honest:

* A feature at time t is built only from snapshots at or before t; the target is built only from snapshots after t inside the same session,
  so nothing crosses a session close.
* Thresholds are fixed in advance (each hypothesis states its own); nothing is tuned on the data.
* Sessions are split chronologically: the earlier share is shown as in-sample for description only, the later share is the out-of-sample
  result. Events closer together than the horizon are thinned so overlapping windows do not count the same move twice.
* Directional results are net of a stated round-trip cost, in basis points of NIFTY. This tests the signal against the index, not an
  options position: option spreads, theta and gamma are not modelled.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

HORIZON_MIN = 30
OOS_SHARE = 0.4
MIN_EVENTS = 20
BIG_MOVE_PCT = 0.3


@dataclass
class Snap:
    at: datetime
    session: str
    spot: float
    skew25: float | None = None            # put IV - call IV at 25 delta
    butterfly25: float | None = None
    atm_iv: float | None = None
    ce25: float | None = None
    pe25: float | None = None
    oi_ce: float | None = None             # call OI summed over ATM +/- 10
    oi_pe: float | None = None
    extra: dict[str, float | None] = field(default_factory=dict)


def _back(snaps: Sequence[Snap], i: int, minutes: int, tol_min: int = 3) -> Snap | None:
    """The snapshot closest to ``minutes`` before ``snaps[i]`` among earlier ones of the same session, within ``tol_min``."""
    target = snaps[i].at - timedelta(minutes=minutes)
    best = None
    for s in snaps[:i]:
        if s.session == snaps[i].session and s.at <= target and (best is None or s.at > best.at):
            best = s
    return best if best is not None and target - best.at <= timedelta(minutes=tol_min) else None


def change(snaps: Sequence[Snap], i: int, key: str, minutes: int = 15) -> float | None:
    """Change of a feature over the last ``minutes`` (uses only snapshots up to i)."""
    then = _back(snaps, i, minutes)
    a, b = getattr(snaps[i], key), None if then is None else getattr(then, key)
    return None if a is None or b is None else float(a - b)


def forward(snaps: Sequence[Snap], i: int, minutes: int = HORIZON_MIN, tol_min: int = 3) -> dict[str, float] | None:
    """What happened over the next ``minutes`` in the same session: return in percent and realised volatility of the snapshot-to-snapshot
    returns (percent per snapshot step, not annualised). None if the session ends before the horizon."""
    start = snaps[i]
    end_t = start.at + timedelta(minutes=minutes)
    path = [s for s in snaps[i:] if s.session == start.session and s.at <= end_t + timedelta(minutes=tol_min)]
    if not path or path[-1].at < end_t - timedelta(minutes=tol_min) or len(path) < 3:
        return None
    last = path[-1]
    steps = [math.log(b.spot / a.spot) for a, b in zip(path, path[1:], strict=False) if a.spot > 0 and b.spot > 0]
    if len(steps) < 2:
        return None
    mean = sum(steps) / len(steps)
    sd = math.sqrt(sum((x - mean) ** 2 for x in steps) / (len(steps) - 1)) * 100
    return {"ret_pct": (last.spot / start.spot - 1) * 100, "rv": sd}


def thin(events: Sequence[int], snaps: Sequence[Snap], minutes: int = HORIZON_MIN) -> list[int]:
    """Keep an event only if it is at least ``minutes`` after the previously kept one (same or any session), so windows do not overlap."""
    out: list[int] = []
    for i in events:
        if not out or snaps[i].session != snaps[out[-1]].session or snaps[i].at - snaps[out[-1]].at >= timedelta(minutes=minutes):
            out.append(i)
    return out


def split_sessions(snaps: Sequence[Snap], oos_share: float = OOS_SHARE) -> tuple[set[str], set[str]]:
    days = sorted({s.session for s in snaps})
    if len(days) < 2:
        return set(days), set()
    k = max(1, min(len(days) - 1, round(len(days) * (1 - oos_share))))
    return set(days[:k]), set(days[k:])


def stats(returns: Sequence[float]) -> dict[str, Any]:
    """Sample size, win rate, mean with a 95 % interval, drawdown of the cumulative sequence and risk/reward of the wins and losses."""
    n = len(returns)
    if n == 0:
        return {"n": 0, "win_rate": None, "mean": None, "ci95": None, "max_drawdown": None, "risk_reward": None, "total": None}
    mean = sum(returns) / n
    se = math.sqrt(sum((r - mean) ** 2 for r in returns) / (n - 1) / n) if n > 1 else None
    cum = peak = dd = 0.0
    for r in returns:
        cum += r
        peak = max(peak, cum)
        dd = max(dd, peak - cum)
    wins, losses = [r for r in returns if r > 0], [r for r in returns if r < 0]
    rr = None if not wins or not losses else (sum(wins) / len(wins)) / abs(sum(losses) / len(losses))
    return {
        "n": n, "win_rate": round(len(wins) / n * 100, 2), "mean": round(mean, 5), "total": round(sum(returns), 4),
        "ci95": None if se is None else [round(mean - 1.96 * se, 5), round(mean + 1.96 * se, 5)],
        "max_drawdown": round(dd, 4), "risk_reward": None if rr is None else round(rr, 3),
    }


def _mean_diff(a: Sequence[float], b: Sequence[float]) -> dict[str, Any]:
    """Mean of ``a`` minus mean of ``b`` with a Welch 95 % interval."""
    if len(a) < 2 or len(b) < 2:
        return {"diff": None, "ci95": None, "mean_event": None, "mean_other": None}
    ma, mb = sum(a) / len(a), sum(b) / len(b)
    va = sum((x - ma) ** 2 for x in a) / (len(a) - 1)
    vb = sum((x - mb) ** 2 for x in b) / (len(b) - 1)
    se = math.sqrt(va / len(a) + vb / len(b))
    return {"diff": round(ma - mb, 5), "ci95": [round(ma - mb - 1.96 * se, 5), round(ma - mb + 1.96 * se, 5)], "mean_event": round(ma, 5), "mean_other": round(mb, 5)}


@dataclass
class Hypothesis:
    id: str
    title: str
    #: given the snapshots and an index: True (event), False (not an event), None (feature unavailable)
    event: Callable[[Sequence[Snap], int], bool | None]
    #: directional: +1 long / -1 short, scored on the next-30-minute return. 0: non-directional, scored on ``target``
    side: int
    target: str  # "ret_pct", "rv" or "big_move"
    rule: str


def _flag(v: float | None, test: Callable[[float], bool]) -> bool | None:
    return None if v is None else test(v)


HYPOTHESES: list[Hypothesis] = [
    Hypothesis("skew_negative", "Negative 25-delta skew (calls richer than puts) then NIFTY up", lambda s, i: _flag(s[i].skew25, lambda v: v <= 0), 1, "ret_pct", "event: skew25 ≤ 0; long next 30 min"),
    Hypothesis("call_momentum", "Call IV strengthening against put IV then NIFTY up", lambda s, i: _flag(_mom(s, i), lambda v: v >= 0.3), 1, "ret_pct", "event: 15-min (CE25 change − PE25 change) ≥ +0.3 pts; long next 30 min"),
    Hypothesis("put_momentum", "Put IV strengthening against call IV then NIFTY down", lambda s, i: _flag(_mom(s, i), lambda v: v <= -0.3), -1, "ret_pct", "event: 15-min (CE25 change − PE25 change) ≤ −0.3 pts; short next 30 min"),
    Hypothesis("oi_put_accumulation", "Put OI accumulating faster than call OI then NIFTY up", lambda s, i: _flag(_oi(s, i), lambda v: v >= 1.0), 1, "ret_pct", "event: 15-min (put OI change − call OI change) ≥ 1 % of total OI, ATM ±10; long next 30 min"),
    Hypothesis("iv_expansion", "ATM IV expansion then higher realised volatility", lambda s, i: _flag(change(s, i, "atm_iv"), lambda v: v >= 0.3), 0, "rv", "event: 15-min ATM IV change ≥ +0.3 pts; target: realised vol of the next 30 min"),
    Hypothesis("butterfly_rise", "Rising 25-delta butterfly then a large move", lambda s, i: _flag(change(s, i, "butterfly25"), lambda v: v >= 0.3), 0, "big_move", f"event: 15-min butterfly25 change ≥ +0.3 pts; target: |next 30-min return| ≥ {BIG_MOVE_PCT} %"),
]
NOT_TESTABLE = [
    ("gex_vs_rv", "Net GEX versus realised intraday volatility", "GEX history is computed in the browser; no server-side GEX series is stored yet."),
    ("flip_crossings", "Gamma-flip crossings versus price behaviour", "needs the same stored GEX/flip series."),
    ("gex_migration", "GEX migration versus market direction", "needs the same stored GEX series."),
    ("term_slope_vs_vol", "Term slope versus subsequent volatility", "needs several expiries sampled at the same moments across enough sessions."),
]


def _mom(s: Sequence[Snap], i: int) -> float | None:
    a, b = change(s, i, "ce25"), change(s, i, "pe25")
    return None if a is None or b is None else a - b


def _oi(s: Sequence[Snap], i: int) -> float | None:
    a, b = change(s, i, "oi_ce"), change(s, i, "oi_pe")
    ce, pe = s[i].oi_ce, s[i].oi_pe
    if a is None or b is None or ce is None or pe is None or ce + pe == 0:
        return None
    return (b - a) / (ce + pe) * 100


def run(snaps: Sequence[Snap], h: Hypothesis, cost_bps: float = 5.0, oos_share: float = OOS_SHARE) -> dict[str, Any]:
    """Evaluate one hypothesis: in-sample (description only) and out-of-sample (the result), each with its sample sizes."""
    snaps = sorted(snaps, key=lambda s: s.at)
    insample, oos = split_sessions(snaps, oos_share)
    out: dict[str, Any] = {"id": h.id, "title": h.title, "rule": h.rule, "side": h.side, "target": h.target, "cost_bps": cost_bps, "sessions": {"in_sample": sorted(insample), "out_of_sample": sorted(oos)}}
    for name, days in (("in_sample", insample), ("out_of_sample", oos)):
        flags = [(i, h.event(snaps, i)) for i, s in enumerate(snaps) if s.session in days]
        ev = thin([i for i, f in flags if f is True], snaps)
        oth = thin([i for i, f in flags if f is False], snaps)
        fw: dict[int, dict[str, float]] = {}
        for i in set(ev) | set(oth):
            f = forward(snaps, i)
            if f is not None:
                fw[i] = f
        ev = [i for i in ev if i in fw]
        oth = [i for i in oth if i in fw]
        res: dict[str, Any] = {"events": len(ev), "others": len(oth), "unavailable": sum(1 for _, f in flags if f is None)}
        if h.side != 0:
            rets = [h.side * fw[i]["ret_pct"] - cost_bps / 100 for i in ev]
            res["net_return_pct"] = stats(rets)
            res["baseline_mean_pct"] = None if not oth else round(sum(h.side * fw[i]["ret_pct"] for i in oth) / len(oth), 5)
        else:
            def tv(i: int, fw: dict[int, dict[str, float]] = fw) -> float:
                return (1.0 if abs(fw[i]["ret_pct"]) >= BIG_MOVE_PCT else 0.0) if h.target == "big_move" else fw[i]["rv"]

            res["difference"] = _mean_diff([tv(i) for i in ev], [tv(i) for i in oth])
        res["enough"] = len(ev) >= MIN_EVENTS
        out[name] = res
    oos_res = out["out_of_sample"]
    out["status"] = "ok" if oos_res["enough"] else f"insufficient out-of-sample sample: {oos_res['events']} events (need {MIN_EVENTS})"
    return out
