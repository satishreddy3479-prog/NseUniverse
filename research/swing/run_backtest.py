"""Run the swing backtest from 2023. Usage: python -m swing.run_backtest"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from swing import backtest, chartink, data, indicators

ROOT = Path(__file__).resolve().parents[2] / "data" / "swing"
OUT = ROOT / "results"
START = pd.Timestamp("2023-01-01")


def build(root: Path = ROOT, cache_name: str = "cache", start: pd.Timestamp = START,
          extra_symbols: tuple[str, ...] = (), **score_kw):
    cache = root / cache_name
    uni = chartink.load_universe(root / "universe.json")
    symbols = sorted({r["nsecode"] for r in uni["rows"]} | set(extra_symbols))
    info_path = root / "sector_info.json"
    info = json.loads(info_path.read_text()) if info_path.exists() else {}

    nifty = data.load(data.NIFTY, cache)["Close"]
    prior = nifty.index[nifty.index < start]
    calendar = nifty.index[nifty.index >= prior[-1]]

    nifty_ok = indicators.stage2_gate(nifty, long=False)
    sector_ok = {}
    for code, tkr in data.SECTOR_INDICES.items():
        sector_ok[code] = indicators.stage2_gate(data.load(tkr, cache)["Close"]) & nifty_ok

    frames, eligible, sector_of = {}, {}, {}
    for s in symbols:
        df = data.load(f"{s}.NS", cache)
        if df is None or len(df) < 2:
            continue
        sec = info.get(s, {})
        code = indicators.map_stock_to_index(sec.get("sector"), sec.get("industry"))
        frames[s] = indicators.compute(df, nifty, **score_kw)
        eligible[s] = sector_ok[code]
        sector_of[s] = code
    return frames, eligible, sector_of, calendar, nifty, uni, len(symbols)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    frames, eligible, sector_of, calendar, nifty, uni, n_uni = build()
    print(f"universe {n_uni}, with data {len(frames)}, bars {len(calendar)}")
    summary = {"universe_fetched_at": uni["fetched_at_utc"], "universe_size": n_uni,
               "stocks_with_data": len(frames), "runs": {}}
    for label, cost in (("gross_spec", 0.0), ("net_0.15pct_per_side", 0.0015)):
        p = backtest.Params(cost_per_side=cost)
        trades, equity = backtest.run(frames, eligible, sector_of, calendar, p)
        m = backtest.metrics(trades, equity, p.capital, nifty)
        tf = backtest.trades_frame(trades)
        tf.to_csv(OUT / f"trades_{label}.csv", index=False)
        equity.to_csv(OUT / f"equity_{label}.csv", header=["equity"])
        summary["runs"][label] = m
        print(label, json.dumps(m, indent=1))
        if label == "gross_spec" and len(tf):
            tf["year"] = pd.to_datetime(tf["entry_date"]).dt.year
            for col in ("archetype", "reason", "year", "sector"):
                g = tf.groupby(col).agg(trades=("pnl", "size"), pnl=("pnl", "sum"),
                                        win=("pnl", lambda x: (x > 0).mean() * 100),
                                        avg_r=("r_mult", "mean")).round(2)
                print(g.to_string())
                summary[f"by_{col}"] = json.loads(g.to_json(orient="index"))
    (OUT / "summary.json").write_text(json.dumps(summary, indent=1, default=str))


if __name__ == "__main__":
    main()
