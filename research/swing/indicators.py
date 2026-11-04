"""Vectorised indicators and the 4-pillar 0-100 scorer (spec chapters 5-6).

Every value at row t uses only bars <= t. The pivot is the highest high of the 20 bars
BEFORE t, so a close above it (distance 0..+0.8 %) is a real breakout bar.
Wherever the spec is silent the choice is recorded in docs/swing-backtest.md.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def _wilder(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def mansfield_rs(close: pd.Series, bench: pd.Series, n: int = 50) -> pd.Series:
    rs = close / bench
    return (rs / rs.rolling(n).mean() - 1.0) * 10.0


def _true_range(df: pd.DataFrame) -> pd.Series:
    pc = df["Close"].shift(1)
    return pd.concat(
        [df["High"] - df["Low"], (df["High"] - pc).abs(), (df["Low"] - pc).abs()], axis=1
    ).max(axis=1)


def minmax_pct(x: pd.Series, window: int, min_periods: int = 20) -> pd.Series:
    """(x - rolling min) / (rolling max - rolling min), 0..1. Not a statistical percentile."""
    lo, hi = x.rolling(window, min_periods=min_periods).min(), x.rolling(window, min_periods=min_periods).max()
    return (x - lo) / (hi - lo + 1e-6)


def compute(
    df: pd.DataFrame, bench_close: pd.Series, kc_atr: str = "wilder20", natr_window: int = 126,
    dur_rule: str = "pdf", natr_method: str = "minmax",
) -> pd.DataFrame:
    """Return df with indicator columns, `pivot`, `dist`, `score`, `archetype`."""
    o, h, low, c, v = (df[k] for k in ("Open", "High", "Low", "Close", "Volume"))
    out = df.copy()
    tr = _true_range(df)
    out["atr14"] = _wilder(tr, 14)
    atr20 = {
        "sma20": tr.rolling(20).mean(),
        "wilder20": tr.ewm(alpha=1 / 20, adjust=False, min_periods=20).mean(),
        "wilder14": out["atr14"],
        "ema20": tr.ewm(span=20, adjust=False, min_periods=20).mean(),
    }[kc_atr]
    out["ema10"] = c.ewm(span=10, adjust=False, min_periods=10).mean()
    ema20 = c.ewm(span=20, adjust=False, min_periods=20).mean()
    sma50, sma200 = c.rolling(50).mean(), c.rolling(200).mean()
    out["vol_sma20"] = v.rolling(20).mean()
    h252 = h.rolling(252, min_periods=200).max()

    gate = (
        (c >= 0.98 * ema20) & (c >= 0.95 * sma50) & (c >= 0.98 * sma200)
        & (sma50 >= 0.98 * sma200) & (h >= 0.80 * h252)
    )

    # Pillar 1: volatility contraction and squeeze (30)
    mid, sd = c.rolling(20).mean(), c.rolling(20).std(ddof=0)
    kc_mid = ema20
    squeeze = ((mid + 2 * sd) < (kc_mid + 1.5 * atr20)) & ((mid - 2 * sd) > (kc_mid - 1.5 * atr20))
    grp = (~squeeze).cumsum()
    dur = squeeze.astype(int).groupby(grp).cumsum()
    natr = out["atr14"] / c * 100
    if natr_method == "minmax":  # the original engine's "percentile": min-max scaling, 0..1
        natr_pct = minmax_pct(natr, natr_window)
    else:
        natr_pct = natr.rolling(natr_window).rank(pct=True)
    rng = h - low
    nr7 = rng <= rng.rolling(7).min()
    nr4 = rng <= rng.rolling(4).min()
    inside = (h < h.shift(1)) & (low > low.shift(1))
    p1 = (
        np.where(squeeze, 12, 0)
        + (np.where(dur >= 6, 6, 0) if dur_rule == "ge6"
           else np.where((dur >= 3) & (dur <= 18), 6, np.where(dur > 18, 3, 0)))
        + np.where(natr_pct <= 0.25, 6, np.where(natr_pct <= 0.40, 3, 0))
        + np.where(nr7, 4, np.where(nr4, 2, 0))
        + np.where(inside, 2, 0)
    )

    # Pillar 2: institutional accumulation (30)
    mfm = ((c - low) - (h - c)) / rng.replace(0, np.nan)
    cmf = (mfm.fillna(0) * v).rolling(20).sum() / v.rolling(20).sum()
    up, down = c > c.shift(1), c < c.shift(1)
    udv = (v.where(up, 0)).rolling(50).sum() / (v.where(down, 0)).rolling(50).sum().replace(0, np.nan)
    vdu = v.rolling(3).mean() / v.rolling(50).mean()
    max_down10 = v.where(down).rolling(10, min_periods=1).max().shift(1)
    pocket = up & (v > max_down10)
    pp5 = pocket.astype(float).rolling(5).max() > 0
    p2 = (
        np.where(cmf >= 0.15, 10, np.where(cmf >= 0.05, 6, np.where(cmf >= 0.0, 2, 0)))
        + np.where(udv >= 1.30, 8, np.where(udv >= 1.10, 5, 0))
        + np.where(vdu <= 0.60, 6, np.where(vdu <= 0.80, 3, 0))
        + np.where(pp5, 6, 0)
    )

    # Pillar 3: Mansfield relative strength vs NIFTY 50 (20)
    mrs = mansfield_rs(c, bench_close.reindex(c.index))
    out["mrs"] = mrs
    p3 = (
        np.where(mrs > 0, 7, 0)
        + np.where(mrs > mrs.shift(5), 5, 0)
        + np.where((c > ema20) & (ema20 > sma50), 5, 0)
        + np.where(sma50 > sma200, 3, 0)
    )

    # Pillar 4: pivot proximity and base tension (20)
    pivot = h.shift(1).rolling(20).max()
    dist = (c - pivot) / pivot * 100
    r5 = h.rolling(5).max() - low.rolling(5).min()
    r20 = h.rolling(20).max() - low.rolling(20).min()
    tight_ratio = r5 / r20.replace(0, np.nan)
    p4 = (
        np.where((dist >= -2.5) & (dist < 0), 12, 0)
        + np.where((dist >= -4.0) & (dist < -2.5), 7, 0)
        + np.where((dist >= 0.0) & (dist <= 0.8), 8, 0)
        + np.where(tight_ratio <= 0.45, 8, np.where(tight_ratio <= 0.65, 4, 0))
    )

    score = pd.Series(p1 + p2 + p3 + p4, index=c.index, dtype=float)
    valid = gate & pivot.notna() & out["atr14"].notna() & mrs.notna() & natr_pct.notna()
    out["score"] = score.where(valid, 0.0)
    out["pivot"], out["dist"] = pivot, dist
    out["pillars"] = list(zip(p1, p2, p3, p4, strict=True))

    # Archetype (chapter 6): BLUE_SKY > VCP > CLASSIC_PIVOT
    ath_prior = h.shift(1).cummax()
    rg = rng
    coil = rg.rolling(10).mean() / rg.shift(10).rolling(10).mean()
    dry = v.rolling(10).sum() / v.shift(10).rolling(10).sum()
    out["archetype"] = np.where(
        pivot >= ath_prior * 0.985, "BLUE_SKY",
        np.where((coil <= 0.85) & (dry <= 0.85), "VCP", "CLASSIC_PIVOT"),
    )
    return out


def stage2_gate(close: pd.Series, tol: float = 0.98, long: bool = True) -> pd.Series:
    """Index above 0.98*SMA50 (and 0.98*SMA200 when `long`)."""
    ok = close >= tol * close.rolling(50).mean()
    if long:
        ok &= close >= tol * close.rolling(200).mean()
    ok &= close.rolling(50).mean().notna() & (close.rolling(200).mean().notna() if long else True)
    return ok


def map_stock_to_index(sector_str: str | None, industry_str: str | None) -> str:
    """Spec chapter 4, verbatim."""
    s = (sector_str or "").lower()
    ind = (industry_str or "").lower()
    if "auto" in ind or "auto" in s:
        return "CNXAUTO"
    if "bank" in ind or "bank" in s:
        return "CNXPSUBANK" if ("psu" in ind or "public" in ind) else "NSEBANK"
    if "energy" in s or "oil" in ind or "gas" in ind:
        return "CNXENERGY"
    if "fmcg" in s or "defensive" in s or "food" in ind:
        return "CNXFMCG"
    if "infra" in ind or "construction" in ind or "capital goods" in ind:
        return "CNXINFRA"
    if "tech" in s or "software" in ind or "it " in ind:
        return "CNXIT"
    if "metal" in ind or "steel" in ind or "mining" in ind:
        return "CNXMETAL"
    if "pharma" in ind or "health" in s or "biotech" in ind:
        return "CNXPHARMA"
    if "realt" in ind or "real estate" in s:
        return "CNXREALTY"
    if "utilit" in s or "power" in ind:
        return "CNXPSE"
    return "CNXINFRA"
