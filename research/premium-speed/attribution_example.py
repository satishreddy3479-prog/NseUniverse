"""Splits the 5-minute change of an option premium into time decay, spot move and volatility (Black-76), on real stored minutes.

Usage: python attribution_example.py premium_minutes.jsonl out.json

Method, per leg and per 5-minute window with the same strike at both ends:
  F0, T0, IV0 from the premium at the start (forward from put-call parity of the same strike, IV by bisection);
  decay  = price(F0, IV0, T1) - P0            only time passes
  spot   = price(F1, IV0, T1) - price(F0, IV0, T1)   F1 = F0 + (spot1 - spot0)
  vol    = P1 - price(F1, IV0, T1)            what is left: the change of implied volatility AND everything the model does not explain
The three always add up to P1 - P0 (checked below).
"""
import json
import math
import sys
from datetime import date, datetime

R = 0.065


def ncdf(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2))


def b76(F: float, K: float, T: float, iv: float, cp: int) -> float:
    d = math.exp(-R * T)
    if T <= 0 or iv <= 0:
        return d * max(cp * (F - K), 0.0)
    s = iv * math.sqrt(T)
    d1 = (math.log(F / K) + 0.5 * s * s) / s
    d2 = d1 - s
    return d * cp * (F * ncdf(cp * d1) - K * ncdf(cp * d2))


def implied(P: float, F: float, K: float, T: float, cp: int):
    lo, hi = 1e-4, 5.0
    if P < b76(F, K, T, lo, cp) or P > b76(F, K, T, hi, cp):
        return None
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if b76(F, K, T, mid, cp) < P:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def years(day: str, hhmm: str, expiry: str) -> float:
    end = datetime.fromisoformat(expiry + "T15:30:00")
    now = datetime.fromisoformat(day + "T" + hhmm + ":00")
    return max((end - now).total_seconds(), 60) / (365 * 86400)


def split(K, leg0, leg1, spot0, spot1, T0, T1):
    """leg = (ce, pe). Returns {decay, spot, vol, total} for the straddle at strike K, or None."""
    ce0, pe0 = leg0
    ce1, pe1 = leg1
    F0 = K + math.exp(R * T0) * (ce0 - pe0)
    if F0 <= 0:
        return None
    F1 = F0 + (spot1 - spot0)
    out = {"decay": 0.0, "spot": 0.0, "vol": 0.0}
    for cp, p0, p1 in ((1, ce0, ce1), (-1, pe0, pe1)):
        iv0 = implied(p0, F0, K, T0, cp)
        if iv0 is None:
            return None
        a = b76(F0, K, T1, iv0, cp)
        b = b76(F1, K, T1, iv0, cp)
        out["decay"] += a - p0
        out["spot"] += b - a
        out["vol"] += p1 - b
    out["total"] = (ce1 + pe1) - (ce0 + pe0)
    assert abs(out["decay"] + out["spot"] + out["vol"] - out["total"]) < 1e-6
    return out


def main(src: str, dst: str, day: str = "2026-11-25") -> None:
    rows = [json.loads(line) for line in open(src, encoding="utf-8")]
    mm = {r["t"]: r for r in rows if r["d"] == day}
    mins = lambda t: int(t[:2]) * 60 + int(t[3:])  # noqa: E731
    by_m = {mins(t): r for t, r in mm.items()}
    times = [m for m in sorted(by_m) if m >= 9 * 60 + 20 and m % 5 == 0]
    strikes = list(range(25600, 26051, 50))
    exp = by_m[times[0]]["exp"]
    atm_series, per_strike, labels, spot, straddle = [], [], [], [], []
    for m in times:
        r, p = by_m[m], by_m.get(m - 5)
        lab = f"{m // 60:02d}:{m % 60:02d}"
        labels.append(lab)
        spot.append(round(r["spot"], 1))
        a = str(int(r["atm"]))
        ce, pe = r["k"][a]
        straddle.append(round(ce + pe, 1))
        T1 = years(day, lab, exp)
        plab = f"{(m - 5) // 60:02d}:{(m - 5) % 60:02d}"
        T0 = years(day, plab, exp)
        row = []
        for K in strikes:
            k = str(K)
            try:
                s = split(K, p["k"][k], r["k"][k], p["spot"], r["spot"], T0, T1)
            except Exception:
                s = None
            row.append(None if s is None else [round(s["decay"], 2), round(s["spot"], 2), round(s["vol"], 2), round(s["total"], 2)])
        per_strike.append(row)
        try:
            s = split(float(a), p["k"][a], r["k"][a], p["spot"], r["spot"], T0, T1)
        except Exception:
            s = None
        atm_series.append(None if s is None else [round(s["decay"], 2), round(s["spot"], 2), round(s["vol"], 2), round(s["total"], 2)])
    json.dump({"times": labels, "strikes": strikes, "atm": atm_series, "strike": per_strike, "spot": spot, "straddle": straddle, "expiry": exp}, open(dst, "w"))
    ok = [x for x in atm_series if x]
    print(len(ok), "windows; mean decay", round(sum(x[0] for x in ok) / len(ok), 2), "mean |spot|", round(sum(abs(x[1]) for x in ok) / len(ok), 2), "mean |vol|", round(sum(abs(x[2]) for x in ok) / len(ok), 2))
    print("mean total decay over the day (sum):", round(sum(x[0] for x in ok), 1))
    for lab, x in zip(labels, atm_series):
        if x and lab in ("11:00", "11:05", "11:40", "12:10", "13:20"):
            print(lab, x)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
