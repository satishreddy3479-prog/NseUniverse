import csv, sys, math, json
from collections import defaultdict, Counter
from datetime import date, timedelta
from statistics import mean, pstdev
# Milestone 3 data audit and baselines. Run from the project root:
#   backend\.venv\Scripts\python.exe research\m3_audit.py [path\to\market_history_export.csv]
# The CSV is an export of data/market_history.sqlite3 (symbol,session,open,high,low,close).
import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))
CSV = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "data", "exports", "market_history_export.csv")
from app.prediction.targets import Bar, make_labels, BarError
from app.prediction.calendar import TradingCalendar
from app.prediction.evaluation import (walk_forward_splits, brier, log_loss, wilson_interval, climatology_probability, mae, empirical_quantile)

rows = defaultdict(list)
with open(CSV) as f:
    for r in csv.DictReader(f):
        rows[r["symbol"]].append(Bar(date.fromisoformat(r["session"]), float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])))
out = {}
nifty = sorted(rows["NIFTY50"], key=lambda b: b.session)
out["nifty_bars"] = len(nifty); out["first"] = str(nifty[0].session); out["last"] = str(nifty[-1].session)
# --- calendar check for 2026 (the only verified year)
cal = TradingCalendar.load()
have = {b.session for b in nifty if b.session.year == 2026}
expected = set(cal.sessions_between(date(2026,1,1), nifty[-1].session))
out["2026_missing_vs_calendar"] = sorted(str(d) for d in expected - have)
out["2026_extra_vs_calendar"] = sorted(str(d) for d in have - expected)
# --- gap histogram
gaps = Counter((nifty[i+1].session - nifty[i].session).days for i in range(len(nifty)-1))
out["gap_days_histogram"] = dict(sorted(gaps.items()))
out["gaps_over_5_days"] = [(str(nifty[i].session), str(nifty[i+1].session)) for i in range(len(nifty)-1) if (nifty[i+1].session-nifty[i].session).days > 5]
# --- anomalies
rets = [(nifty[i+1].session, nifty[i+1].close/nifty[i].close-1) for i in range(len(nifty)-1)]
out["abs_daily_return_over_7pct"] = [(str(d), round(r*100,2)) for d, r in rets if abs(r) > 0.07]
out["flat_bars_o_eq_h_eq_l_eq_c"] = sum(1 for b in nifty if b.open==b.high==b.low==b.close)
out["unchanged_close_days"] = sum(1 for _, r in rets if r == 0)
out["weekend_sessions"] = sorted(str(b.session) for b in nifty if b.session.weekday() >= 5)
# --- labels
ls = make_labels(nifty)
out["labels"] = {"t1": len(ls.t1), "t5": len(ls.t5), "skipped": len(ls.skipped), "skipped_examples": [(str(d), r) for d, r in ls.skipped[:5]]}
t1 = [x.close_to_close for x in ls.t1]; t5 = [x.ret5 for x in ls.t5]
def desc(v): return {"n": len(v), "mean_pct": round(mean(v)*100,4), "sd_pct": round(pstdev(v)*100,3), "up_freq": round(sum(1 for x in v if x>0)/len(v),4), "p5_pct": round(empirical_quantile(v,0.05)*100,2), "p95_pct": round(empirical_quantile(v,0.95)*100,2)}
out["t1_close_to_close"] = desc(t1); out["t5_return"] = desc(t5)
out["t1_gap"] = desc([x.gap for x in ls.t1])
out["t1_events"] = {f"abs>={x}": round(sum(1 for l in ls.t1 if abs(l.close_to_close) >= x - 1e-12)/len(ls.t1),4) for x in (0.005, 0.01)}
out["t1_gap_events"] = {f"abs>={x}": round(sum(1 for l in ls.t1 if abs(l.gap) >= x - 1e-12)/len(ls.t1),4) for x in (0.003, 0.005)}
out["t5_events"] = {f"abs>={x}": round(sum(1 for l in ls.t5 if abs(l.ret5) >= x - 1e-12)/len(ls.t5),4) for x in (0.01, 0.02)}
out["t5_adverse_freq"] = round(sum(1 for l in ls.t5 if l.adverse)/len(ls.t5),4)
by_year = defaultdict(list)
for l in ls.t1: by_year[l.target_session.year].append(l.close_to_close)
out["t1_up_freq_by_year"] = {y: (len(v), round(sum(1 for x in v if x>0)/len(v),3)) for y, v in sorted(by_year.items())}
# --- baselines on real labels, purged walk-forward
def baselines(labels_up, rets, horizon, init, test, emb):
    p_clim, p_half, hits_up, hits_prev = [], [], [], []
    y_all, preds_clim, preds_half = [], [], []
    mae_zero, mae_mean, mae_prev = [], [], []
    ys = []
    for tr, te in walk_forward_splits(len(labels_up), initial_train=init, test_size=test, horizon=horizon, embargo=emb):
        p = climatology_probability([labels_up[i] for i in tr])
        mu = mean([rets[i] for i in tr])
        for i in te:
            ys.append(labels_up[i]); preds_clim.append(p); preds_half.append(0.5)
            mae_zero.append(abs(rets[i])); mae_mean.append(abs(rets[i]-mu))
            hits_up.append(1 if labels_up[i] == 1 else 0)
    n = len(ys)
    return {"test_samples": n, "folds_test_size": test,
            "brier_climatology": round(brier(preds_clim, ys),5), "brier_coin_flip_0.5": round(brier(preds_half, ys),5),
            "logloss_climatology": round(log_loss(preds_clim, ys),5), "logloss_coin_flip": round(log_loss(preds_half, ys),5),
            "always_up_hit_rate": round(sum(hits_up)/n,4), "always_up_wilson95": [round(x,4) for x in wilson_interval(sum(hits_up), n)],
            "mae_zero_return": round(mean(mae_zero)*100,4), "mae_train_mean_return": round(mean(mae_mean)*100,4)}
up1 = [1 if x.positive else 0 for x in ls.t1]; r1 = [x.close_to_close for x in ls.t1]
up5 = [1 if x.positive else 0 for x in ls.t5]; r5 = [x.ret5 for x in ls.t5]
out["baseline_t1_walkforward"] = baselines(up1, r1, 1, 1000, 250, 1)
out["baseline_t5_walkforward"] = baselines(up5, r5, 5, 1000, 250, 5)
# previous-session momentum baseline for T+1 (direction), same test windows
def momentum_t1():
    hit = n = 0
    for tr, te in walk_forward_splits(len(up1), initial_train=1000, test_size=250, horizon=1, embargo=1):
        for i in te:
            if i == 0: continue
            pred = up1[i-1]  # previous session's direction predicts today's
            hit += (pred == up1[i]); n += 1
    return {"hit_rate": round(hit/n,4), "wilson95": [round(x,4) for x in wilson_interval(hit, n)], "n": n}
out["baseline_t1_prev_session_direction"] = momentum_t1()
# data volume per symbol
out["bars_per_symbol"] = {k: len(v) for k, v in sorted(rows.items())}
print(json.dumps(out, indent=1))
