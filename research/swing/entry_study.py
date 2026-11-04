"""Can the model's daily top-5 be traded profitably? One-day hold, daily bars only.

Entry: buy-stop at prev_close*(1+e) (fills at the open if the open is above it; skipped if the
open gaps more than MAX_GAP above prev close). Stop at fill*(1-s); if the day's low touches the
stop it is assumed hit FIRST (conservative), else exit at the close.
Settings are compared on 2025 only; 2026 is reported once alongside.  Usage: python -m swing.entry_study
"""

from __future__ import annotations

import itertools

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier

from swing.analyze_movers import META, split
from swing.run_backtest import ROOT

from swing.exits import MAX_GAP  # noqa: E402
COST_RT = 0.30  # % round trip, assumption (0.15 % per side)


def picks(df: pd.DataFrame, score: np.ndarray, k: int = 5) -> pd.DataFrame:
    d = df.assign(score=score).reset_index().sort_values(["date", "score"], ascending=[True, False])
    return d.groupby("date").head(k)


def trade(top: pd.DataFrame, e: float, s: float) -> pd.Series:
    """Per-trade % return for picks; needs next-day OHLC relative to prev close in the frame."""
    trig = e
    o, h, low, c = top.next_gap, top.next_high, top.next_low, top.next_ret  # all % vs prev close
    ok = (o <= MAX_GAP) & (h >= trig)
    fill = np.maximum(o, trig)
    stop = (1 + fill / 100) * (1 - s / 100) - 1
    stop_hit = low / 100 <= stop
    ret = np.where(stop_hit, -s, ((1 + c / 100) / (1 + fill / 100) - 1) * 100)
    return pd.Series(np.where(ok, ret - COST_RT, np.nan), index=top.index)


def main() -> None:
    ds = pd.read_parquet(ROOT / "movers_dataset.parquet")
    # next-day low relative to prev close, rebuilt from the cache (not stored in the dataset)
    from swing import data
    lows = []
    for s_, g in ds.groupby("symbol"):
        px = data.load(f"{s_}.NS", ROOT / "cache")
        nl = (px["Low"].shift(-1) / px["Close"] - 1) * 100
        lows.append(nl.reindex(g.index).rename("next_low").to_frame().assign(symbol=s_, date=g.index))
    nl = pd.concat(lows).set_index(["date", "symbol"])["next_low"]
    ds = ds.reset_index().set_index(["date", "symbol"]).join(nl).reset_index().set_index("date")
    feats = [c for c in ds.columns if c not in META + ["next_low"]]
    tr, va, te = split(ds)
    m = HistGradientBoostingClassifier(
        max_depth=4, learning_rate=0.05, max_iter=300, min_samples_leaf=200, l2_regularization=1.0,
        early_stopping=True, validation_fraction=0.15, n_iter_no_change=20, random_state=0)
    m.fit(tr[feats], tr.y)
    tops = {n: picks(p, m.predict_proba(p[feats])[:, 1]) for n, p in (("val_2025", va), ("test_2026", te))}
    rows = []
    for e, s in itertools.product((0.0, 1.0, 2.0, 3.0), (2.5, 4.0)):
        r = {"entry_trigger_%": e, "stop_%": s}
        for n, t in tops.items():
            x = trade(t, e, s).dropna()
            r[f"{n}_trades"] = len(x)
            r[f"{n}_win%"] = round((x > 0).mean() * 100, 1)
            r[f"{n}_avg%"] = round(x.mean(), 3)
            r[f"{n}_PF"] = round(x[x > 0].sum() / -x[x <= 0].sum(), 2)
        rows.append(r)
    out = pd.DataFrame(rows)
    print(out.to_string(index=False))
    out.to_csv(ROOT / "results" / "entry_study.csv", index=False)


if __name__ == "__main__":
    main()
