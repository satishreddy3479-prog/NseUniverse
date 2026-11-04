"""Build the pre-move dataset. Usage: python -m swing.build_movers"""

from __future__ import annotations

import pandas as pd

from swing import chartink, data, indicators, movers
from swing.run_backtest import ROOT


def main() -> None:
    cache = ROOT / "cache"
    uni = chartink.load_universe(ROOT / "universe.json")
    symbols = sorted({r["nsecode"] for r in uni["rows"]})
    nifty = data.load(data.NIFTY, cache)["Close"]
    nifty_ok = indicators.stage2_gate(nifty, long=False)
    parts = []
    for s in symbols:
        df = data.load(f"{s}.NS", cache)
        if df is None or len(df) < 260:
            continue
        x = movers.build_stock(df, nifty, nifty_ok, "2023-01-01")
        if x is not None and len(x):
            x.insert(0, "symbol", s)
            parts.append(x)
    ds = pd.concat(parts)
    num = ds.select_dtypes("float64").columns
    ds[num] = ds[num].astype("float32")
    ds.index.name = "date"
    ds.to_parquet(ROOT / "movers_dataset.parquet")
    print(f"rows {len(ds)}, symbols {ds.symbol.nunique()}, events {int(ds.y.sum())}, "
          f"base rate {ds.y.mean() * 100:.2f}%, features {ds.shape[1] - 5}")
    print(ds.groupby(ds.index.year).y.agg(["size", "mean"]).round(4))


if __name__ == "__main__":
    main()
