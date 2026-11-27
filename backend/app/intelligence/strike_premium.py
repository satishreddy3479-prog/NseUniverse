"""Strike premium: what moved the price of ONE chosen contract (a strike's straddle, call or put), split into theta, vega, delta, gamma, the vol-spot cross terms and the remainder (pure functions, no I/O).

The contract is held fixed (or, in ATM-following mode, the at-the-money straddle is followed with each step measured on one contract, so a change of strike adds no jump). Between every two stored samples the contract's
price change is repriced with the straddle engine's own Shapley attribution (``straddle.attribute_leg``); the steps are summed, so over any stretch the parts add up to the contract's real price change (the remainder is
what the repricing does not explain). Last traded prices, Black-76 with the forward from put-call parity and the app's assumed rate; before costs. A description of what happened, not a forecast.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import timedelta, timezone
from typing import Any

from app.intelligence import straddle as sd
from app.intraday.volatility import CALL, DEFAULT_RATE, PUT

IST = timezone(timedelta(hours=5, minutes=30))
CONTRACTS = {"straddle": "both", "call": "ce", "put": "pe"}
PARTS = ("theta", "vega", "delta", "gamma", "cross", "other")
OPEN_MIN = 9 * 60 + 15
NOTE = ("Last traded prices; Black-76 with the forward from put-call parity and the app's assumed rate. The parts are a repricing between stored samples, summed: they add up to the contract's real price change, "
        "and 'other' holds what the repricing does not explain (quote noise, a forward a little off). A description of what happened, not a forecast.")


def _parts(x: Mapping[str, float]) -> dict[str, float]:
    """The six displayed parts of one step or sum: vanna and volga together as 'cross', the repricing residual as 'other'."""
    return {"theta": x["theta"], "vega": x["vega"], "delta": x["delta"], "gamma": x["gamma"], "cross": x["vanna"] + x["volga"], "other": x["residual"], "actual": x["actual"]}


def _zero() -> dict[str, float]:
    return dict.fromkeys((*PARTS, "actual"), 0.0)


def _add(a: dict[str, float], b: Mapping[str, float]) -> None:
    for k in a:
        a[k] += b[k]


def _r(d: Mapping[str, float] | None, n: int = 3) -> dict[str, float] | None:
    return None if d is None else {k: round(v, n) for k, v in d.items()}


def driver(p: Mapping[str, float]) -> dict[str, Any]:
    """The part with the largest size, as the reader would name it: time, volatility (vega and cross), NIFTY moving (delta and gamma) or other."""
    cands = {"time": p["theta"], "volatility": p["vega"] + p["cross"], "NIFTY": p["delta"] + p["gamma"], "other": p["other"]}
    name = max(cands, key=lambda k: abs(cands[k]))
    return {"name": name, "value": round(cands[name], 2)}


def _price(snap: sd.Snap, k: float, contract: str) -> float | None:
    c, p = snap.prices.get((k, CALL)), snap.prices.get((k, PUT))
    if contract == "straddle":
        return None if c is None or p is None else c + p
    return c if contract == "call" else p


def _held(pts: Sequence[sd.Point | None], mode: str, strike: float | None) -> list[float | None]:
    if mode == "atm":
        return [None if p is None else sd.nearest(p.strikes, p.spot) for p in pts]
    return [strike] * len(pts)


def analyse(
    snaps: Sequence[sd.Snap], pts: Sequence[sd.Point | None], *, strike: float | None, contract: str = "straddle", mode: str = "fixed", window: int | None = 30, bucket: int = 5, each: int = 5,
    lot_size: int = sd.LOT_SIZE, rate: float = DEFAULT_RATE,
) -> dict[str, Any]:
    """The account of one contract over a stored session. ``strike`` None means the at-the-money strike of the newest usable sample; ``window`` None means since the open."""
    n = len(snaps)
    usable = [i for i in range(n) if pts[i] is not None]
    if contract not in CONTRACTS or mode not in ("fixed", "atm") or len(usable) < 3:
        return {"status": "unavailable", "message": "Not enough stored samples with prices to split a premium change (needs three).", "rate_assumed": rate}
    last = usable[-1]
    pl = pts[last]
    assert pl is not None
    k_now = sd.nearest(pl.strikes, pl.spot)
    k = float(strike) if strike is not None else (k_now if k_now is not None else None)
    if k is None or (mode == "fixed" and k not in pl.strikes):
        return {"status": "unavailable", "message": f"Strike {strike:g} is not listed in the stored chain." if strike is not None else "No at-the-money strike.", "rate_assumed": rate}
    held = _held(pts, mode, k)
    steps, skipped = sd.attribute_steps(pts, held)
    key = CONTRACTS[contract]
    # ---------- series of the contract's price, NIFTY, cumulative parts from the first usable sample
    times = [s.at.isoformat() for s in snaps]
    spots = [s.spot for s in snaps]
    price: list[float | None] = [None if held[i] is None else _price(snaps[i], float(held[i]), contract) for i in range(n)]  # type: ignore[arg-type]
    cum_run = _zero()
    cum: dict[str, list[float | None]] = {p: [] for p in (*PARTS, "actual")}
    per_step: list[dict[str, float] | None] = [None] * n
    for i in range(n):
        st = steps[i] if i < len(steps) else None
        if st is not None:
            per_step[i] = _parts(st[key])
            _add(cum_run, per_step[i])  # type: ignore[arg-type]
        for p in cum:
            cum[p].append(round(cum_run[p], 3))
    # ---------- bars of the chosen bucket length, anchored at 09:15 IST
    bars: list[dict[str, Any]] = []
    cur: dict[str, float] | None = None
    cur_b: int | None = None
    cur_t: str | None = None
    for i in range(n):
        ps = per_step[i]
        if ps is None:
            continue
        minute = snaps[i].at.astimezone(IST)
        b = ((minute.hour * 60 + minute.minute) - OPEN_MIN) // max(1, bucket)
        if cur_b is not None and b != cur_b and cur is not None and cur_t is not None:
            bars.append({"t": cur_t, **_r(cur)})  # type: ignore[dict-item]
            cur = None
        if cur is None:
            cur = _zero()
        cur_b, cur_t = b, snaps[i].at.isoformat()
        _add(cur, ps)
    if cur is not None and cur_t is not None:
        bars.append({"t": cur_t, **_r(cur)})  # type: ignore[dict-item]
    # ---------- the chosen window
    start = 0
    if window is not None:
        cut = snaps[last].at - timedelta(minutes=window)
        start = next((i for i in range(last + 1) if snaps[i].at >= cut), 0)
    first_usable = next((i for i in range(start, last + 1) if price[i] is not None), None)
    win = _zero()
    used = 0
    for i in range(start + 1, last + 1):
        if per_step[i] is not None:
            _add(win, per_step[i])  # type: ignore[arg-type]
            used += 1
    p_start, p_end = (None if first_usable is None else price[first_usable]), price[last]
    summary = {
        "from": snaps[start].at.isoformat(), "to": snaps[last].at.isoformat(), "minutes": round((snaps[last].at - snaps[start].at).total_seconds() / 60), "steps": used,
        "price_start": None if p_start is None else round(p_start, 2), "price_end": None if p_end is None else round(p_end, 2), "parts": _r(win),
        "real_change": None if p_start is None or p_end is None else round(p_end - p_start, 3),
        "driver": driver(win), "nifty_start": spots[start], "nifty_end": spots[last],
    }
    # ---------- the ladder: every strike's call and put over the same window
    strikes = pl.strikes
    ia = min(range(len(strikes)), key=lambda j: (abs(strikes[j] - pl.spot), strikes[j]))
    ladder: list[dict[str, Any]] = []
    for kk in strikes[max(0, ia - each) : ia + each + 1]:
        row: dict[str, Any] = {"strike": kk, "atm": kk == k_now}
        for name, side in (("call", CALL), ("put", PUT)):
            acc, ok, miss = _zero(), 0, 0
            for i in range(start + 1, last + 1):
                pa, pb = pts[i - 1], pts[i]
                x = sd.attribute_leg(pa, pb, kk, side) if pa is not None and pb is not None else None
                if x is None:
                    miss += 1
                    continue
                _add(acc, _parts(x))
                ok += 1
            p0, p1 = snaps[start].prices.get((kk, side)), snaps[last].prices.get((kk, side))
            row[name] = {"price": None if p1 is None else round(p1, 2), "change": None if p0 is None or p1 is None else round(p1 - p0, 2), "parts": _r(acc, 2) if ok else None, "driver": driver(acc) if ok else None, "complete": miss == 0 and ok > 0}
        ladder.append(row)
    # ---------- Greeks now of the followed contract(s)
    held_last = held[last]
    kn = float(held_last) if held_last is not None else k
    legs = {"call": pl.leg(kn, CALL), "put": pl.leg(kn, PUT)}
    use = [v for name, v in legs.items() if v is not None and (contract == "straddle" or name == contract)]
    greeks_now: dict[str, Any] | None = None
    if use:
        greeks_now = {"strike": kn, "delta": round(sum(v.g.delta for v in use), 4), "gamma": round(sum(v.g.gamma for v in use), 6), "theta_day": round(sum(v.g.theta_day for v in use), 2),
                      "vega_pt": round(sum(v.g.vega_pt for v in use), 3), "iv_pct": round(sum(v.iv for v in use) / len(use) * 100, 2)}
    return {
        "status": "ok", "strike": k, "strike_now": k_now, "mode": mode, "contract": contract, "window": window, "bucket": bucket, "lot_size": lot_size, "rate_assumed": rate, "note": NOTE, "skipped_steps": skipped,
        "series": {"t": times, "spot": spots, "price": [None if v is None else round(v, 2) for v in price], "cum": cum}, "bars": bars, "summary": summary, "ladder": ladder, "greeks_now": greeks_now,
        "strikes": strikes,
    }
