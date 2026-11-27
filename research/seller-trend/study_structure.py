"""Read-only, on COPIES of the stored data. Does each part of the Session Structure reading go with what a seller of the ATM straddle (fixed strike) made, or the worst it went against him, over the next 30 minutes?

Parts: (a) crossings of the session mean (TWAP of the 5-minute closes) per bar, (b) distance of the close from that mean in ATR, (c) distance of the NIFTY future from its own VWAP (the exchange average traded price), in percent.
Outcomes at minute t, in percent of the straddle price at t: GAIN (price at t minus price 30 minutes later; positive = the seller gained) and WORST (the highest the straddle got above its price at t within the 30 minutes; the seller's worst moment).
"""

import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import mean

sys.path.insert(0, "/opt/nse-universe/current/backend")
from app.intelligence import trend_engine as te  # noqa: E402
from app.intelligence.straddle_service import StraddleDecay  # noqa: E402
from app.intraday.volatility import CALL, PUT  # noqa: E402
from app.market.store import MarketStore  # noqa: E402
from app.storage.observations import ObservationStore  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))


def session_structure(closes):
    sides, total, last = [], 0.0, 0.0
    for i, c in enumerate(closes):
        total += c
        m = total / (i + 1)
        sides.append((c > m) - (c < m))
        last = c - m
    if len(sides) < 2:
        return None
    nz = [x for x in sides if x != 0]
    return {"n": len(sides), "crossings": sum(1 for i in range(1, len(nz)) if nz[i] != nz[i - 1]), "distance": last}

D = Path("/tmp/study")
mk, obs = MarketStore(D), ObservationStore(D)
bars_rows = mk.samples_since("index1m", "2020-01-01T00:00:00+00:00")
fut_rows = mk.samples_since("fut", "2020-01-01T00:00:00+00:00")
by_day, fut_day = defaultdict(list), defaultdict(list)
for a, p in bars_rows:
    by_day[datetime.fromisoformat(a).astimezone(IST).date()].append({"at": a, "o": p["o"], "h": p["h"], "l": p["l"], "c": p["c"], "n": p.get("n")})
for a, p in fut_rows:
    t = datetime.fromisoformat(a)
    if p.get("ltp") and p.get("atp"):
        fut_day[t.astimezone(IST).date()].append((t, float(p["ltp"]), float(p["atp"])))
svc = StraddleDecay(observations=obs, underlying="NIFTY", gex=None, rate=0.06)
pool = []
for day in sorted(by_day):
    if day.weekday() >= 5 or len(by_day[day]) < 200:
        continue
    ex = svc._expiries(day)
    if not ex:
        continue
    snaps, _ = svc._read(ex[0], day, None)
    bars5 = te.aggregate(te.parse_bars(by_day[day]))
    closes = [b["c"] for b in bars5]
    futs = fut_day.get(day, [])
    for si in range(0, len(snaps), 5):
        s = snaps[si]
        j = max((i for i, b in enumerate(bars5) if b["t"] + timedelta(minutes=5) <= s.at), default=None)
        if j is None or j < 6 or not s.spot:
            continue
        window = [x for x in snaps[si + 1:] if x.at <= s.at + timedelta(minutes=33)]
        fut = next((x for x in window if x.at >= s.at + timedelta(minutes=30)), None)
        if fut is None:
            continue
        strikes = sorted({k for k, _ in s.prices})
        K = min(strikes, key=lambda k: abs(k - s.spot))
        c0, q0 = s.prices.get((K, CALL)), s.prices.get((K, PUT))
        c1, q1 = fut.prices.get((K, CALL)), fut.prices.get((K, PUT))
        if None in (c0, q0, c1, q1):
            continue
        p0 = c0 + q0
        path = [x.prices.get((K, CALL), 0) + x.prices.get((K, PUT), 0) for x in window if x.prices.get((K, CALL)) and x.prices.get((K, PUT))]
        if p0 <= 0 or not path:
            continue
        gain = (p0 - (c1 + q1)) / p0 * 100
        worst = max(0.0, (max(path) - p0) / p0 * 100)
        st = session_structure(closes[: j + 1])
        atr = te._atr(bars5[: j + 1])
        if not st or st["n"] < 6 or not atr:
            continue
        rate = st["crossings"] / max(1, st["n"] - 1)
        dist_atr = abs(st["distance"]) / atr
        fx = [f for f in futs if f[0] <= s.at]
        vw = abs(fx[-1][1] - fx[-1][2]) / fx[-1][2] * 100 if fx else None
        pool.append({"day": str(day), "gain": gain, "worst": worst, "rate": rate, "dist": dist_atr, "vw": vw})


def terciles(key, label, higher_means):
    vals = sorted(r[key] for r in pool if r[key] is not None)
    if len(vals) < 30:
        print(f"\n{label}: too few samples ({len(vals)})")
        return
    lo, hi = vals[len(vals) // 3], vals[2 * len(vals) // 3]
    print(f"\n{label}   (cut points {lo:.2f} / {hi:.2f}; {higher_means})")
    for name, test in (("low", lambda v: v <= lo), ("middle", lambda v: lo < v <= hi), ("high", lambda v: v > hi)):
        rs = [r for r in pool if r[key] is not None and test(r[key])]
        days = {r["day"] for r in rs}
        print(f"  {name:7s} n={len(rs):4d} days={len(days):2d}  GAIN {mean(r['gain'] for r in rs):+6.2f}%  WORST {mean(r['worst'] for r in rs):5.2f}%")


print("samples", len(pool), "days", len({r["day"] for r in pool}))
terciles("rate", "(a) crossings of the session mean per bar", "high = a range")
terciles("dist", "(b) distance from the session mean in ATR", "high = one-sided")
terciles("vw", "(c) distance of the future from its VWAP, percent", "high = far from the volume-weighted price")
