"""Rolling futures and heavyweight CVD from the per-minute flow samples the market service already stores (pure functions).

The market sampler writes one ``fut`` sample a minute with the session-cumulative estimated buy volume ``b``, sell volume ``s``, CVD
(``cvd`` = b - s) and traded volume ``v`` of the NIFTY future, and one ``heavy5`` sample with the same cumulative figures for each
of the five largest constituents. A rolling window is the difference of two stored minutes:

    rolling CVD(N) = cvd(now) - cvd(now - N minutes)         rolling CVD % = rolling CVD / ((b + s)(now) - (b + s)(then)) x 100

Both ends must exist inside a stated tolerance, and the classified volume b + s must not have fallen between them (it only ever grows
inside one tracker run, so a fall means the backend restarted and the cumulative counters began again): such a window is reported
unavailable with its reason, never estimated. Like the session CVD this is an estimate by the quote and tick rule, not a trade tape.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import Any

WINDOWS = (5, 15, 30)
TOLERANCE_MIN = 2.0


def _t(stamp: str) -> datetime | None:
    try:
        return datetime.fromisoformat(stamp)
    except (TypeError, ValueError):
        return None


def _pair(samples: Sequence[tuple[str, dict[str, Any]]], minutes: int) -> tuple[tuple[datetime, dict[str, Any]] | None, tuple[datetime, dict[str, Any]] | None, str | None]:
    pts = [(t, p) for s, p in samples if (t := _t(s)) is not None]
    if not pts:
        return None, None, "no flow samples stored today"
    pts.sort(key=lambda x: x[0])
    last = pts[-1]
    target = last[0] - timedelta(minutes=minutes)
    cand = [x for x in pts if x[0] <= target]
    if not cand:
        return None, last, f"fewer than {minutes} minutes of flow samples stored today"
    first = cand[-1]
    if (target - first[0]).total_seconds() > TOLERANCE_MIN * 60:
        return None, last, f"no stored sample within {TOLERANCE_MIN:.0f} minutes of {minutes} minutes ago (a gap in the recording)"
    return first, last, None


def window(samples: Sequence[tuple[str, dict[str, Any]]], minutes: int) -> dict[str, Any]:
    """One rolling window of the future's flow. ``status`` is ``ok`` or ``unavailable: <reason>``."""
    a, b, why = _pair(samples, minutes)
    base: dict[str, Any] = {"minutes": minutes, "cvd": None, "cvd_pct": None, "volume": None, "classified": None, "from": None, "to": None if b is None else b[0].isoformat(), "status": f"unavailable: {why}"}
    if a is None or b is None:
        return base
    pa, pb = a[1], b[1]
    keys = ("cvd", "b", "s", "v")
    if any(not isinstance(pa.get(k), (int, float)) or not isinstance(pb.get(k), (int, float)) for k in keys):
        return base | {"from": a[0].isoformat(), "status": "unavailable: the flow tracker had no classified volume at one end"}
    ca, cb = pa["b"] + pa["s"], pb["b"] + pb["s"]
    if cb < ca or pb["v"] < pa["v"]:
        return base | {"from": a[0].isoformat(), "status": "unavailable: the backend restarted inside the window (the cumulative counters began again)"}
    d_cvd, classified = pb["cvd"] - pa["cvd"], cb - ca
    return base | {"cvd": d_cvd, "classified": classified, "volume": pb["v"] - pa["v"], "cvd_pct": None if classified <= 0 else round(d_cvd / classified * 100, 2),
                   "from": a[0].isoformat(), "status": "ok" if classified > 0 else "unavailable: no classified volume traded in the window"}


def futures(samples: Sequence[tuple[str, dict[str, Any]]]) -> dict[str, Any]:
    """Rolling 5, 15 and 30-minute CVD of the future, and CVD momentum: the per-minute rate over 5 minutes less the rate over 15 minutes
    (positive: buying pressure is strengthening). Windows that cannot be formed say why."""
    w = {str(n): window(samples, n) for n in WINDOWS}
    r5, r15 = w["5"], w["15"]
    mom = None if r5["cvd"] is None or r15["cvd"] is None else round(r5["cvd"] / 5 - r15["cvd"] / 15, 1)
    return {"windows": w, "momentum_per_min": mom, "ok_windows": sum(1 for x in w.values() if x["status"] == "ok"), "estimated": True}


def heavy(samples: Sequence[tuple[str, dict[str, Any]]], minutes: int = 15) -> dict[str, dict[str, Any]]:
    """Per heavyweight: CVD % of the classified volume over the last ``minutes``. Rows are ``[symbol, cvd, buy, sell, volume, imbalance]``."""
    a, b, why = _pair(samples, minutes)
    if a is None or b is None:
        return {"_status": {"status": f"unavailable: {why}"}}
    ra = {r[0]: r for r in a[1].get("rows", []) if isinstance(r, list) and len(r) >= 5}
    out: dict[str, dict[str, Any]] = {}
    for r in b[1].get("rows", []):
        if not isinstance(r, list) or len(r) < 5 or r[0] not in ra:
            continue
        p = ra[r[0]]
        if any(x is None for x in (r[1], r[2], r[3], p[1], p[2], p[3])):
            continue
        cls = (r[2] + r[3]) - (p[2] + p[3])
        if cls < 0:
            out[r[0]] = {"cvd_pct": None, "status": "unavailable: the backend restarted inside the window"}
        elif cls == 0:
            out[r[0]] = {"cvd_pct": None, "status": "unavailable: no classified volume in the window"}
        else:
            out[r[0]] = {"cvd_pct": round((r[1] - p[1]) / cls * 100, 2), "status": "ok"}
    out["_status"] = {"status": "ok", "from": a[0].isoformat(), "to": b[0].isoformat(), "minutes": minutes}
    return out
