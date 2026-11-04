"""Multi-day holds and a '+5 % within 3 days' label. Usage: python -m swing.multiday_study

Two rankings, both fitted on 2023-24 only:
  A = next-day close +5..15 % (the earlier label)      B = next-3-day high reaches +5 %
Trades: top-5 per day, entry next bar (open, or buy-stop e % above prev close; skip gaps > 4 %),
exits compared on 2025; 2026 is reported next to it, never used to choose.
Daily bars: when stop and target/trailing touch in one bar the stop is assumed first.
"""

from __future__ import annotations

import itertools
import json

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score

from swing import data
from swing.analyze_movers import META, split
from swing.entry_study import picks
from swing.exits import EXITS, simulate
from swing.run_backtest import ROOT

COST_RT = 0.30  # % round trip (assumption)
def main() -> None:
    ds = pd.read_parquet(ROOT / "movers_dataset.parquet")
    cache = ROOT / "cache"
    px: dict[str, dict[str, np.ndarray]] = {}
    pos: dict[str, pd.Series] = {}
    nh3 = []
    for s, g in ds.groupby("symbol"):
        d = data.load(f"{s}.NS", cache)
        px[s] = {k: d[k].to_numpy(float) for k in ("Open", "High", "Low", "Close")}
        px[s] = {"O": px[s]["Open"], "H": px[s]["High"], "L": px[s]["Low"], "C": px[s]["Close"]}
        pos[s] = pd.Series(np.arange(len(d)), index=d.index)
        fwd = pd.concat([d["High"].shift(-k) for k in (1, 2, 3)], axis=1)
        v = (fwd.max(axis=1) / d["Close"] - 1) * 100
        v[fwd.isna().any(axis=1)] = np.nan
        nh3.append(v.reindex(g.index).rename("next3_high").to_frame().assign(symbol=s, date=g.index))
    nh = pd.concat(nh3).set_index(["date", "symbol"])["next3_high"]
    ds = ds.reset_index().set_index(["date", "symbol"]).join(nh).reset_index().set_index("date")
    ds = ds[ds.next3_high.notna()]
    ds["y3"] = (ds.next3_high >= 5.0).astype(float)
    feats = [c for c in ds.columns if c not in META + ["next3_high", "y3"]]
    tr, va, te = split(ds)
    print(f"label A base {ds.y.mean()*100:.2f}%  label B (+5% high within 3d) base {ds.y3.mean()*100:.2f}%")

    def fit(label: str):
        return HistGradientBoostingClassifier(
            max_depth=4, learning_rate=0.05, max_iter=300, min_samples_leaf=200,
            l2_regularization=1.0, early_stopping=True, validation_fraction=0.15,
            n_iter_no_change=20, random_state=0).fit(tr[feats], tr[label])

    models = {"A": fit("y"), "B": fit("y3")}
    summary = {}
    tops = {}
    for name, label in (("A", "y"), ("B", "y3")):
        for pn, part in (("val_2025", va), ("test_2026", te)):
            p = models[name].predict_proba(part[feats])[:, 1]
            t = picks(part, p, 5)
            vol = picks(part, part["natr"].to_numpy(), 5)
            tops[(name, pn)] = t
            summary[f"{name}_{pn}"] = {
                "auc": round(float(roc_auc_score(part[label], p)), 3),
                "label_base_pct": round(float(part[label].mean()) * 100, 2),
                "top5_hit_pct": round(float(t[label].mean()) * 100, 2),
                "volatility_top5_hit_pct": round(float(vol[label].mean()) * 100, 2),
            }
    print(json.dumps(summary, indent=1))

    rows = []
    for rk, (en, ex) in itertools.product(("A", "B"), itertools.product((0.0, 1.0), EXITS)):
        r = {"ranking": rk, "entry_%": en, "exit": ex}
        for pn in ("val_2025", "test_2026"):
            t = tops[(rk, pn)]
            res = []
            for sym, dt in zip(t.symbol, t.date, strict=True):
                i = int(pos[sym].loc[dt])
                v = simulate(px[sym], i, en, EXITS[ex])
                if v is not None:
                    res.append(v)
            x = np.array(res)
            net = x - COST_RT
            r[f"{pn}_n"] = len(x)
            r[f"{pn}_gross%"] = round(float(x.mean()), 3)
            r[f"{pn}_net%"] = round(float(net.mean()), 3)
            r[f"{pn}_win%"] = round(float((net > 0).mean()) * 100, 1)
            r[f"{pn}_PF"] = round(float(net[net > 0].sum() / -net[net <= 0].sum()), 2)
        rows.append(r)
    out = pd.DataFrame(rows)
    pd.set_option("display.width", 250)
    print(out.to_string(index=False))
    out.to_csv(ROOT / "results" / "multiday_study.csv", index=False)
    (ROOT / "results" / "multiday_labels.json").write_text(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
