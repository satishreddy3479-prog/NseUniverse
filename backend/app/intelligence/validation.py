"""Chronological walk-forward validation of the stored sentiment snapshots (pure functions, no I/O).

The dashboard stores one row a minute of market hours (``IntelligenceStore.timeline``): the fused score, confidence, coverage, the five group
scores and the spot. This module asks a plain question of that history and answers it without flattering the engine:

    given only what was known at snapshot t, did the sign of the score match the direction of NIFTY over the next 15 / 30 / 60 minutes,
    to the end of that session, and to the close of the next session?

Rules that keep it honest:

* **No look-ahead.** A snapshot's features are its own stored row. The outcome is read only from rows strictly later in time, inside the same
  session (the next-session outcome from the next recorded session). Walk-forward folds are chronological: a fold's "train" rows are all earlier
  sessions and are never mixed with its test session.
* **Changing inputs.** Rows carry an architecture marker (``metrics.arch``). Rows from a different group layout are not mixed in: they are
  counted and left out. Inside a layout a missing group is simply absent from that row's ``engines`` and :func:`rescore` renormalises over the
  groups present, the same rule the live fusion uses.
* **Missing outcomes stay missing.** A horizon with no stored row near its target time is not interpolated: the snapshot is counted as unlabelled.
* **No inference from small samples.** Below ``MIN_SAMPLES`` calls a result is reported as insufficient; every hit rate comes with a Wilson 95 %
  interval; nothing here is a predictive-accuracy claim: it measures how the provisional weights behaved on the sessions that happen to be stored.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime
from typing import Any

from app.intelligence import voleval

ARCH = 2  # the five-group layout (positioning, orderflow, volatility, structure, participation)
HORIZONS: dict[str, int | None] = {"15m": 15, "30m": 30, "60m": 60, "end_of_session": None, "next_session": None}
NEUTRAL_BAND = 15.0         # |score| below this is "no call"
FLAT_BAND_PCT = 0.02        # a forward move smaller than this (percent) is flat: no direction to match
TOLERANCE_MIN = 3.0         # the outcome row must lie within this many minutes after the target time
MIN_SAMPLES = 30            # directional calls needed before a hit rate is reported as more than anecdote
MIN_EOS_MINUTES = 10.0      # an end-of-session outcome needs at least this much time left in the session
MAX_SESSION_GAP_DAYS = 5    # a "next session" further away than this (a long holiday or a recording gap) is not used


def _t(row: Mapping[str, Any]) -> datetime | None:
    try:
        return datetime.fromisoformat(str(row.get("at")))
    except (TypeError, ValueError):
        return None


def rescore(row: Mapping[str, Any], weights: Mapping[str, float]) -> float | None:
    """The fused score of a stored row under ``weights`` (any weight set: this is how alternative weights are tested without re-running history).
    Groups missing from the row are left out and the rest renormalised, exactly as the live fusion does; a row with no group scores has none."""
    eng = row.get("engines") or {}
    num_, den = 0.0, 0.0
    for k, w in weights.items():
        s = eng.get(k)
        if isinstance(s, (int, float)) and w > 0:
            num_ += float(s) * w
            den += w
    return None if den == 0 else num_ / den


def wilson(hits: int, n: int, z: float = 1.96) -> tuple[float, float] | None:
    """95 % Wilson score interval of a proportion (None for n = 0)."""
    if n <= 0:
        return None
    p = hits / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return round(max(0.0, c - h), 4), round(min(1.0, c + h), 4)


def pearson(xs: Sequence[float], ys: Sequence[float]) -> float | None:
    n = len(xs)
    if n < 3:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx == 0 or syy == 0:
        return None
    return round(sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True)) / math.sqrt(sxx * syy), 4)


def _by_session(rows: Sequence[Mapping[str, Any]]) -> dict[str, list[Mapping[str, Any]]]:
    out: dict[str, list[Mapping[str, Any]]] = {}
    for r in sorted((r for r in rows if _t(r) is not None), key=lambda r: str(_t(r))):
        out.setdefault(str(r.get("session")), []).append(r)
    return out


def outcomes(rows: Sequence[Mapping[str, Any]], horizon: str) -> list[dict[str, Any]]:
    """For every row with a spot: the forward return (percent) to ``horizon`` taken only from later rows, or None with the reason. Chronological."""
    if horizon not in HORIZONS:
        msg = f"unknown horizon {horizon!r}; use one of {', '.join(HORIZONS)}"
        raise ValueError(msg)
    sess = _by_session(rows)
    order = sorted(sess, key=lambda k: str(_t(sess[k][0])))
    out: list[dict[str, Any]] = []
    for si, key in enumerate(order):
        series = sess[key]
        for i, r in enumerate(series):
            t0, spot0 = _t(r), r.get("spot")
            rec: dict[str, Any] = {"row": r, "session": key, "at": r.get("at"), "forward_pct": None, "reason": None}
            out.append(rec)
            if t0 is None or not isinstance(spot0, (int, float)) or spot0 <= 0:
                rec["reason"] = "no spot at the snapshot"
                continue
            target: Mapping[str, Any] | None = None
            minutes = HORIZONS[horizon]
            if minutes is not None:
                for later in series[i + 1:]:
                    t1 = _t(later)
                    if t1 is None:
                        continue
                    gap = (t1 - t0).total_seconds() / 60
                    if gap >= minutes:
                        if gap - minutes <= TOLERANCE_MIN:
                            target = later
                        break
                if target is None:
                    rec["reason"] = f"no stored row within {TOLERANCE_MIN:.0f} minutes of {minutes} minutes later"
            elif horizon == "end_of_session":
                last = series[-1]
                tl = _t(last)
                if tl is None or (tl - t0).total_seconds() / 60 < MIN_EOS_MINUTES:
                    rec["reason"] = "fewer than 10 minutes left in the recorded session"
                else:
                    target = last
            else:  # next_session
                nxt = sess[order[si + 1]] if si + 1 < len(order) else None
                if not nxt:
                    rec["reason"] = "no later session recorded"
                else:
                    tn = _t(nxt[-1])
                    if tn is None or (tn - t0).days > MAX_SESSION_GAP_DAYS:
                        rec["reason"] = f"the next recorded session is more than {MAX_SESSION_GAP_DAYS} days away"
                    else:
                        target = nxt[-1]
            if target is not None:
                spot1 = target.get("spot")
                if isinstance(spot1, (int, float)) and spot1 > 0:
                    rec["forward_pct"] = round((spot1 / spot0 - 1) * 100, 5)
                else:
                    rec["reason"] = "no spot at the outcome row"
    return out


def _call(score: float | None) -> int:
    return 0 if score is None or abs(score) < NEUTRAL_BAND else (1 if score > 0 else -1)


def evaluate(rows: Sequence[Mapping[str, Any]], horizon: str, *, scorer: Callable[[Mapping[str, Any]], float | None] | None = None, min_coverage: float = 0.0,
             only_sessions: Sequence[str] | None = None) -> dict[str, Any]:
    """Hit rate, score/return correlation and bucket means at one horizon. ``scorer`` replaces the stored score (for alternative weights). ``only_sessions``
    restricts which snapshots are SCORED; outcomes are still read from the later rows of the full history (a label, never a feature)."""
    arch_rows = [r for r in rows if (r.get("metrics") or {}).get("arch") == ARCH]
    other = len(rows) - len(arch_rows)
    labelled: list[tuple[float, float, Mapping[str, Any]]] = []
    unlabelled, no_score, low_cov = 0, 0, 0
    for o in outcomes(arch_rows, horizon):
        r = o["row"]
        if only_sessions is not None and o["session"] not in only_sessions:
            continue
        score = scorer(r) if scorer is not None else r.get("score")
        if score is None:
            no_score += 1
            continue
        if isinstance(r.get("coverage"), (int, float)) and r["coverage"] < min_coverage:
            low_cov += 1
            continue
        if o["forward_pct"] is None:
            unlabelled += 1
            continue
        labelled.append((float(score), float(o["forward_pct"]), r))
    calls = [(s, f, r) for s, f, r in labelled if _call(s) != 0]
    decided = [(s, f, r) for s, f, r in calls if abs(f) >= FLAT_BAND_PCT]
    hits = sum(1 for s, f, _ in decided if (s > 0) == (f > 0))
    buckets: dict[str, list[float]] = {}
    for s, f, _ in labelled:
        k = "strong bullish (>=70)" if s >= 70 else "bullish (35 to 70)" if s >= 35 else "mild bullish (15 to 35)" if s >= 15 else "neutral (-15 to 15)" if s > -15 else "mild bearish (-35 to -15)" if s > -35 else "bearish (-70 to -35)" if s > -70 else "strong bearish (<=-70)"
        buckets.setdefault(k, []).append(f)
    conf: dict[str, list[int]] = {"low (<35)": [0, 0], "medium (35 to 60)": [0, 0], "high (>=60)": [0, 0]}
    for s, f, r in decided:
        c = r.get("confidence")
        if isinstance(c, (int, float)):
            k = "high (>=60)" if c >= 60 else "medium (35 to 60)" if c >= 35 else "low (<35)"
            conf[k][1] += 1
            conf[k][0] += (s > 0) == (f > 0)
    n_dec = len(decided)
    enough = n_dec >= MIN_SAMPLES
    return {
        "horizon": horizon, "snapshots": len(arch_rows), "other_architecture_excluded": other, "no_score": no_score, "below_min_coverage": low_cov, "unlabelled": unlabelled, "labelled": len(labelled),
        "calls": len(calls), "decided": n_dec, "flat_outcomes": len(calls) - n_dec,
        "hit_rate": None if not enough else round(hits / n_dec, 4), "hit_rate_ci95": None if not enough else wilson(hits, n_dec),
        "hits": hits, "correlation": pearson([s for s, _, _ in labelled], [f for _, f, _ in labelled]) if len(labelled) >= MIN_SAMPLES else None,
        "mean_forward_pct_by_score": {k: {"n": len(v), "mean_pct": round(sum(v) / len(v), 4)} for k, v in sorted(buckets.items())},
        "hit_rate_by_confidence": {k: {"n": v[1], "hit_rate": None if v[1] < MIN_SAMPLES else round(v[0] / v[1], 4)} for k, v in conf.items()},
        "verdict": "insufficient sample: fewer than 30 decided directional calls, so no hit rate is reported" if not enough else "measured on the stored sessions only; not evidence of future accuracy",
    }


def walk_forward(rows: Sequence[Mapping[str, Any]], horizon: str, *, min_train_sessions: int = 3, fit: Callable[[Sequence[Mapping[str, Any]]], Callable[[Mapping[str, Any]], float | None]] | None = None,
                 min_coverage: float = 0.0) -> dict[str, Any]:
    """Expanding-window walk-forward: for each session after the first ``min_train_sessions``, ``fit`` sees only the EARLIER sessions' rows and returns a
    scorer that is evaluated on that session alone. With no ``fit`` the stored (provisional, unfitted) score is used, so every fold is out-of-sample by
    construction. Sessions are never shuffled or mixed; the final entry pools the test sessions (the out-of-sample total)."""
    arch_rows = [r for r in rows if (r.get("metrics") or {}).get("arch") == ARCH]
    sess = _by_session(arch_rows)
    order = sorted(sess, key=lambda k: str(_t(sess[k][0])))
    folds: list[dict[str, Any]] = []
    for k in range(min_train_sessions, len(order)):
        train = [r for s in order[:k] for r in sess[s]]
        scorer = fit(train) if fit is not None else None
        folds.append({"test_session": order[k], "train_sessions": order[:k], "train_snapshots": len(train),
                      **evaluate(arch_rows, horizon, scorer=scorer, min_coverage=min_coverage, only_sessions=[order[k]])})
    pooled = None
    if folds and fit is None:
        pooled = evaluate(arch_rows, horizon, min_coverage=min_coverage, only_sessions=order[min_train_sessions:])
    return {"horizon": horizon, "sessions": order, "min_train_sessions": min_train_sessions, "folds": folds, "pooled_out_of_sample": pooled,
            "note": "Each fold is scored on one session using only earlier sessions; weights are not fitted, so every fold is out-of-sample for the provisional weights." if fit is None else "Each fold's scorer was fitted on earlier sessions only.",
            "enough_history": len(order) > min_train_sessions}


def vol_group_score(row: Mapping[str, Any], cfg: voleval.VolConfig) -> float | None:
    """The volatility group score of a stored row under ``cfg``, recomputed from the three inputs the timeline stores (ATM IV change, price change,
    25-delta risk-reversal change). None when the row has none of them. Used to compare scoring modes on the same history."""
    v = (row.get("metrics") or {}).get("vol") or {}
    atm, spot, rr = (voleval._num(v.get(k)) for k in ("atm", "spot", "rr"))  # noqa: SLF001
    parts = [x for x in (voleval.atm_score(atm, spot, cfg)[0], voleval.rr_score(rr, cfg)) if x is not None]
    return None if not parts else sum(parts) / len(parts)


MIN_SESSIONS_VOL_COMPARE = 20


def compare_vol_modes(rows: Sequence[Mapping[str, Any]], horizons: Sequence[str] = ("15m", "30m", "60m", "end_of_session")) -> dict[str, Any]:
    """Legacy against context scoring of the volatility group on the SAME stored sessions, chronologically (outcomes only from later rows), with the same
    neutral band, flat band, minimum-sample rule and Wilson intervals as the main validation. It describes; it never changes the default mode: a
    mode is only worth switching to if it is better on enough sessions with intervals that clearly separate, which is for a person to decide."""
    have = [r for r in rows if (r.get("metrics") or {}).get("arch") == ARCH and any(v is not None for v in ((r.get("metrics") or {}).get("vol") or {}).values())]
    sessions = sorted({str(r.get("session")) for r in have})
    out: dict[str, Any] = {"sessions_with_inputs": len(sessions), "snapshots_with_inputs": len(have), "needed_sessions": MIN_SESSIONS_VOL_COMPARE, "horizons": {}}
    if len(sessions) < MIN_SESSIONS_VOL_COMPARE:
        return out | {"status": f"insufficient: {len(sessions)} session(s) with stored volatility inputs, {MIN_SESSIONS_VOL_COMPARE} needed before the two modes are compared", "verdict": None}
    legacy, context = voleval.VolConfig(mode="legacy"), voleval.VolConfig(mode="context")
    for h in horizons:
        a = evaluate(have, h, scorer=lambda r: vol_group_score(r, legacy))
        b = evaluate(have, h, scorer=lambda r: vol_group_score(r, context))
        ha, hb = a.get("hit_rate"), b.get("hit_rate")
        ca, cb = a.get("hit_rate_ci95"), b.get("hit_rate_ci95")
        separated = None if None in (ca, cb) else (ca[0] > cb[1] or cb[0] > ca[1])  # type: ignore[index]
        out["horizons"][h] = {"legacy": a, "context": b, "hit_rate_difference": None if ha is None or hb is None else round(hb - ha, 4), "intervals_separate": separated}
    out["status"] = "descriptive: compare hit rates with their intervals; do not switch the default on a difference whose intervals overlap"
    out["verdict"] = None
    return out


def report(rows: Sequence[Mapping[str, Any]], *, weights: Mapping[str, float] | None = None, min_train_sessions: int = 3) -> dict[str, Any]:
    """The full validation report across all horizons for the stored history, with the live weights re-applied when given (rescore)."""
    scorer = None if weights is None else (lambda r: rescore(r, weights))
    sessions = sorted({str(r.get("session")) for r in rows})
    return {
        "sessions": sessions, "snapshots": len(rows), "architecture": ARCH,
        "by_horizon": {h: evaluate(rows, h, scorer=scorer) for h in HORIZONS},
        "walk_forward": {h: walk_forward(rows, h, min_train_sessions=min_train_sessions) for h in HORIZONS},
        "volatility_modes": compare_vol_modes(rows),
        "rules": ["chronological, no look-ahead: outcomes come only from later rows", "rows of another group layout are excluded, not mixed", "outcomes are never interpolated: a missing one leaves the snapshot unlabelled",
                  "fewer than 30 decided calls: no hit rate", "this describes how the provisional weights behaved on stored sessions; it is not a claim of predictive accuracy"],
    }
