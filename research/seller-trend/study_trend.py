# Run on the production server against COPIES of the stored databases (read-only on the originals):
#   copy observations.sqlite3 and market.sqlite3 with the sqlite3 backup API to /tmp/study, then
#   nice -n 10 /opt/nse-universe/venv/bin/python study_trend.py
# Result of 27 Nov 2026 is in docs/decisions.md (D341).
"""Read-only study on COPIES of the stored data: does the trend / structure reading at minute t go with what a seller of the ATM straddle (fixed strike, no re-strike) made in the next 30 minutes?

Outcome = straddle price at t minus the same strike's straddle price 30 minutes later (positive = the seller gained), in percent of the price at t. Readings use data up to t only.
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
D = Path("/tmp/study")


def session_structure(closes):
    sides, total, last = [], 0.0, 0.0
    for i, c in enumerate(closes):
        total += c
        m = total / (i + 1)
        sides.append((c > m) - (c < m))
        last = c - m
    if len(sides) < 2:
        return None
    nz = [s for s in sides if s != 0]
    cr = sum(1 for i in range(1, len(nz)) if nz[i] != nz[i - 1])
    return {"n": len(sides), "crossings": cr, "distance": last}


TREND_VALUE = {"Range-bound": 0.6, "Mixed": 0.1, "Weak uptrend": -0.4, "Weak downtrend": -0.4, "Trending up": -1.0, "Trending down": -1.0}
clip = lambda x: max(-1.0, min(1.0, x))  # noqa: E731


def trend_val(label):
    if label is None:
        return None
    base = label.replace(" (fading)", "")
    v = TREND_VALUE.get(base)
    if v is not None and label.endswith("(fading)") and v < 0:
        v /= 2
    return v


def struct_val(st, atr):
    if not st or st["n"] < 6:
        return None
    parts = [clip((st["crossings"] / max(1, st["n"] - 1) - 0.12) / 0.12)]
    if atr:
        parts.append(max(-1.0, 0.6 - abs(st["distance"] / atr) / 1.5))
    return sum(parts) / len(parts)


mk = MarketStore(D)
obs = ObservationStore(D)
rows = mk.samples_since("index1m", "2020-01-01T00:00:00+00:00")
by_day = defaultdict(list)
for a, p in rows:
    t = datetime.fromisoformat(a)
    by_day[t.astimezone(IST).date()].append({"at": a, "o": p["o"], "h": p["h"], "l": p["l"], "c": p["c"], "n": p.get("n")})
svc = StraddleDecay(observations=obs, underlying="NIFTY", gex=None, rate=0.06)
pooled = []
print("days with index bars:", sorted(str(d) for d in by_day))
for day in sorted(by_day):
    if day.weekday() >= 5:
        continue
    ex = svc._expiries(day)
    if not ex or len(by_day[day]) < 200:
        continue
    snaps, _ = svc._read(ex[0], day, None)
    bars1 = te.parse_bars(by_day[day])
    bars5 = te.aggregate(bars1)
    series = te.regime_series(bars1)
    closes = [b["c"] for b in bars5]
    n = 0
    for s in snaps[::5]:
        j = max((i for i, r in enumerate(series) if r["t"] + timedelta(minutes=5) <= s.at), default=None)
        if j is None or j < 6:
            continue
        fut = next((x for x in snaps if x.at >= s.at + timedelta(minutes=30) and x.at <= s.at + timedelta(minutes=33)), None)
        if fut is None or not s.spot:
            continue
        strikes = sorted({k for k, _ in s.prices})
        K = min(strikes, key=lambda k: abs(k - s.spot))
        c0, q0, c1, q1 = s.prices.get((K, CALL)), s.prices.get((K, PUT)), fut.prices.get((K, CALL)), fut.prices.get((K, PUT))
        if None in (c0, q0, c1, q1) or c0 + q0 <= 0:
            continue
        gain_pct = ((c0 + q0) - (c1 + q1)) / (c0 + q0) * 100
        atr = te._atr(bars5[: j + 1])
        tv = trend_val(series[j]["label"]) if series[j]["label"] != "Warming up" else None
        sv = struct_val(session_structure(closes[: j + 1]), atr)
        pooled.append({"day": str(day), "gain": gain_pct, "label": series[j]["label"], "tv": tv, "sv": sv})
        n += 1
    print(day, "samples", n)


def report(title, key, buckets):
    print("\n" + title)
    for name, test in buckets:
        g = [r["gain"] for r in pooled if test(r)]
        days = {r["day"] for r in pooled if test(r)}
        if g:
            print(f"  {name:28s} n={len(g):4d} days={len(days):2d} mean seller gain next 30 min {mean(g):+6.2f}%  share positive {100*sum(1 for x in g if x>0)/len(g):4.0f}%")


report("By trend class at t (label stripped of fading):", "tv", [
    ("Range-bound", lambda r: r["tv"] == 0.6), ("Mixed", lambda r: r["tv"] == 0.1), ("Weak trend", lambda r: r["tv"] == -0.4),
    ("Trending", lambda r: r["tv"] == -1.0), ("Trending, fading", lambda r: r["tv"] == -0.5),
])
report("By session-structure value at t:", "sv", [
    ("sv >= +0.3 (range-like)", lambda r: r["sv"] is not None and r["sv"] >= 0.3),
    ("-0.3 < sv < +0.3", lambda r: r["sv"] is not None and -0.3 < r["sv"] < 0.3),
    ("sv <= -0.3 (one-sided)", lambda r: r["sv"] is not None and r["sv"] <= -0.3),
])
print("\nPer day: mean gain when trend value >= 0 vs < 0")
for day in sorted({r["day"] for r in pooled}):
    a = [r["gain"] for r in pooled if r["day"] == day and r["tv"] is not None and r["tv"] >= 0]
    b = [r["gain"] for r in pooled if r["day"] == day and r["tv"] is not None and r["tv"] < 0]
    print(f"  {day}  calm n={len(a):3d} {(mean(a) if a else float('nan')):+6.2f}%   trending n={len(b):3d} {(mean(b) if b else float('nan')):+6.2f}%")
print("\ntotal samples", len(pooled))
