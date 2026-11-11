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


def acceleration(samples: Sequence[tuple[str, dict[str, Any]]], minutes: int = 5) -> dict[str, Any]:
    """CVD acceleration from two consecutive, non-overlapping windows of EQUAL length ending now and ``minutes`` ago:

        current CVD   = CVD(now) - CVD(now - N)           previous CVD   = CVD(now - N) - CVD(now - 2N)
        current rate  = current CVD / N  (per minute)     previous rate  = previous CVD / N
        change in rate = current rate - previous rate     acceleration   = change in rate / N   (CVD per minute per minute)

    Three stored samples are needed (now, N and 2N minutes ago, each within the tolerance) with continuous flow between them. The 15 and 30 minute
    windows are context and are never subtracted from the 5 minute one. Unavailable with its reason otherwise; nothing is reconstructed."""
    out: dict[str, Any] = {"minutes": minutes, "current_cvd": None, "previous_cvd": None, "current_rate": None, "previous_rate": None, "rate_change": None,
                           "acceleration": None, "current_pct": None, "previous_pct": None, "status": ""}
    pts = sorted(((t, p) for s, p in samples if (t := _t(s)) is not None), key=lambda x: x[0])
    if not pts:
        return out | {"status": "unavailable: no flow samples stored today"}
    now = pts[-1]
    marks = [now]
    for k in (1, 2):
        target = now[0] - timedelta(minutes=minutes * k)
        cand = [x for x in pts if x[0] <= target]
        if not cand:
            return out | {"status": f"unavailable: fewer than {2 * minutes} minutes of flow samples stored today"}
        if (target - cand[-1][0]).total_seconds() > TOLERANCE_MIN * 60:
            return out | {"status": f"unavailable: no stored sample within {TOLERANCE_MIN:.0f} minutes of {minutes * k} minutes ago (a gap in the recording)"}
        marks.append(cand[-1])
    keys = ("cvd", "b", "s", "v")
    if any(not isinstance(m[1].get(k), (int, float)) for m in marks for k in keys):
        return out | {"status": "unavailable: the flow tracker had no classified volume at one of the three points"}
    cls = [m[1]["b"] + m[1]["s"] for m in marks]
    if cls[0] < cls[1] or cls[1] < cls[2]:
        return out | {"status": "unavailable: the backend restarted inside the windows (the cumulative counters began again)"}
    cur, prev = marks[0][1]["cvd"] - marks[1][1]["cvd"], marks[1][1]["cvd"] - marks[2][1]["cvd"]
    # the actual minutes between the stored points, so a sample a little off the target does not distort the rate
    dm_cur, dm_prev = (marks[0][0] - marks[1][0]).total_seconds() / 60, (marks[1][0] - marks[2][0]).total_seconds() / 60
    if dm_cur <= 0 or dm_prev <= 0:
        return out | {"status": "unavailable: the sample times do not advance"}
    rc, rp = cur / dm_cur, prev / dm_prev

    def pc(d: float, c: float) -> float | None:
        return None if c <= 0 else round(d / c * 100, 2)

    return out | {"current_cvd": cur, "previous_cvd": prev, "current_rate": round(rc, 2), "previous_rate": round(rp, 2), "rate_change": round(rc - rp, 2),
                  "acceleration": round((rc - rp) / ((dm_cur + dm_prev) / 2), 3), "current_pct": pc(cur, cls[0] - cls[1]), "previous_pct": pc(prev, cls[1] - cls[2]),
                  "window_minutes": [round(dm_cur, 2), round(dm_prev, 2)], "status": "ok"}


def futures(samples: Sequence[tuple[str, dict[str, Any]]]) -> dict[str, Any]:
    """Rolling 5, 15 and 30-minute CVD of the future (the 15 and 30 minute windows are separate context), and the acceleration of the 5-minute CVD
    from two consecutive equal-length windows (see ``acceleration``). Windows that cannot be formed say why."""
    w = {str(n): window(samples, n) for n in WINDOWS}
    return {"windows": w, "acceleration": acceleration(samples, 5), "ok_windows": sum(1 for x in w.values() if x["status"] == "ok"), "estimated": True}


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
