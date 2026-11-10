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
    """The snapshot closest to ``minutes`` before ``snaps[i]`` among earlier ones of the same session, within ``tol_min``.
    Walks back from i and stops at the first snapshot at or before the target, so it costs a few steps, not a scan of the whole run."""
    target = snaps[i].at - timedelta(minutes=minutes)
    for j in range(i - 1, -1, -1):
        s = snaps[j]
        if s.session != snaps[i].session:
            return None
        if s.at <= target:
            return s if target - s.at <= timedelta(minutes=tol_min) else None
    return None


def val(s: Snap, key: str) -> float | None:
    """A feature of one snapshot: a field of ``Snap`` or an entry of ``extra`` (the reconstructed GEX metrics, e.g. ``dynamic.net``)."""
    v = s.extra.get(key) if key in s.extra else getattr(s, key, None)
    return None if v is None else float(v)


def change(snaps: Sequence[Snap], i: int, key: str, minutes: int = 15) -> float | None:
    """Change of a feature over the last ``minutes`` (uses only snapshots up to i)."""
    then = _back(snaps, i, minutes)
    a, b = val(snaps[i], key), None if then is None else val(then, key)
    return None if a is None or b is None else float(a - b)


def forward(snaps: Sequence[Snap], i: int, minutes: int = HORIZON_MIN, tol_min: int = 3) -> dict[str, float] | None:
    """What happened over the next ``minutes`` in the same session: return in percent and realised volatility of the snapshot-to-snapshot
    returns (percent per snapshot step, not annualised). None if the session ends before the horizon."""
    start = snaps[i]
    end_t = start.at + timedelta(minutes=minutes)
    path = []
    for s in snaps[i:]:  # snapshots are in time order: stop at the end of the window or of the session
        if s.session != start.session or s.at > end_t + timedelta(minutes=tol_min):
            break
        path.append(s)
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
    target: str  # "ret_pct", "rv", "big_move" or "corr" (correlation of ``feature`` with the next-30-minute realised volatility)
    rule: str
    feature: Callable[[Sequence[Snap], int], float | None] | None = None


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
    ("term_slope_vs_vol", "Term slope versus subsequent volatility", "needs several expiries sampled at the same moments across enough sessions; one expiry per run is reconstructed today."),
]


SPOT_MOVE_PCT = 0.05
GEX_MOVE_SHARE = 0.05
FLIP_MOVE_PCT = 0.1


def _ratio(s: Sequence[Snap], i: int, u: str) -> float | None:
    net, ab = val(s[i], f"{u}.net"), val(s[i], f"{u}.abs")
    return None if net is None or not ab else net / ab


def _cross(s: Sequence[Snap], i: int, u: str, up: bool) -> bool | None:
    """Spot crossed the gamma flip between the previous snapshot and this one (both flips known)."""
    if i == 0 or s[i - 1].session != s[i].session or s[i].at - s[i - 1].at > timedelta(minutes=7):
        return None
    f0, f1 = val(s[i - 1], f"{u}.flip"), val(s[i], f"{u}.flip")
    if f0 is None or f1 is None:
        return None
    return (s[i - 1].spot < f0 and s[i].spot >= f1) if up else (s[i - 1].spot > f0 and s[i].spot <= f1)


def _spot15(s: Sequence[Snap], i: int) -> float | None:
    then = _back(s, i, 15)
    return None if then is None or not then.spot else (s[i].spot / then.spot - 1) * 100


def _gexmove(s: Sequence[Snap], i: int, u: str) -> int | None:
    """Direction (-1 / 0 / +1) of the 15-minute change of net GEX: a change under 5 % of the larger |net| counts as unchanged."""
    then = _back(s, i, 15)
    a, b = val(s[i], f"{u}.net"), None if then is None else val(then, f"{u}.net")
    if a is None or b is None:
        return None
    scale = max(abs(a), abs(b))
    return 0 if scale == 0 or abs(a - b) < GEX_MOVE_SHARE * scale else (1 if a > b else -1)


def _div(s: Sequence[Snap], i: int, u: str, spot_dir: int, gex_dir: int) -> bool | None:
    sp, gx = _spot15(s, i), _gexmove(s, i, u)
    if sp is None or gx is None:
        return None
    moved = 0 if abs(sp) < SPOT_MOVE_PCT else (1 if sp > 0 else -1)
    return moved == spot_dir and gx == gex_dir


def _flipmove(s: Sequence[Snap], i: int, u: str) -> float | None:
    d = change(s, i, f"{u}.flip")
    return None if d is None or not s[i].spot else d / s[i].spot * 100


def gex_hypotheses(u: str) -> list[Hypothesis]:
    """The GEX and gamma-flip hypotheses for one universe (fixed, dynamic or full). Every rule uses only snapshots up to the event time."""
    hs = [
        Hypothesis("gex_vs_rv", "Net GEX (net / absolute) versus subsequent realised volatility", lambda s, i: None, 0, "corr",
                   f"{u} universe: correlation of net GEX ÷ absolute GEX with the next-30-minute realised volatility (a negative figure supports 'negative GEX, more movement')",
                   feature=lambda s, i: _ratio(s, i, u)),
        Hypothesis("neg_gamma_rv", "Negative versus positive gamma regime versus subsequent volatility", lambda s, i: _flag(val(s[i], f"{u}.net"), lambda v: v < 0), 0, "rv",
                   f"event: {u} net GEX < 0 (model sign); target: realised vol of the next 30 min, compared with net GEX ≥ 0"),
        Hypothesis("flip_cross_up", "NIFTY crosses up through the gamma flip then rises", lambda s, i: _cross(s, i, u, True), 1, "ret_pct", f"event: spot moves from below to at/above the {u} gamma flip between snapshots; long next 30 min"),
        Hypothesis("flip_cross_down", "NIFTY crosses down through the gamma flip then falls", lambda s, i: _cross(s, i, u, False), -1, "ret_pct", f"event: spot moves from above to at/below the {u} gamma flip; short next 30 min"),
        Hypothesis("flip_migration_up", "Gamma flip migrating up then NIFTY up", lambda s, i: _flag(_flipmove(s, i, u), lambda v: v >= FLIP_MOVE_PCT), 1, "ret_pct", f"event: {u} flip up ≥ {FLIP_MOVE_PCT} % of spot over 15 min; long next 30 min"),
        Hypothesis("flip_migration_down", "Gamma flip migrating down then NIFTY down", lambda s, i: _flag(_flipmove(s, i, u), lambda v: v <= -FLIP_MOVE_PCT), -1, "ret_pct", f"event: {u} flip down ≥ {FLIP_MOVE_PCT} % of spot over 15 min; short next 30 min"),
        Hypothesis("div_amp_up", "NIFTY up with net GEX falling (potentially amplifying) then continues up", lambda s, i: _div(s, i, u, 1, -1), 1, "ret_pct", f"event: 15-min spot ≥ +{SPOT_MOVE_PCT} % and {u} net GEX down by ≥ {int(GEX_MOVE_SHARE * 100)} % of the larger |net|; long next 30 min"),
        Hypothesis("div_amp_down", "NIFTY down with net GEX falling (potential downside amplification) then continues down", lambda s, i: _div(s, i, u, -1, -1), -1, "ret_pct", f"event: 15-min spot ≤ −{SPOT_MOVE_PCT} % and net GEX down; short next 30 min"),
        Hypothesis("div_stab_up", "NIFTY up with net GEX rising (potentially stabilising) then fades", lambda s, i: _div(s, i, u, 1, 1), -1, "ret_pct", "event: 15-min spot up and net GEX up by ≥ 5 %; short next 30 min (fade)"),
        Hypothesis("div_stab_down", "NIFTY down with net GEX rising (potential stabilisation) then recovers", lambda s, i: _div(s, i, u, -1, 1), 1, "ret_pct", "event: 15-min spot down and net GEX up; long next 30 min (recovery)"),
    ]
    for h in hs:
        if not h.rule.startswith(f"{u} universe"):
            h.rule = f"{u} universe · {h.rule}"
    return hs


def _mom(s: Sequence[Snap], i: int) -> float | None:
    a, b = change(s, i, "ce25"), change(s, i, "pe25")
    return None if a is None or b is None else a - b


def _oi(s: Sequence[Snap], i: int) -> float | None:
    a, b = change(s, i, "oi_ce"), change(s, i, "oi_pe")
    ce, pe = s[i].oi_ce, s[i].oi_pe
    if a is None or b is None or ce is None or pe is None or ce + pe == 0:
        return None
    return (b - a) / (ce + pe) * 100


def _correlation(snaps: Sequence[Snap], h: Hypothesis, days: set[str]) -> dict[str, Any]:
    """Pearson correlation of a continuous feature with the next-30-minute realised volatility over non-overlapping snapshots, with a
    Fisher-z 95 % interval. Snapshots without the feature or without a full forward window are counted as unavailable."""
    assert h.feature is not None
    idx = thin([i for i, s in enumerate(snaps) if s.session in days and h.feature(snaps, i) is not None], snaps)
    pairs: list[tuple[float, float]] = []
    for i in idx:
        f = forward(snaps, i)
        x = h.feature(snaps, i)
        if f is not None and x is not None:
            pairs.append((x, f["rv"]))
    n = len(pairs)
    res: dict[str, Any] = {"events": n, "others": 0, "unavailable": sum(1 for i, s in enumerate(snaps) if s.session in days and h.feature(snaps, i) is None), "enough": n >= MIN_EVENTS, "correlation": None}
    if n >= 4:
        mx, my = sum(p[0] for p in pairs) / n, sum(p[1] for p in pairs) / n
        sxx = sum((p[0] - mx) ** 2 for p in pairs)
        syy = sum((p[1] - my) ** 2 for p in pairs)
        sxy = sum((p[0] - mx) * (p[1] - my) for p in pairs)
        if sxx > 0 and syy > 0:
            rr = sxy / math.sqrt(sxx * syy)
            z, se = math.atanh(max(min(rr, 0.999999), -0.999999)), 1 / math.sqrt(n - 3) if n > 3 else None
            res["correlation"] = {"r": round(rr, 4), "n": n, "ci95": None if se is None else [round(math.tanh(z - 1.96 * se), 4), round(math.tanh(z + 1.96 * se), 4)]}
    return res


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
        if h.target == "corr" and h.feature is not None:
            res_c = _correlation(snaps, h, days)
            out[name] = res_c
            continue
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
