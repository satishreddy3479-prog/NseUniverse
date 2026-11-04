"""Build data/swing/report.json for the website's Swing page. Usage: python -m swing.export_report

Everything in the Backtest, Trades, Robustness and Rules tabs comes from this file: the default
backtest (before and after costs), robustness runs and the caveats. Nothing is typed in by hand
except the comparison with the original ledger (labelled as such). The live scan and the paper book
are produced separately, on the server, by backend/app/swing.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pandas as pd

from swing import backtest, chartink, data, indicators
from swing.run_backtest import ROOT, START, build

SCHEMA = 1
COST = 0.0015  # per side, assumption

CAVEATS = [
    "Universe is today's Chartink list. Fundamentals (ROE, ROCE, debt, profit) are today's values applied to 2023-2026, and stocks that failed or were delisted are missing, so the backtest is flattered by survivorship.",
    "The 'before costs' figures use no brokerage, taxes or slippage. 'After costs' assumes 0.15% per side, which is an assumption, not a measurement. Small-cap fills at the trigger price may be worse.",
    "Profit is concentrated: the ten best trades make about all of the net profit; without them the system roughly breaks even.",
    "Results move by 10-15 points with the start date or the order of equal-score candidates, and fall away sharply when the minimum score is 63 or 64.",
    "The volume rule uses the whole next day's volume, which cannot be known when the trigger fires intraday. Daily bars also cannot show whether the trigger or the stop came first.",
    "The rules were rebuilt from the author's specification and ledger. Aggregate statistics match; individual trades only partly do.",
    "This is a research backtest, not live-verified, not advice, and no orders are placed by this software.",
]

ORIGINAL_LEDGER = {
    "source": "User-supplied audit ledger (402 trades), not independently verified",
    "trades": 402, "return_pct": 80.01, "max_drawdown_pct": 13.91, "profit_factor": 1.33,
    "win_rate_pct": 33.58, "costs": "none applied", "prices": "dividend-adjusted",
    "note": "The specification PDF headline states profit factor 1.77 and average R +0.43; the ledger itself gives 1.33 and +0.13.",
}


def clean(o):
    """JSON-safe: numpy scalars to Python, NaN/inf to null."""
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, list | tuple):
        return [clean(v) for v in o]
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.floating | float):
        f = float(o)
        return None if math.isnan(f) or math.isinf(f) else f
    if isinstance(o, pd.Timestamp | datetime):
        return o.isoformat()
    return o


def drawdown_pct(equity: pd.Series) -> pd.Series:
    """Percent below the running peak (0 or negative)."""
    return (equity / equity.cummax() - 1.0) * 100.0


def _run(frames, elig, sec, cal, nifty, **kw):
    out = {}
    for label, cost in (("gross", 0.0), ("net", COST)):
        p = backtest.Params(cost_per_side=cost, **kw)
        tr, eq = backtest.run(frames, elig, sec, cal, p)
        out[label] = (tr, eq, backtest.metrics(tr, eq, p.capital, nifty), p)
    return out


def _row(group: str, label: str, res: dict) -> dict:
    g, n = res["gross"][2], res["net"][2]
    return {"group": group, "label": label, "trades": g["trades"], "gross_return_pct": g["return_pct"],
            "net_return_pct": n["return_pct"], "gross_max_dd_pct": g["max_drawdown_pct"],
            "gross_profit_factor": g["profit_factor"], "net_profit_factor": n["profit_factor"]}


def _robustness(frames, elig, sec, cal, nifty) -> list[dict]:
    rows = []
    for ms in (63, 64, 65, 66, 67, 68, 70):
        rows.append(_row("Minimum score", f"score ≥ {ms}" + ("  (rule)" if ms == 65 else ""),
                         _run(frames, elig, sec, cal, nifty, min_score=float(ms))))
    ties = (("alpha", 0, "alphabetical (rule)"), ("dist", 0, "closest to pivot"),
            ("mrs", 0, "strongest relative strength"), ("random", 1, "random order, seed 1"),
            ("random", 2, "random order, seed 2"), ("random", 3, "random order, seed 3"))
    for tb, seed, lab in ties:
        rows.append(_row("Order of equal scores", lab,
                         _run(frames, elig, sec, cal, nifty, tie_break=tb, tie_seed=seed)))
    return rows


def _by(trades: pd.DataFrame, col: str, capital: float) -> list[dict]:
    g = trades.groupby(col).agg(trades=("pnl", "size"), win_rate_pct=("pnl", lambda x: (x > 0).mean() * 100),
                                pnl=("pnl", "sum"), avg_r=("r_mult", "mean")).reset_index()
    g["pnl_pct_of_capital"] = g["pnl"] / capital * 100
    return g.rename(columns={col: "key"}).round(2).to_dict("records")


def build_report(root: Path = ROOT) -> dict:
    frames, elig, sec, cal, nifty, uni, n_uni = build(root)
    res = _run(frames, elig, sec, cal, nifty)
    tg, eg, mg, p = res["gross"]
    _, en, mn, _ = res["net"]
    tf = backtest.trades_frame(tg)
    tf["return_pct"] = (tf["exit"] / tf["entry"] - 1) * 100
    tf["year"] = pd.to_datetime(tf["entry_date"]).dt.year
    for c in ("signal_date", "entry_date", "exit_date"):
        tf[c] = pd.to_datetime(tf[c]).dt.strftime("%Y-%m-%d")
    top10, total = float(tf["pnl"].nlargest(10).sum()), float(tf["pnl"].sum())
    last = cal[-1]
    nb = nifty.reindex(cal).ffill()
    bench = nb / nb.iloc[0] * p.capital
    # the first bar (last session of 2022) is the starting capital, so its year bucket is the base
    rets = {k: s.resample("YE").last().pct_change().dropna() * 100
            for k, s in (("gross", eg), ("net", en), ("nifty", bench))}
    year_returns = [{"year": int(d.year), "gross_pct": float(rets["gross"].iloc[i]),
                     "net_pct": float(rets["net"].iloc[i]), "nifty_pct": float(rets["nifty"].iloc[i])}
                    for i, d in enumerate(rets["gross"].index)]
    robust = _robustness(frames, elig, sec, cal, nifty)
    f2, e2, s2, c2, n2, *_ = build(root, start=pd.Timestamp("2023-05-31"))
    robust.append(_row("Start date", "start 2023-05-31 (the ledger's first entry)", _run(f2, e2, s2, c2, n2)))
    report = {
        "schema": SCHEMA,
        "meta": {
            "generated_at_utc": datetime.now(UTC).isoformat(), "data_through": last.strftime("%Y-%m-%d"),
            "period_start": cal[0].strftime("%Y-%m-%d"), "universe_fetched_at_utc": uni["fetched_at_utc"],
            "universe_size": n_uni, "stocks_with_data": len(frames), "scan_clause": uni["scan_clause"],
            "price_basis": "Yahoo daily bars, split-adjusted, dividends not folded in (tradable price levels)",
            "cost_per_side_pct": COST * 100, "params": asdict(p),
        },
        "kpis": {"gross": mg, "net": mn},
        "equity": {
            "dates": [d.strftime("%Y-%m-%d") for d in cal], "gross": eg.round(2).tolist(),
            "net": en.round(2).tolist(), "nifty": bench.round(2).tolist(),
            "gross_dd": drawdown_pct(eg).round(2).tolist(), "net_dd": drawdown_pct(en).round(2).tolist(),
        },
        "year_returns": year_returns,
        "concentration": {"top10_pnl": top10, "total_pnl": total, "pnl_without_top10": total - top10,
                          "top10_share_pct": top10 / total * 100 if total > 0 else None},
        "by_exit_reason": _by(tf, "reason", p.capital), "by_archetype": _by(tf, "archetype", p.capital),
        "by_sector": _by(tf, "sector", p.capital), "by_year": _by(tf, "year", p.capital),
        "trades": tf[["symbol", "sector", "archetype", "score", "signal_date", "entry_date", "entry", "pivot",
                      "initial_sl", "shares", "exit_date", "exit", "reason", "pnl", "return_pct", "r_mult",
                      "hold_days"]].round(2).to_dict("records"),
        "robustness": robust,
        "original_ledger": ORIGINAL_LEDGER,
        "caveats": CAVEATS,
    }
    return clean(report)


def write_report(root: Path = ROOT) -> Path:
    rep = build_report(root)
    out = root / "report.json"
    tmp = out.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(rep, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, out)
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB), data through {rep['meta']['data_through']}, "
          f"{len(rep['trades'])} trades")
    return out


def main() -> None:
    if not (ROOT / "universe.json").exists():
        raise SystemExit("data/swing/universe.json missing: run python -m swing.refresh first")
    chartink.load_universe(ROOT / "universe.json")  # fails loudly if the file is unreadable
    write_report(ROOT)


if __name__ == "__main__":
    main()
