"""Quant study on COPIES of the stored data (read-only on the originals): does the Trend & Regime / Session Structure reading predict GAMMA (movement) against THETA (time), which is what a straddle seller is exposed to?

A straddle is sold at the ATM strike at minute t and the SAME strike is held for H minutes. Its price change is split minute by minute with the straddle engine's own Shapley attribution (theta, vega, delta, gamma, vanna, volga, residual).
Outcomes over the next H minutes, in percent of the straddle price at t:
  THETA  = the premium time alone would have taken out (the seller's income)
  GAMMA  = the premium movement put back (the seller's cost), delta and gamma terms together = what NIFTY's path did
  MOVE   = GAMMA - THETA   (positive: movement beat time; this is the trend-versus-decay quantity)
  VEGA   = the premium change from implied volatility
  PNL    = p(t) - p(t+H): the seller's total result
Readings are those known at t only (completed 5-minute bars). Models are fitted on other sessions and tested on the held-out one (leave-one-session-out).
"""

import math
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, "/opt/nse-universe/current/backend")
from app.intelligence import straddle as sd  # noqa: E402
from app.intelligence import trend_engine as te  # noqa: E402
from app.intelligence.straddle_service import StraddleDecay  # noqa: E402
from app.market.store import MarketStore  # noqa: E402
from app.storage.observations import ObservationStore  # noqa: E402

H = int(sys.argv[1]) if len(sys.argv) > 1 else 30
STEP = 5  # sample every 5th stored minute
IST = timezone(timedelta(hours=5, minutes=30))
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
svc = StraddleDecay(observations=obs, underlying="NIFTY", gex=None, rate=sd.DEFAULT_RATE)


def session_structure(closes):
    sides, total, last = [], 0.0, 0.0
    for i, c in enumerate(closes):
        total += c
        m = total / (i + 1)
        sides.append((c > m) - (c < m))
        last = c - m
    nz = [x for x in sides if x != 0]
    return {"n": len(sides), "crossings": sum(1 for i in range(1, len(nz)) if nz[i] != nz[i - 1]), "distance": last}


def window(steps, lo, hi):
    """Sum of the steps lo+1..hi (step i is points[i-1] -> points[i]); None when any is missing."""
    use = steps[lo + 1 : hi + 1]
    if not use or any(s is None for s in use):
        return None
    tot = dict.fromkeys(("theta", "vega", "delta", "gamma", "vanna", "volga", "residual", "actual"), 0.0)
    for s in use:
        for k in tot:
            tot[k] += s["both"][k]
    return tot


rows = []
for day in sorted(by_day):
    if day.weekday() >= 5 or len(by_day[day]) < 200:
        continue
    ex = svc._expiries(day)
    if not ex:
        continue
    exp_date = date.fromisoformat(ex[0])
    snaps, _ = svc._read(ex[0], day, None)
    if len(snaps) < 100:
        continue
    pts = [sd.build_point(s, exp_date)[0] for s in snaps]
    bars1 = te.parse_bars(by_day[day])
    bars5 = te.aggregate(bars1)
    series = te.regime_series(bars1)
    closes = [b["c"] for b in bars5]
    futs = fut_day.get(day, [])
    cache = {}

    def steps_for(K):
        if K not in cache:
            cache[K] = sd.attribute_steps(pts, [K] * len(pts))[0]
        return cache[K]

    for si in range(0, len(snaps), STEP):
        s = snaps[si]
        if not s.spot or pts[si] is None:
            continue
        sj = next((i for i in range(si + 1, len(snaps)) if snaps[i].at >= s.at + timedelta(minutes=H)), None)
        if sj is None or snaps[sj].at > s.at + timedelta(minutes=H + 3):
            continue
        sp = next((i for i in range(si, -1, -1) if snaps[i].at <= s.at - timedelta(minutes=30)), None)
        j = max((i for i, b in enumerate(bars5) if b["t"] + timedelta(minutes=5) <= s.at), default=None)
        if j is None or j < 6 or series[j]["score"] is None:
            continue
        strikes = sorted({k for k, _ in s.prices})
        K = min(strikes, key=lambda k: abs(k - s.spot))
        st = steps_for(K)
        fwd = window(st, si, sj)
        from app.intraday.volatility import CALL, PUT
        c0, q0, c1, q1 = s.prices.get((K, CALL)), s.prices.get((K, PUT)), snaps[sj].prices.get((K, CALL)), snaps[sj].prices.get((K, PUT))
        if fwd is None or None in (c0, q0, c1, q1) or c0 + q0 <= 0:
            continue
        p0 = c0 + q0
        pct = lambda x: x / p0 * 100  # noqa: E731
        theta_inc, gam = -fwd["theta"], fwd["gamma"] + fwd["delta"]
        past = window(st, sp, si) if sp is not None else None
        past_move = None if past is None else pct((past["gamma"] + past["delta"]) - (-past["theta"]))
        m = series[j]["metrics"]
        atr = te._atr(bars5[: j + 1]) or 0.0
        ss = session_structure(closes[: j + 1])
        fx = [f for f in futs if f[0] <= s.at]
        feats_ok = all(v is not None and v == v for v in (m["er"], m["adx"], m["r2"], m["chop"], m["slope"], m["plus_di"], m["minus_di"]))
        if not feats_ok or not atr:
            continue
        rows.append({
            "day": str(day), "dte0": exp_date == day, "tod": ((s.at.astimezone(IST).hour * 60 + s.at.astimezone(IST).minute) - 555) / 375,
            "label": series[j]["label"].replace(" (fading)", ""), "fading": series[j]["fading"], "score": series[j]["score"],
            "er": m["er"], "adx": m["adx"], "r2": m["r2"], "chop": m["chop"], "di": (m["plus_di"] - m["minus_di"]) if m["plus_di"] is not None and m["minus_di"] is not None else 0.0,
            "slope_atr": abs(m["slope"]) / atr if atr and m["slope"] is not None else 0.0,
            "cross": ss["crossings"] / max(1, ss["n"] - 1), "dist_atr": abs(ss["distance"]) / atr if atr else 0.0, "vw": abs(fx[-1][1] - fx[-1][2]) / fx[-1][2] * 100 if fx else 0.0,
            "past_move": past_move if past_move is not None else 0.0,
            "THETA": pct(theta_inc), "GAMMA": pct(gam), "MOVE": pct(gam - theta_inc), "VEGA": pct(fwd["vega"]), "PNL": pct(p0 - (c1 + q1)),
        })
    print(day, "rows so far", len(rows), flush=True)

print(f"\nH = {H} minutes, samples {len(rows)}, sessions {len({r['day'] for r in rows})}, expiry-day samples {sum(1 for r in rows if r['dte0'])}\n")


def mean(x):
    return sum(x) / len(x) if x else float("nan")


def table(title, keyf, order, rs):
    print(title)
    for name in order:
        g = [r for r in rs if keyf(r) == name]
        if not g:
            continue
        days = len({r["day"] for r in g})
        print(f"  {name:20s} n={len(g):4d} days={days:2d}  THETA {mean([r['THETA'] for r in g]):6.2f}%  GAMMA {mean([r['GAMMA'] for r in g]):6.2f}%  MOVE {mean([r['MOVE'] for r in g]):+6.2f}%  "
              f"P(move>time) {100 * mean([1.0 if r['MOVE'] > 0 else 0.0 for r in g]):4.0f}%  VEGA {mean([r['VEGA'] for r in g]):+6.2f}%  PNL {mean([r['PNL'] for r in g]):+6.2f}%")
    print()


ORDER = ["Range-bound", "Mixed", "Weak uptrend", "Weak downtrend", "Trending up", "Trending down"]
for title, rs in (("ALL SESSIONS", rows), ("EXCLUDING EXPIRY-DAY SAMPLES", [r for r in rows if not r["dte0"]])):
    print("=== " + title)
    table("By the trend/regime class known at t:", lambda r: r["label"], ORDER, rs)
    table("By trend/regime class group:", lambda r: "calm (Range/Mixed)" if r["label"] in ("Range-bound", "Mixed") else "trend (Weak/Trending)", ["calm (Range/Mixed)", "trend (Weak/Trending)"], rs)

def analyse(rows, label):
    print('##################  ' + label + '  ##################')
    # ---- rank correlation of each reading with the forward MOVE (movement minus time), pooled and per session
    def ranks(x):
        o = np.argsort(np.argsort(x))
        return o.astype(float)


    def spearman(a, b):
        if len(a) < 10 or np.std(a) == 0 or np.std(b) == 0:
            return float("nan")
        return float(np.corrcoef(ranks(a), ranks(b))[0, 1])


    FEATS = ["score", "er", "adx", "r2", "chop", "slope_atr", "cross", "dist_atr", "vw", "past_move", "tod"]
    print("Spearman correlation of each reading at t with the forward MOVE (gamma minus theta), pooled; and the number of sessions (of those with data) where the sign agrees with the pooled sign")
    days = sorted({r["day"] for r in rows})
    for f in FEATS:
        a = np.array([r[f] for r in rows], float)
        y = np.array([r["MOVE"] for r in rows], float)
        rho = spearman(a, y)
        per = []
        for d in days:
            idx = [i for i, r in enumerate(rows) if r["day"] == d]
            if len(idx) >= 12:
                per.append(spearman(a[idx], y[idx]))
        agree = sum(1 for x in per if not math.isnan(x) and (x > 0) == (rho > 0))
        print(f"  {f:10s} rho={rho:+.3f}   same sign in {agree} of {len(per)} sessions")

    # ---- leave-one-session-out ridge model for the forward MOVE
    def design(rs, cols):
        return np.array([[r[c] for c in cols] for r in rs], float)


    def fit_predict(train, test, cols, lam=20.0):
        X, y = design(train, cols), np.array([r["MOVE"] for r in train], float)
        mu, sdv = X.mean(0), X.std(0)
        sdv[sdv == 0] = 1.0
        Xs = (X - mu) / sdv
        w = np.linalg.solve(Xs.T @ Xs + lam * np.eye(Xs.shape[1]), Xs.T @ (y - y.mean()))
        return ((design(test, cols) - mu) / sdv) @ w + y.mean(), w


    MODELS = {
        "persistence only (past 30-min movement vs time)": ["past_move"],
        "time of day only": ["tod"],
        "trend/regime readings": ["score", "er", "adx", "r2", "chop", "slope_atr"],
        "session structure (TWAP crossings, distance, VWAP)": ["cross", "dist_atr", "vw"],
        "trend/regime + structure": ["score", "er", "adx", "r2", "chop", "slope_atr", "cross", "dist_atr", "vw"],
        "all of them + persistence + time of day": FEATS,
    }
    print("\nLeave-one-session-out: rank correlation of the prediction with the realised MOVE on the held-out session (pooled), and how often the lower-risk half had the lower MOVE")
    oos = {}
    for name, cols in MODELS.items():
        preds, ys, ds = [], [], []
        for d in days:
            tr, te_ = [r for r in rows if r["day"] != d], [r for r in rows if r["day"] == d]
            if len(te_) < 5:
                continue
            p, _ = fit_predict(tr, te_, cols)
            preds += list(p)
            ys += [r["MOVE"] for r in te_]
            ds += [d] * len(te_)
        preds, ys = np.array(preds), np.array(ys)
        base = np.array([mean([r["MOVE"] for r in rows if r["day"] != d]) for d in ds])
        r2 = 1 - np.sum((ys - preds) ** 2) / np.sum((ys - base) ** 2)
        oos[name] = (preds, ys, np.array(ds))
        print(f"  {name:55s} rho={spearman(preds, ys):+.3f}   R2 vs the training mean {r2:+.3f}")

    # ---- the smart system, backtested: sell only when the predicted movement-vs-time risk is in the calm half (threshold from the training sessions)
    print("\nBACKTEST: sell the ATM straddle at t and hold the same strike H minutes. 'Calm half' = predicted MOVE below the median of the training sessions' predictions. Percent of the premium, before costs.")
    for name in ("trend/regime readings", "trend/regime + structure", "all of them + persistence + time of day"):
        cols = MODELS[name]
        sel, rest = [], []
        for d in days:
            tr, te_ = [r for r in rows if r["day"] != d], [r for r in rows if r["day"] == d]
            if len(te_) < 5:
                continue
            ptr, _ = fit_predict(tr, tr, cols)
            thr = float(np.median(ptr))
            pte, _ = fit_predict(tr, te_, cols)
            for r, p in zip(te_, pte):
                (sel if p <= thr else rest).append(r)
        def stats(rs):
            pn = sorted(r["PNL"] for r in rs)
            return f"n={len(rs):4d} mean PNL {mean(pn):+6.2f}%  win {100 * mean([1.0 if x > 0 else 0.0 for x in pn]):3.0f}%  5th pct {pn[int(0.05 * len(pn))]:+7.2f}%  mean MOVE {mean([r['MOVE'] for r in rs]):+6.2f}%"
        print(f"  {name}")
        print(f"    calm half   {stats(sel)}")
        print(f"    risky half  {stats(rest)}")
        both = sel + rest
        print(f"    all         {stats(both)}")
        per = []
        for d in days:
            a = [r["PNL"] for r in sel if r["day"] == d]
            b = [r["PNL"] for r in rest if r["day"] == d]
            if a and b:
                per.append(mean(a) - mean(b))
        print(f"    calm minus risky PNL, by session: better in {sum(1 for x in per if x > 0)} of {len(per)} sessions; mean difference {mean(per):+.2f}%")



analyse(rows, 'ALL SESSIONS')
analyse([r for r in rows if not r['dte0']], 'EXCLUDING EXPIRY-DAY SAMPLES (the primary reading: expiry-day premiums decay and move on a different scale)')
