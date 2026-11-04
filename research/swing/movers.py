"""Pre-move dataset: what did a stock look like over t-10..t-1 before a +5..15 % day?

Row at date t holds features computed from bars <= t only (t is "T-1" of the event).
Label: the NEXT bar (t+1) closes +5..+15 % vs the close at t (the user's movers screen).
Also stored: the next bar's open gap, so catchable vs uncatchable moves can be separated.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

LABEL_LO, LABEL_HI = 5.0, 15.0
WIN = 10


def daily_features(df: pd.DataFrame, bench: pd.Series) -> pd.DataFrame:
    o, h, low, c, v = (df[k] for k in ("Open", "High", "Low", "Close", "Volume"))
    pc = c.shift(1)
    tr = pd.concat([h - low, (h - pc).abs(), (low - pc).abs()], axis=1).max(axis=1)
    atr14 = tr.ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    ema20 = c.ewm(span=20, adjust=False, min_periods=20).mean()
    sma50, sma200 = c.rolling(50).mean(), c.rolling(200).mean()
    rng = h - low
    up, down = c > pc, c < pc
    mfm = ((c - low) - (h - c)) / rng.replace(0, np.nan)
    vol50 = v.rolling(50).mean()
    sd20 = c.rolling(20).std(ddof=0)
    f = pd.DataFrame(index=df.index)
    f["ema20_dist"] = (c / ema20 - 1) * 100
    f["sma50_dist"] = (c / sma50 - 1) * 100
    f["sma50_over_200"] = (sma50 / sma200 - 1) * 100
    f["cmf20"] = (mfm.fillna(0) * v).rolling(20).sum() / v.rolling(20).sum()
    f["cmf_day"] = mfm.fillna(0)
    f["vol_ratio"] = v / vol50
    f["range_pct"] = rng / c * 100
    f["range_atr"] = rng / atr14
    f["close_loc"] = ((c - low) / rng.replace(0, np.nan)).fillna(0.5)
    f["ret1"] = (c / pc - 1) * 100
    f["bb_width"] = 4 * sd20 / c.rolling(20).mean() * 100
    f["natr"] = atr14 / c * 100
    f["dist_h20"] = (c / h.rolling(20).max() - 1) * 100
    f["dist_h252"] = (c / h.rolling(252, min_periods=200).max() - 1) * 100
    f["udv50"] = v.where(up, 0).rolling(50).sum() / v.where(down, 0).rolling(50).sum().replace(0, np.nan)
    f["vdu3"] = v.rolling(3).mean() / vol50
    f["accum_day"] = np.where(up & (v > vol50), 1.0, np.where(down & (v > vol50), -1.0, 0.0))
    f["pocket"] = (up & (v > v.where(down).rolling(10, min_periods=1).max().shift(1))).astype(float)
    f["nr7"] = (rng <= rng.rolling(7).min()).astype(float)
    f["inside"] = ((h < h.shift(1)) & (low > low.shift(1))).astype(float)
    rs = c / bench.reindex(c.index)
    f["mrs"] = (rs / rs.rolling(50).mean() - 1) * 10
    f["rs_20d"] = ((c / c.shift(20) - 1) - (bench.reindex(c.index) / bench.reindex(c.index).shift(20) - 1)) * 100
    f["turnover_cr"] = (c * v).rolling(20).mean() / 1e7
    return f


def window_features(d: pd.DataFrame) -> pd.DataFrame:
    """Summaries over the 10 bars t-9..t (the window ending the day before the move)."""
    out = pd.DataFrame(index=d.index)
    last = ["ema20_dist", "sma50_dist", "sma50_over_200", "cmf20", "vol_ratio", "range_pct",
            "range_atr", "close_loc", "bb_width", "natr", "dist_h20", "dist_h252", "udv50",
            "vdu3", "mrs", "rs_20d", "turnover_cr", "ret1"]
    for k in last:
        out[k] = d[k]
    for k in ("cmf_day", "vol_ratio", "range_pct", "ema20_dist", "close_loc", "ret1"):
        r = d[k].rolling(WIN)
        out[f"{k}_mean10"] = r.mean()
    out["ema20_dist_min10"] = d["ema20_dist"].rolling(WIN).min()
    out["ema20_dist_max10"] = d["ema20_dist"].rolling(WIN).max()
    out["vol_ratio_max10"] = d["vol_ratio"].rolling(WIN).max()
    out["vol_ratio_min10"] = d["vol_ratio"].rolling(WIN).min()
    out["dry_days10"] = (d["vol_ratio"] < 0.7).astype(float).rolling(WIN).sum()
    out["surge_days10"] = (d["vol_ratio"] > 1.5).astype(float).rolling(WIN).sum()
    out["accum_net10"] = d["accum_day"].rolling(WIN).sum()
    out["pocket10"] = d["pocket"].rolling(WIN).sum()
    out["nr7_10"] = d["nr7"].rolling(WIN).sum()
    out["inside_10"] = d["inside"].rolling(WIN).sum()
    out["up_days10"] = (d["ret1"] > 0).astype(float).rolling(WIN).sum()
    # VCP-style contraction: second-half range and volume vs first-half of the window
    a, b = d["range_pct"].rolling(5).mean(), d["range_pct"].shift(5).rolling(5).mean()
    out["coil_range"] = a / b
    va, vb = d["vol_ratio"].rolling(5).mean(), d["vol_ratio"].shift(5).rolling(5).mean()
    out["coil_vol"] = va / vb
    out["cmf_change"] = d["cmf20"] - d["cmf20"].shift(5)
    out["ema20_dist_change"] = d["ema20_dist"] - d["ema20_dist"].shift(5)
    out["bb_width_pct126"] = d["bb_width"].rolling(126).rank(pct=True)
    out["natr_pct126"] = d["natr"].rolling(126).rank(pct=True)
    out["ret10"] = d["ret1"].rolling(WIN).sum()
    return out


def build_stock(df: pd.DataFrame, bench: pd.Series, nifty_ok: pd.Series, start: str) -> pd.DataFrame | None:
    d = daily_features(df, bench)
    x = window_features(d)
    x["nifty_ok"] = nifty_ok.reindex(x.index).astype(float)
    c, o = df["Close"], df["Open"]
    nxt_ret = (c.shift(-1) / c - 1) * 100
    x["next_ret"] = nxt_ret
    x["next_gap"] = (o.shift(-1) / c - 1) * 100
    x["next_high"] = (df["High"].shift(-1) / c - 1) * 100
    x["y"] = ((nxt_ret >= LABEL_LO) & (nxt_ret <= LABEL_HI)).astype(float).where(nxt_ret.notna())
    x = x.replace([np.inf, -np.inf], np.nan)
    x = x[x.index >= pd.Timestamp(start)]
    x = x[x["y"].notna()]
    x = x[x["turnover_cr"] >= 1.0]  # tradable: 20-day average turnover >= Rs 1 Cr
    feats = x.drop(columns=["next_ret", "next_gap", "next_high", "y"]).notna().all(axis=1)
    return x[feats]
