"""Historical validation of the recorded buyer and seller environment scores (pure).

Input: recorded minutes (``StraddleStore.rows``) grouped by session, oldest session first. Only minutes that were actually recorded are used; nothing is rebuilt
from history. For each score bucket and horizon (15, 30, 60 minutes, end of session) it measures what happened next, using non-overlapping picks (one entry per
horizon, so the samples are not the same move counted many times):

  NIFTY movement       signed and absolute points to the horizon;
  premium proxy        the straddle of the strike that was ATM at the pick, from the recorded +-2 strike ladders (price of the same contract later). Seller result =
                       entry premium - later premium - costs; buyer volatility result = later premium - entry premium - costs;
  directional accuracy for the buyer, how often the sign of the move matched the direction the evidence leaned (only when it leaned);
  maximum adverse excursion and the chronological drawdown of the summed result.

Costs are an assumption, not an observation: the stored prices are last traded prices with no bid/ask, so ``half_spread_pts`` per leg per trade is charged on
2 legs x entry and exit. Brokerage, taxes and slippage beyond that are not included. Chronological out-of-sample: the later third of the sessions is reported
apart from the earlier two thirds (nothing is fitted, so this shows stability, not a held-out test of a fitted rule). "Sufficient" needs 20 sessions and 30 picks
in a bucket; below that the figures are a description of the stored days and no claim is made.
"""

from __future__ import annotations

import statistics
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any

HORIZONS: tuple[int | str, ...] = (15, 30, 60, "eos")
HALF_SPREAD_PTS = 0.5
MIN_SESSIONS = 20
MIN_PICKS = 30
TOL_MIN = 3.0
BUCKETS = (("low (<40)", 0.0, 40.0), ("mid (40-60)", 40.0, 60.0), ("high (>=60)", 60.0, 101.0))


def _t(s: str) -> float:
    return datetime.fromisoformat(s).timestamp()


def premium(ladder: Mapping[str, Any] | None, strike: float) -> float | None:
    """CE + PE price of ``strike`` from a recorded ladder, or None if the strike is outside it or a price is missing."""
    if not ladder:
        return None
    step, k0 = ladder.get("step"), ladder.get("k0")
    if not step or k0 is None:
        return None
    i = round((strike - k0) / step)
    if abs(i) > 2 or abs(k0 + i * step - strike) > 1e-6:
        return None
    ce, pe = ladder["ce"][i + 2], ladder["pe"][i + 2]
    return None if ce is None or pe is None else float(ce + pe)


def picks(rows: Sequence[Mapping[str, Any]], h: int | str) -> list[tuple[int, int]]:
    """(entry index, exit index) pairs, non-overlapping. Exit = the last row at or before entry + h (within a tolerance), or the last row for end of session."""
    out: list[tuple[int, int]] = []
    ts = [_t(r["at"]) for r in rows]
    i = 0
    while i < len(rows):
        if h == "eos":
            if i < len(rows) - 1 and ts[-1] - ts[i] >= 20 * 60:
                out.append((i, len(rows) - 1))
            nxt = next((j for j in range(i + 1, len(rows)) if ts[j] - ts[i] >= 60 * 60), None)
        else:
            target = ts[i] + int(h) * 60
            j = max((k for k in range(i + 1, len(rows)) if ts[k] <= target + TOL_MIN * 60), default=None)
            if j is not None and ts[j] >= target - TOL_MIN * 60:
                out.append((i, j))
            nxt = next((k for k in range(i + 1, len(rows)) if ts[k] >= target), None)
        if nxt is None:
            break
        i = nxt
    return out


def _drawdown(vals: Sequence[float]) -> float:
    peak = cum = worst = 0.0
    for v in vals:
        cum += v
        peak = max(peak, cum)
        worst = min(worst, cum - peak)
    return worst


def _agg(items: Sequence[Mapping[str, Any]], kind: str) -> dict[str, Any]:
    n = len(items)
    if n == 0:
        return {"n": 0}
    pnl = [x["pnl"] for x in items if x["pnl"] is not None]
    mv = [x["move"] for x in items]
    out: dict[str, Any] = {"n": n, "mean_abs_move_pts": round(sum(abs(m) for m in mv) / n, 1), "mean_move_pts": round(sum(mv) / n, 1), "median_move_pts": round(statistics.median(mv), 1),
                           "premium_picks": len(pnl)}  # fmt: skip
    if pnl:
        out |= {"mean_result_pts": round(sum(pnl) / len(pnl), 2), "median_result_pts": round(statistics.median(pnl), 2), "win_rate_pct": round(sum(1 for p in pnl if p > 0) / len(pnl) * 100, 1),
                "max_adverse_pts": round(max(x["adverse"] for x in items if x["pnl"] is not None), 2), "max_drawdown_pts": round(_drawdown(pnl), 2)}  # fmt: skip
    else:
        out["note"] = "no pick had the entry strike inside the later +-2 strike ladders: premium result unavailable"
    if kind == "buyer":
        dd = [x for x in items if x["dir"] is not None]
        out["directional_n"] = len(dd)
        out["directional_accuracy_pct"] = None if not dd else round(sum(1 for x in dd if x["dir"] * x["move"] > 0) / len(dd) * 100, 1)
    return out


def evaluate(sessions: Sequence[Mapping[str, Any]], half_spread: float = HALF_SPREAD_PTS) -> dict[str, Any]:
    """``sessions``: [{"session": "2026-11-11", "expiry_day": bool, "rows": [...]}] oldest first."""
    cost = 4 * half_spread
    rec: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    n_rows = 0
    for ses in sessions:
        rows = ses["rows"]
        n_rows += len(rows)
        for h in HORIZONS:
            for i, j in picks(rows, h):
                a, b = rows[i], rows[j]
                d, e = a["data"], b["data"]
                if a["spot"] is None or b["spot"] is None:
                    continue
                k = (d.get("atm") or {}).get("k")
                p0 = premium(d.get("ladder"), k) if k is not None else None
                p1 = premium(e.get("ladder"), k) if k is not None else None
                path = [premium(r["data"].get("ladder"), k) for r in rows[i + 1 : j + 1]] if k is not None else []
                path_ok = [p for p in path if p is not None]
                dirn = (d.get("direction") or {}).get("value")
                move = b["spot"] - a["spot"]
                for kind, score_key in (("seller", "seller"), ("buyer", "buyer")):
                    sc = a.get(score_key)
                    if sc is None:
                        continue
                    bucket = next(name for name, lo, hi in BUCKETS if lo <= sc < hi)
                    if p0 is not None and p1 is not None:
                        pnl = (p0 - p1 - cost) if kind == "seller" else (p1 - p0 - cost)
                        adverse = max(0.0, (max(path_ok + [p1]) - p0) if kind == "seller" else (p0 - min(path_ok + [p1])))
                    else:
                        pnl, adverse = None, 0.0
                    rec.setdefault((kind, str(h), bucket), []).append({
                        "pnl": pnl, "adverse": adverse, "move": move, "session": ses["session"], "expiry_day": bool(ses.get("expiry_day")),
                        "dir": None if kind == "seller" or dirn is None or abs(dirn) < 0.3 else (1 if dirn > 0 else -1)})  # fmt: skip
    names = [s["session"] for s in sessions]
    cut = len(names) - max(1, len(names) // 3) if len(names) >= 3 else len(names)
    later = set(names[cut:])
    table: dict[str, Any] = {}
    for kind in ("seller", "buyer"):
        table[kind] = {}
        for h in HORIZONS:
            row: dict[str, Any] = {}
            for name, _, _ in BUCKETS:
                it = rec.get((kind, str(h), name), [])
                row[name] = _agg(it, kind) | {
                    "expiry_day": _agg([x for x in it if x["expiry_day"]], kind), "non_expiry_day": _agg([x for x in it if not x["expiry_day"]], kind),
                    "earlier_sessions": _agg([x for x in it if x["session"] not in later], kind), "later_sessions": _agg([x for x in it if x["session"] in later], kind)}  # fmt: skip
            table[kind][str(h)] = row
    enough = len(names) >= MIN_SESSIONS and any(v["n"] >= MIN_PICKS for kd in table.values() for hz in kd.values() for v in hz.values())
    return {"sessions": len(names), "recorded_minutes": n_rows, "from": names[0] if names else None, "to": names[-1] if names else None, "cost_points_per_round_trip": cost,
            "table": table, "sufficient": enough,
            "message": ("Enough recorded sessions to describe how the scores relate to what followed; this still does not show that a score predicts profitable trades." if enough else
                        f"Insufficient: {len(names)} recorded session(s) (need {MIN_SESSIONS}) and not enough picks per bucket (need {MIN_PICKS}). Recording started with this module, so there is no earlier history; figures are a description, not evidence."),
            "method": __doc__.split("Input:")[1].split("Costs are")[0].strip() if __doc__ else "",
            "assumptions": f"Costs are an assumption: {half_spread} point per leg per trade, 4 trades (2 legs, entry and exit) = {cost} points per round trip on last traded prices, with no bid/ask. Taxes and brokerage are not included.",
            "limits": ["Premium results use the recorded +-2 strike ladder; picks whose strike left it have no premium result.", "Seller result is a short ATM straddle proxy; buyer result is a long ATM straddle proxy (volatility buyer). Directional option buying is judged by direction accuracy only.",
                       "Picks are non-overlapping but adjacent horizons share the same days; sessions are few."]}  # fmt: skip
