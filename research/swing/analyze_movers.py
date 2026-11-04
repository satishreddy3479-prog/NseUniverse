"""Which pre-move patterns predict +5..15 % days? Walk-forward: train 2023-24, val 2025, test 2026.

Usage: python -m swing.analyze_movers
"""

from __future__ import annotations

import json

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.inspection import permutation_importance
from sklearn.metrics import roc_auc_score
from sklearn.tree import DecisionTreeClassifier, export_text

from swing.run_backtest import ROOT

META = ["symbol", "next_ret", "next_gap", "next_high", "y"]


def split(ds: pd.DataFrame):
    yr = ds.index.year
    return ds[yr <= 2024], ds[yr == 2025], ds[yr == 2026]


def top_k_per_day(df: pd.DataFrame, score: np.ndarray, k: int = 5) -> dict:
    d = df.assign(score=score).reset_index().sort_values(["date", "score"], ascending=[True, False])
    top = d.groupby("date").head(k)
    day_avg = d.groupby("date").next_ret.mean()
    excess = (top.groupby("date").next_ret.mean() - day_avg.reindex(top.date.unique())).mean()
    return {
        "picks": len(top), "hit_rate_pct": round(float(top.y.mean()) * 100, 2),
        "lift_vs_base": round(float(top.y.mean() / df.y.mean()), 2),
        "hit_and_gap_lt3_pct": round(float(((top.y == 1) & (top.next_gap < 3)).mean()) * 100, 2),
        "avg_next_close_ret_pct": round(float(top.next_ret.mean()), 2),
        "avg_next_open_to_close_pct": round(float(((1 + top.next_ret / 100) / (1 + top.next_gap / 100) - 1).mean()) * 100, 2),
        "excess_vs_universe_day_pct": round(float(excess), 2),
    }


def main() -> None:
    (ROOT / "results").mkdir(exist_ok=True)
    ds = pd.read_parquet(ROOT / "movers_dataset.parquet")
    feats = [c for c in ds.columns if c not in META]
    tr, va, te = split(ds)
    print(f"train {len(tr)} ({tr.y.mean()*100:.2f}%) val {len(va)} ({va.y.mean()*100:.2f}%) test {len(te)} ({te.y.mean()*100:.2f}%)")

    # 1) one-feature AUC on each period: a real pattern keeps its sign and size out of sample
    rows = []
    for f in feats:
        a = [roc_auc_score(p.y, p[f]) for p in (tr, va, te)]
        q = pd.qcut(tr[f], 10, duplicates="drop")
        rate = tr.groupby(q, observed=True).y.mean()
        rows.append({"feature": f, "auc_train": a[0], "auc_val": a[1], "auc_test": a[2],
                     "decile_low_rate%": rate.iloc[0] * 100, "decile_high_rate%": rate.iloc[-1] * 100})
    uni = pd.DataFrame(rows)
    uni["strength"] = (uni.auc_train - 0.5).abs()
    uni["stable"] = (np.sign(uni.auc_train - 0.5) == np.sign(uni.auc_val - 0.5)) & (
        np.sign(uni.auc_train - 0.5) == np.sign(uni.auc_test - 0.5))
    uni = uni.sort_values("strength", ascending=False)
    print("\nSingle-feature AUC (0.5 = no information), strongest on train first")
    print(uni.drop(columns="strength").head(20).round(3).to_string(index=False))

    # 2) model: fitted on train only, early-stopped inside train; val and test untouched
    model = HistGradientBoostingClassifier(
        max_depth=4, learning_rate=0.05, max_iter=300, min_samples_leaf=200,
        l2_regularization=1.0, early_stopping=True, validation_fraction=0.15,
        n_iter_no_change=20, random_state=0)
    model.fit(tr[feats], tr.y)
    res = {}
    for name, part in (("train", tr), ("val_2025", va), ("test_2026", te)):
        p = model.predict_proba(part[feats])[:, 1]
        thr = np.quantile(p, 0.99)
        sel = p >= thr
        res[name] = {
            "auc": round(float(roc_auc_score(part.y, p)), 3),
            "top1pct_hit_rate_pct": round(float(part.y[sel].mean()) * 100, 2),
            "base_rate_pct": round(float(part.y.mean()) * 100, 2),
            "top5_per_day": top_k_per_day(part, p, 5),
        }
    print("\nGradient-boosting model")
    print(json.dumps(res, indent=1))

    # baselines: simply pick the most volatile stocks each day
    base = {}
    for name, part in (("val_2025", va), ("test_2026", te)):
        base[name] = {f: top_k_per_day(part, part[f].to_numpy(), 5) for f in ("natr", "range_pct_mean10")}
    print("\nBaseline: top-5/day by volatility alone")
    print(json.dumps(base, indent=1))

    # volatility-neutral test: AUC of each feature inside NATR quintiles (mean over quintiles)
    cand = ["cmf20", "cmf_day_mean10", "udv50", "vdu3", "dry_days10", "accum_net10", "pocket10",
            "coil_range", "coil_vol", "ema20_dist", "ema20_dist_max10", "dist_h20", "dist_h252",
            "mrs", "rs_20d", "nr7_10", "inside_10", "bb_width_pct126", "natr_pct126",
            "vol_ratio", "vol_ratio_max10", "surge_days10", "ret10", "up_days10", "close_loc"]
    vrows = []
    for f in cand:
        a = []
        for part in (tr, va, te):
            q = pd.qcut(part["natr"], 5, labels=False)
            a.append(np.mean([roc_auc_score(part.y[q == k], part[f][q == k]) for k in range(5)]))
        vrows.append({"feature": f, "auc_train": a[0], "auc_val": a[1], "auc_test": a[2],
                      "stable": bool(np.sign(a[0]-.5) == np.sign(a[1]-.5) == np.sign(a[2]-.5))})
    vn = pd.DataFrame(vrows)
    vn["strength"] = (vn.auc_train - 0.5).abs()
    vn = vn.sort_values("strength", ascending=False).drop(columns="strength")
    print("\nVolatility-neutral AUC (inside NATR quintiles; 0.5 = nothing beyond volatility)")
    print(vn.round(3).to_string(index=False))
    vn.to_csv(ROOT / "results" / "movers_vol_neutral.csv", index=False)

    pi = permutation_importance(model, va[feats], va.y, scoring="roc_auc", n_repeats=3,
                                random_state=0, n_jobs=-1)
    imp = pd.Series(pi.importances_mean, index=feats).sort_values(ascending=False).head(12)
    print("\nPermutation importance on 2025 (AUC drop)")
    print(imp.round(4).to_string())

    # 3) readable rules: shallow tree on train, scored out of sample
    tree = DecisionTreeClassifier(max_depth=3, min_samples_leaf=2000, random_state=0).fit(tr[feats], tr.y)
    print("\nShallow tree rules (train)")
    print(export_text(tree, feature_names=feats, show_weights=False))
    for name, part in (("val_2025", va), ("test_2026", te)):
        p = tree.predict_proba(part[feats])[:, 1]
        best = p >= np.sort(np.unique(p))[-1]
        print(name, "best leaf: n", int(best.sum()), "hit rate", round(part.y[best].mean() * 100, 2), "% vs base", round(part.y.mean() * 100, 2), "%")

    out = ROOT / "results"
    uni.to_csv(out / "movers_univariate.csv", index=False)
    (out / "movers_model.json").write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
