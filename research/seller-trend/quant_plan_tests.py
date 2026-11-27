"""Quant tests of the seller-engine plan, on COPIES of the stored data (read-only on the originals).

PART A  Can realised variance be forecast from the one-minute index bars? (the core of a gamma forecast)
PART B  Does (forecast realised variance) / (implied variance) tell a seller when selling pays? (30-minute holds of the ATM straddle)
PART C  Backtest of management rules for a sold ATM straddle: hold, re-strike at 100 / 150 / 200 points, premium stops, with and without costs
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
from app.intraday.volatility import CALL, PUT  # noqa: E402
from app.market.store import MarketStore  # noqa: E402
from app.storage.observations import ObservationStore  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
D = Path("/tmp/study")
mk, obs = MarketStore(D), ObservationStore(D)
bars_rows = mk.samples_since("index1m", "2020-01-01T00:00:00+00:00")
by_day = defaultdict(list)
for a, p in bars_rows:
    by_day[datetime.fromisoformat(a).astimezone(IST).date()].append({"at": a, "o": p["o"], "h": p["h"], "l": p["l"], "c": p["c"], "n": p.get("n")})
svc = StraddleDecay(observations=obs, underlying="NIFTY", gex=None, rate=sd.DEFAULT_RATE)
DAYS = [d for d in sorted(by_day) if d.weekday() < 5 and len(by_day[d]) >= 200 and svc._expiries(d)]
mean = lambda x: (sum(x) / len(x)) if len(x) else float("nan")  # noqa: E731


def rank(x):
    return np.argsort(np.argsort(x)).astype(float)


def spearman(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    return float(np.corrcoef(rank(a), rank(b))[0, 1]) if len(a) > 10 and a.std() > 0 and b.std() > 0 else float("nan")


# ================================================================ PART A: forecast realised variance from one-minute bars
mins = {}  # day -> array of squared 1-minute log returns indexed by minute since 09:15 (nan where a minute is missing)
for d in DAYS:
    arr = np.full(380, np.nan)
    bars = sorted(by_day[d], key=lambda b: b["at"])
    prev_c, prev_m = None, None
    for b in bars:
        t = datetime.fromisoformat(b["at"]).astimezone(IST)
        m = (t.hour * 60 + t.minute) - 555
        if m < 0 or m >= 380:
            continue
        if prev_c is not None and m - prev_m == 1 and prev_c > 0 and b["c"] > 0:
            arr[m] = math.log(b["c"] / prev_c) ** 2
        prev_c, prev_m = b["c"], m
    mins[d] = arr

H = 30
samples = []  # one per (day, t)
for d in DAYS:
    arr = mins[d]
    for t in range(35, 340 - H, 5):
        past30, past5, sofar = arr[t - 30 : t], arr[t - 5 : t], arr[:t]
        fwd = arr[t : t + H]
        if np.isnan(fwd).sum() > 3 or np.isnan(past30).sum() > 3 or np.isnan(sofar).sum() > 0.1 * t:
            continue
        samples.append({"day": d, "t": t, "rv5": np.nansum(past5) * 6, "rv30": np.nansum(past30), "rvS": np.nanmean(sofar) * H, "Y": np.nansum(fwd)})
print(f"PART A: {len(samples)} samples (a start every 5 minutes, forward window {H} minutes), {len(DAYS)} sessions")

# seasonal (time-of-day) forward variance from OTHER sessions, same start time
for s in samples:
    others = [x["Y"] for x in samples if x["day"] != s["day"] and x["t"] == s["t"]]
    s["seas"] = mean(others) if others else float("nan")
samples = [s for s in samples if s["seas"] == s["seas"] and s["Y"] > 0 and s["rv5"] > 0 and s["rv30"] > 0]
ly = np.array([math.log(s["Y"]) for s in samples])
days_arr = np.array([str(s["day"]) for s in samples])


def feats(names):
    return np.array([[math.log(s[n]) for n in names] for s in samples])


def loso_r2(X):
    pred = np.zeros(len(ly))
    for d in sorted(set(days_arr)):
        tr, te_ = days_arr != d, days_arr == d
        if X is None:
            pred[te_] = ly[tr].mean()
            continue
        mu, sdv = X[tr].mean(0), X[tr].std(0)
        sdv[sdv == 0] = 1
        A = (X[tr] - mu) / sdv
        w = np.linalg.solve(A.T @ A + 5.0 * np.eye(A.shape[1]), A.T @ (ly[tr] - ly[tr].mean()))
        pred[te_] = ((X[te_] - mu) / sdv) @ w + ly[tr].mean()
    base = np.zeros(len(ly))
    for d in sorted(set(days_arr)):
        base[days_arr == d] = ly[days_arr != d].mean()
    r2 = 1 - np.sum((ly - pred) ** 2) / np.sum((ly - base) ** 2)
    per = []
    for d in sorted(set(days_arr)):
        m = days_arr == d
        per.append(1 - np.sum((ly[m] - pred[m]) ** 2) / np.sum((ly[m] - base[m]) ** 2))
    return r2, spearman(pred, ly), sum(1 for x in per if x > 0), len(per), pred


print("Out-of-sample (leave one session out) forecast of log(realised variance over the next 30 minutes): R2 against the training mean, rank correlation, sessions where the model beats the mean")
MODELS = {"time of day only (seasonal)": ["seas"], "session average so far": ["rvS"], "last 30 minutes": ["rv30"], "last 5 minutes": ["rv5"],
          "last 30 + session so far": ["rv30", "rvS"], "last 5 + last 30 + session + seasonal": ["rv5", "rv30", "rvS", "seas"]}
best_pred = None
for name, cols in MODELS.items():
    r2, rho, ok, n, pred = loso_r2(feats(cols))
    print(f"  {name:40s} R2 {r2:+.3f}  rho {rho:+.3f}  beats the mean in {ok} of {n} sessions")
    if name.startswith("last 5 + last 30"):
        best_pred = pred
# what is predictable: how much of the variance in forward realised variance a persistence rule explains
print()

# ================================================================ PART B and C need chains
rows_b, c_rows = [], []
for d in DAYS:
    ex = svc._expiries(d)[0]
    exp_date = date.fromisoformat(ex)
    snaps, _ = svc._read(ex, d, None)
    if len(snaps) < 100:
        continue
    pts = [sd.build_point(s, exp_date)[0] for s in snaps]
    dte0 = exp_date == d
    _cache = {}

    def steps_for(K):
        if K not in _cache:
            _cache[K] = sd.attribute_steps(pts, [K] * len(pts))[0]
        return _cache[K]

    def fwd_sum(K, lo, hi):
        use = steps_for(K)[lo + 1 : hi + 1]
        if not use or any(x is None for x in use):
            return None
        return {k: sum(x['both'][k] for x in use) for k in ('theta', 'vega', 'delta', 'gamma')}

    tm = lambda s: (s.at.astimezone(IST).hour * 60 + s.at.astimezone(IST).minute) - 555  # noqa: E731
    # ---------- PART B rows: forecast ratio at t and what the seller got over the next 30 minutes
    smp = {s["t"]: s for s in samples if s["day"] == d}
    for si in range(0, len(snaps), 5):
        s = snaps[si]
        t = tm(s)
        if t not in smp or pts[si] is None or not s.spot:
            continue
        sj = next((i for i in range(si + 1, len(snaps)) if snaps[i].at >= s.at + timedelta(minutes=H)), None)
        if sj is None or snaps[sj].at > s.at + timedelta(minutes=H + 3):
            continue
        strikes = sorted({k for k, _ in s.prices})
        K = min(strikes, key=lambda k: abs(k - s.spot))
        c0, q0, c1, q1 = s.prices.get((K, CALL)), s.prices.get((K, PUT)), snaps[sj].prices.get((K, CALL)), snaps[sj].prices.get((K, PUT))
        legc, legp = pts[si].leg(K, CALL), pts[si].leg(K, PUT)
        if None in (c0, q0, c1, q1) or legc is None or legp is None or c0 + q0 <= 0:
            continue
        iv = (legc.iv + legp.iv) / 2
        implied_var_30 = iv * iv / (252 * 375) * H  # variance of the 30-minute log return in trading time
        sm = smp[t]
        fc = math.exp(best_pred[[i for i, x in enumerate(samples) if x is sm][0]]) if best_pred is not None else sm["seas"]
        fw = fwd_sum(K, si, sj)
        if fw is None:
            continue
        p0 = c0 + q0
        gam_pct, th_pct = (fw["gamma"] + fw["delta"]) / p0 * 100, -fw["theta"] / p0 * 100
        rows_b.append({"GAMMA": gam_pct, "THETA": th_pct, "MOVE": gam_pct - th_pct, "VEGA": fw["vega"] / p0 * 100, "fc_var": fc, "day": str(d), "dte0": dte0, "fc_ratio": fc / implied_var_30, "real_ratio": sm["Y"] / implied_var_30, "seas_ratio": sm["seas"] / implied_var_30,
                       "PNL": (c0 + q0 - (c1 + q1)) / (c0 + q0) * 100})
    # ---------- PART C: management rules
    n = len(snaps)
    for entry_min in (5, 75, 165):  # 09:20, 10:30, 12:00
        e = next((i for i in range(n) if tm(snaps[i]) >= entry_min), None)
        if e is None or not snaps[e].spot:
            continue
        end = max((i for i in range(n) if tm(snaps[i]) <= 355), default=None)  # 15:10
        if end is None or end <= e + 20:
            continue
        strikes0 = sorted({k for k, _ in snaps[e].prices})
        K0 = min(strikes0, key=lambda k: abs(k - snaps[e].spot))

        def px(si, K):
            c, q = snaps[si].prices.get((K, CALL)), snaps[si].prices.get((K, PUT))
            return None if c is None or q is None or c + q <= 0 else c + q

        if px(e, K0) is None:
            continue

        def sim(restrike, stop):
            K, pe = K0, px(e, K0)
            booked, nre, out, last = 0.0, 0, False, pe
            worst = 0.0
            for si in range(e + 1, end + 1):
                p = px(si, K)
                if p is None:
                    continue
                last = p
                worst = max(worst, p - pe)
                if stop is not None and p >= pe * (1 + stop):
                    booked += pe - p
                    out = True
                    break
                spot = snaps[si].spot
                if restrike is not None and spot and abs(spot - K) >= restrike:
                    strikes = sorted({k for k, _ in snaps[si].prices})
                    Kn = min(strikes, key=lambda k: abs(k - spot))
                    pn = px(si, Kn)
                    if Kn != K and pn is not None:
                        booked += pe - p
                        K, pe, nre, last = Kn, pn, nre + 1, pn
                        worst = 0.0
            pnl = booked + (0.0 if out else pe - last)
            return pnl, nre, 4 * (1 + nre)

        base_p = px(e, K0)
        for name, (rs, st) in {"hold (no management)": (None, None), "re-strike 100": (100, None), "re-strike 150": (150, None), "re-strike 200": (200, None),
                               "stop +30%": (None, 0.30), "stop +50%": (None, 0.50), "re-strike 150 + stop +50%": (150, 0.50)}.items():
            pnl, nre, fills = sim(rs, st)
            c_rows.append({"day": str(d), "dte0": dte0, "entry": entry_min, "rule": name, "pnl": pnl, "nre": nre, "fills": fills, "p0": base_p})
    print(d, "done", flush=True)

# ---------------- PART B report
print("\nPART B: does the forecast realised/implied variance ratio at t tell a seller when selling pays? (30-minute hold of the ATM straddle, fixed strike; percent of the premium, before costs)")
for label, rs in (("all sessions", rows_b), ("non-expiry sessions", [r for r in rows_b if not r["dte0"]])):
    if len(rs) < 40:
        continue
    cuts = np.quantile([r["fc_ratio"] for r in rs], [1 / 3, 2 / 3])
    print(f"  {label}: n={len(rs)}  rank correlation of fc_ratio with the SELLER'S PNL {spearman([r['fc_ratio'] for r in rs], [r['PNL'] for r in rs]):+.3f};  with the realised ratio {spearman([r['fc_ratio'] for r in rs], [r['real_ratio'] for r in rs]):+.3f}")
    for name, f in (("forecast ratio low", lambda r: r["fc_ratio"] <= cuts[0]), ("middle", lambda r: cuts[0] < r["fc_ratio"] <= cuts[1]), ("high", lambda r: r["fc_ratio"] > cuts[1])):
        g = [r for r in rs if f(r)]
        print(f"    {name:20s} n={len(g):4d}  mean PNL {mean([r['PNL'] for r in g]):+6.2f}%  win {100 * mean([1.0 if r['PNL'] > 0 else 0.0 for r in g]):3.0f}%  realised/implied {mean([r['real_ratio'] for r in g]):5.2f}  forecast {mean([r['fc_ratio'] for r in g]):5.2f}")

print("PART B2: the forecast against the GAMMA cost and against MOVE (gamma minus theta), the quantities a seller is exposed to")
for label, rs in (("all sessions", rows_b), ("non-expiry sessions", [r for r in rows_b if not r["dte0"]])):
    if len(rs) < 40:
        continue
    print(f"  {label}: n={len(rs)}  rank correlation of the forecast variance with GAMMA {spearman([r['fc_var'] for r in rs], [r['GAMMA'] for r in rs]):+.3f}, with MOVE {spearman([r['fc_var'] for r in rs], [r['MOVE'] for r in rs]):+.3f}, with VEGA {spearman([r['fc_var'] for r in rs], [r['VEGA'] for r in rs]):+.3f}")
    cuts = np.quantile([r["fc_var"] for r in rs], [1 / 3, 2 / 3])
    for name, f in (("forecast variance low", lambda r: r["fc_var"] <= cuts[0]), ("middle", lambda r: cuts[0] < r["fc_var"] <= cuts[1]), ("high", lambda r: r["fc_var"] > cuts[1])):
        g = [r for r in rs if f(r)]
        print(f"    {name:22s} n={len(g):4d}  THETA {mean([r['THETA'] for r in g]):5.2f}%  GAMMA {mean([r['GAMMA'] for r in g]):5.2f}%  MOVE {mean([r['MOVE'] for r in g]):+6.2f}%  VEGA {mean([r['VEGA'] for r in g]):+6.2f}%  PNL {mean([r['PNL'] for r in g]):+6.2f}%")

# ---------------- PART C report
print("\nPART C: management rules for a sold ATM straddle, entered at the time shown and closed at 15:10 (points of straddle premium; one lot = 65 units). Costs: 0.75 point per fill, 4 fills at entry and exit and 4 more per re-strike.")
RULES = ["hold (no management)", "re-strike 100", "re-strike 150", "re-strike 200", "stop +30%", "stop +50%", "re-strike 150 + stop +50%"]
for label, flt in (("NON-EXPIRY sessions", lambda r: not r["dte0"]), ("EXPIRY-DAY sessions", lambda r: r["dte0"])):
    print(f"\n  {label}")
    for entry, en in ((5, "09:20"), (75, "10:30"), (165, "12:00")):
        sess = sorted({r["day"] for r in c_rows if flt(r) and r["entry"] == entry})
        print(f"   entry {en} ({len(sess)} sessions)")
        print(f"     {'rule':28s} {'mean pts':>8s} {'after cost':>10s} {'win %':>6s} {'worst':>8s} {'best':>8s} {'re-strikes':>10s}")
        for rule in RULES:
            g = [r for r in c_rows if flt(r) and r["entry"] == entry and r["rule"] == rule]
            if not g:
                continue
            pn = [r["pnl"] for r in g]
            net = [r["pnl"] - 0.75 * r["fills"] for r in g]
            print(f"     {rule:28s} {mean(pn):+8.1f} {mean(net):+10.1f} {100 * mean([1.0 if x > 0 else 0.0 for x in net]):6.0f} {min(net):+8.1f} {max(net):+8.1f} {mean([r['nre'] for r in g]):10.1f}")
