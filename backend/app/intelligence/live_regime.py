"""Live regime and squeeze detectors for a short at-the-money straddle (pure functions, point in time).

Four readings, each a description of what the stored minutes show right now, with thresholds that are working values (provisional, not validated on enough recorded days):

  initial balance   the index's range in the first 30 minutes of the session against the straddle's implied one-day standard deviation: wide (above ``ib_trend_ratio``) = IB_EXPANSION_TREND,
                    narrow (below ``ib_decay_ratio``) = IB_COMPRESSION_DECAY. Needs the first 30 minutes stored from the open; before that it is "forming", and a session whose first stored minute
                    is not the open is "unknown" (the stored first half hour is not the opening range).
  short squeeze     the index up more than ``squeeze_spot_pct`` percent over 15 minutes while the future's open interest shed more than ``squeeze_oi_units`` units: ACTIVE_SHORT_SQUEEZE.
  put floor         over 15 minutes the open interest added on puts near the money is more than ``put_floor_ratio`` times the open interest added on calls (calls unwinding counts as zero added), the index
                    up more than ``put_floor_spot_pct`` percent and the added put interest at least ``put_floor_min_share`` of the put interest there: PUT_FLOOR_ADVANCING.
  VWAP detachment   the index on one side of the future's VWAP for more than ``vwap_minutes`` minutes and further from it than ``vwap_distance_pct`` percent: VWAP_TREND_DETACHMENT.

The windows are read from the per-minute snapshots the service stores (``track``: the future's open-interest change since the previous close, call and put open interest near the money, VWAP side and
distance), so they survive a restart and need no extra storage; a window with no stored minute close enough to 15 minutes ago is UNKNOWN, never zero. Open interest is in units (one lot is 65 units).
Nothing here is a forecast: the Entry Lab study of 15 recorded days (D210-D217) found no simple signal that separated trend days from decay days.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.domain.session import SESSION_OPEN
from app.intraday.volatility import CALL, PUT

IST = ZoneInfo("Asia/Kolkata")
LOT = 65
CFG: dict[str, float] = {
    "ib_trend_ratio": 0.65,  # initial balance over the implied daily SD above this: trend-day risk
    "ib_decay_ratio": 0.35,  # below this: range-bound, decay-friendly
    "squeeze_spot_pct": 0.20,  # index change over 15 minutes, percent
    "squeeze_oi_units": -35000.0,  # futures open-interest change over 15 minutes, units (about 540 lots)
    "put_floor_ratio": 2.5,
    "put_floor_spot_pct": 0.10,
    "put_floor_min_share": 0.005,  # added put interest as a share of the put interest near the money (below this it is noise, not a floor)
    "vwap_minutes": 35.0,
    "vwap_distance_pct": 0.22,
    "oi_band_pct": 2.5,  # strikes within this percent of the index count as near the money
    "window_min": 15.0,
    "tolerance_min": 3.0,  # a stored minute this close to the window start stands in for it
    "open_slack_min": 5.0,  # the first stored minute may be this late for the first 30 minutes to count as the opening range
}
TREND_FLAGS = ("ACTIVE_SHORT_SQUEEZE", "VWAP_TREND_DETACHMENT", "IB_EXPANSION_TREND")


def _num(x: Any) -> float | None:
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) and x == x else None


def _g(d: Any, *path: str) -> Any:
    for k in path:
        if not isinstance(d, Mapping):
            return None
        d = d.get(k)
    return d


def _series(a: Mapping[str, Any]) -> list[tuple[datetime, float]]:
    out = []
    for t, s in zip(a.get("times") or [], a.get("spot") or [], strict=False):
        v = _num(s)
        if v is not None and v > 0:
            try:
                out.append((datetime.fromisoformat(t), v))
            except (TypeError, ValueError):
                continue
    return out


def _stamp(at: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(at))
    except (TypeError, ValueError):
        return None


def _around(rows: Sequence[tuple[datetime, Any]], target: datetime, tol_min: float) -> Any:
    """The stored value whose time is nearest ``target``, if within ``tol_min`` minutes (None otherwise)."""
    best: tuple[float, Any] | None = None
    for t, v in rows:
        d = abs((t - target).total_seconds()) / 60
        if d <= tol_min and (best is None or d < best[0]):
            best = (d, v)
    return None if best is None else best[1]


def track_now(oi: Mapping[tuple[float, int], int | None] | None, spot: float | None, mi: Mapping[str, Any], cfg: Mapping[str, float] = CFG) -> dict[str, Any]:
    """The values the windows are read from, for this minute: the future's open-interest change since the previous close, call and put open interest near the money, the VWAP side and distance."""
    fut = _num(_g(mi, "panels", "futures", "oi_change"))
    ce = pe = None
    if oi and spot:
        band = cfg["oi_band_pct"] / 100 * spot
        ce = sum(int(v) for (k, side), v in oi.items() if v and side == CALL and abs(k - spot) <= band)
        pe = sum(int(v) for (k, side), v in oi.items() if v and side == PUT and abs(k - spot) <= band)
    side = _g(mi, "pulse", "vwap", "side")
    return {"fut_oi_chg": fut, "ce_oi": ce, "pe_oi": pe, "vwap_side": side if isinstance(side, str) else None, "vwap_dist_pct": _num(_g(mi, "pulse", "vwap", "distance_pct"))}


def initial_balance(a: Mapping[str, Any], cfg: Mapping[str, float] = CFG) -> dict[str, Any]:
    pts = _series(a)
    sd = _num(_g(a, "realised_vs_implied", "implied_daily_sd_pts"))
    out: dict[str, Any] = {"status": "unknown", "range_pts": None, "daily_sd": sd, "ratio": None, "flag": None, "reason": None}
    if len(pts) < 2:
        return out | {"reason": "no stored minutes"}
    first, last = pts[0][0], pts[-1][0]
    open_at = datetime.combine(first.astimezone(IST).date(), SESSION_OPEN, IST)
    if (first.astimezone(IST) - open_at).total_seconds() / 60 > cfg["open_slack_min"]:
        return out | {"reason": f"the first stored minute is {first.astimezone(IST):%H:%M}, not the open: the stored first half hour is not the opening range"}
    if (last - first).total_seconds() / 60 < 30:
        return out | {"status": "forming", "reason": "the opening 30 minutes are not complete yet"}
    window = [s for t, s in pts if (t - first).total_seconds() / 60 <= 30]
    rng = max(window) - min(window)
    out |= {"range_pts": round(rng, 1)}
    if sd is None or sd <= 0:
        return out | {"reason": "no implied daily standard deviation"}
    ratio = rng / sd
    flag = "IB_EXPANSION_TREND" if ratio > cfg["ib_trend_ratio"] else "IB_COMPRESSION_DECAY" if ratio < cfg["ib_decay_ratio"] else None
    return out | {"status": "ok", "ratio": round(ratio, 2), "flag": flag}


def _spot_change(a: Mapping[str, Any], cfg: Mapping[str, float]) -> tuple[float | None, datetime | None]:
    """Index change over the last 15 minutes in percent, and the time of the latest sample."""
    pts = _series(a)
    if not pts:
        return None, None
    now_t, now_s = pts[-1]
    old = _around(pts, now_t - timedelta(minutes=cfg["window_min"]), cfg["tolerance_min"])
    return (None if old is None else (now_s - old) / old * 100), now_t


def evaluate_live_regime(a: Mapping[str, Any], mi: Mapping[str, Any], track: Mapping[str, Any], history: Sequence[tuple[str, Mapping[str, Any] | None]], cfg: Mapping[str, float] = CFG) -> dict[str, Any]:
    """The four readings for the newest stored minute. ``track`` is this minute's ``track_now``; ``history`` is the stored (time, track) of the minutes before it, newest first."""
    spot_pct, now_t = _spot_change(a, cfg)
    rows = [(t, tr) for at, tr in history if (t := _stamp(at)) is not None and isinstance(tr, Mapping)]
    ago = None if now_t is None else now_t - timedelta(minutes=cfg["window_min"])

    def window_change(key: str) -> float | None:
        now_v, old = _num(track.get(key)), None if ago is None else _around([(t, _num(tr.get(key))) for t, tr in rows], ago, cfg["tolerance_min"])
        return None if now_v is None or old is None else now_v - old

    ib = initial_balance(a, cfg)
    flags: list[dict[str, str]] = []
    if ib["flag"] == "IB_EXPANSION_TREND":
        flags.append({"id": "IB_EXPANSION_TREND", "severity": "high", "message": f"The opening 30 minutes covered {ib['range_pts']:.0f} points, {ib['ratio']:.2f} of the implied daily move ({ib['daily_sd']:.0f}): trend-day risk"})
    elif ib["flag"] == "IB_COMPRESSION_DECAY":
        flags.append({"id": "IB_COMPRESSION_DECAY", "severity": "info", "message": f"The opening 30 minutes covered {ib['range_pts']:.0f} points, only {ib['ratio']:.2f} of the implied daily move: range-bound so far"})

    fut_oi = window_change("fut_oi_chg")
    squeeze: dict[str, Any] = {"status": "unknown", "spot_change_15m_pct": None if spot_pct is None else round(spot_pct, 3), "fut_oi_change_15m": None if fut_oi is None else round(fut_oi), "active": False}
    if spot_pct is not None and fut_oi is not None:
        squeeze["status"] = "ok"
        if spot_pct > cfg["squeeze_spot_pct"] and fut_oi < cfg["squeeze_oi_units"]:
            squeeze["active"] = True
            msg = (f"Short squeeze in progress: NIFTY {spot_pct:+.2f}% in 15 minutes while futures open interest shed {abs(fut_oi):,.0f} units ({abs(fut_oi) / LOT:,.0f} lots). "
                   "Do not sell at-the-money calls or straddles.")  # fmt: skip
            squeeze["message"] = msg
            flags.append({"id": "ACTIVE_SHORT_SQUEEZE", "severity": "high", "message": msg})
    else:
        squeeze["reason"] = "no 15-minute index change" if spot_pct is None else "no stored futures open interest 15 minutes ago"

    ce, pe = window_change("ce_oi"), window_change("pe_oi")
    pe_now = _num(track.get("pe_oi"))
    floor: dict[str, Any] = {"status": "unknown", "call_additions_15m": None if ce is None else round(ce), "put_additions_15m": None if pe is None else round(pe), "active": False}
    if ce is not None and pe is not None and spot_pct is not None:
        floor["status"] = "ok"
        big = pe_now is not None and pe_now > 0 and pe > 0 and pe > cfg["put_floor_ratio"] * max(ce, 0.0) and pe >= cfg["put_floor_min_share"] * pe_now
        if big and spot_pct > cfg["put_floor_spot_pct"]:
            floor["active"] = True
            msg = f"Put floor advancing: {pe:,.0f} units of put open interest added against {max(ce, 0):,.0f} on calls in 15 minutes while NIFTY rose {spot_pct:+.2f}%"
            floor["message"] = msg
            flags.append({"id": "PUT_FLOOR_ADVANCING", "severity": "medium", "message": msg})
    else:
        floor["reason"] = "no stored option open interest 15 minutes ago" if spot_pct is not None else "no 15-minute index change"

    vwap: dict[str, Any] = {"status": "unknown", "minutes_away": None, "at_least": False, "distance_pct": track.get("vwap_dist_pct"), "active": False}
    side = track.get("vwap_side")
    if side and now_t is not None and _num(track.get("vwap_dist_pct")) is not None:
        start, reached_oldest = now_t, True
        for t, tr in rows:
            if tr.get("vwap_side") == side:
                start = min(start, t)
            else:
                reached_oldest = False
                break
        away = (now_t - start).total_seconds() / 60
        vwap |= {"status": "ok", "minutes_away": round(away), "at_least": reached_oldest and bool(rows), "side": side}
        if away > cfg["vwap_minutes"] and abs(float(track["vwap_dist_pct"])) > cfg["vwap_distance_pct"]:
            vwap["active"] = True
            msg = f"NIFTY has stayed {side} the future's VWAP for {'at least ' if vwap['at_least'] else ''}{away:.0f} minutes and is {abs(float(track['vwap_dist_pct'])):.2f}% away: mean reversion has broken, the market is running one way"
            vwap["message"] = msg
            flags.append({"id": "VWAP_TREND_DETACHMENT", "severity": "high", "message": msg})
    else:
        vwap["reason"] = "no VWAP side or distance"

    ids = {f["id"] for f in flags}
    known = [ib["status"] == "ok", squeeze["status"] == "ok", floor["status"] == "ok", vwap["status"] == "ok"]
    label = "TREND_RISK" if ids & set(TREND_FLAGS) else "DECAY_FAVOURED" if "IB_COMPRESSION_DECAY" in ids and not floor["active"] else "UNCLEAR" if any(known) else "NO_DATA"
    return {"label": label, "flags": flags, "ib": ib, "squeeze": squeeze, "put_floor": floor, "vwap": vwap, "track": dict(track), "any_known": any(known),
            "note": "Working thresholds, not validated; a description of the stored minutes, not a forecast."}  # fmt: skip
