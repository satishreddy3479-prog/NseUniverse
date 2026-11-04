"""Daily OHLCV download and parquet cache (Yahoo Finance, unadjusted for dividends).

Prices are Yahoo's raw OHLC (split-adjusted by Yahoo, dividends NOT folded in), i.e. the
prices a trader could actually have transacted at. Bars with missing OHLC are dropped,
never filled.
"""

from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf

START = "2021-06-01"  # warm-up so SMA200 / 252-bar high exist at 2023-01-01
NIFTY = "^NSEI"
SECTOR_INDICES = {
    "CNXAUTO": "^CNXAUTO",
    "NSEBANK": "^NSEBANK",
    "CNXPSUBANK": "^CNXPSUBANK",
    "CNXENERGY": "^CNXENERGY",
    "CNXFMCG": "^CNXFMCG",
    "CNXINFRA": "^CNXINFRA",
    "CNXIT": "^CNXIT",
    "CNXMETAL": "^CNXMETAL",
    "CNXPHARMA": "^CNXPHARMA",
    "CNXREALTY": "^CNXREALTY",
    "CNXPSE": "^CNXPSE",
}
COLS = ["Open", "High", "Low", "Close", "Volume"]


def _clean(df: pd.DataFrame) -> pd.DataFrame:
    df = df[COLS].copy()
    df.index = pd.to_datetime(df.index).tz_localize(None).normalize()
    df = df[~df.index.duplicated(keep="last")].sort_index()
    df = df.dropna(subset=["Open", "High", "Low", "Close"])
    return df[(df[["Open", "High", "Low", "Close"]] > 0).all(axis=1)]


def download(
    tickers: list[str], cache: Path, chunk: int = 60, refresh: bool = False, auto_adjust: bool = False
) -> dict:
    """Download missing tickers into cache/<ticker>.parquet; returns {ticker: status}."""
    cache.mkdir(parents=True, exist_ok=True)
    status: dict[str, str] = {}
    todo = []
    for t in tickers:
        if (cache / f"{_fn(t)}.parquet").exists() and not refresh:
            status[t] = "cached"
        else:
            todo.append(t)
    for i in range(0, len(todo), chunk):
        batch = todo[i : i + chunk]
        raw = yf.download(
            batch, start=START, auto_adjust=auto_adjust, group_by="ticker", progress=False,
            threads=True,
        )
        for t in batch:
            try:
                df = raw[t] if len(batch) > 1 else raw
                df = _clean(df)
            except Exception as exc:  # noqa: BLE001 - recorded per ticker
                status[t] = f"error:{type(exc).__name__}"
                continue
            if df.empty:
                status[t] = "empty"
                continue
            df.to_parquet(cache / f"{_fn(t)}.parquet")
            status[t] = "ok"
        time.sleep(1)
    return status


def _fn(ticker: str) -> str:
    return ticker.replace("^", "IDX_").replace("&", "_AND_")


IST = ZoneInfo("Asia/Kolkata")


def complete_bars(df: pd.DataFrame, now: datetime | None = None) -> pd.DataFrame:
    """Drop today's bar while the session may still be running (before 16:00 IST): Yahoo serves
    a partial bar then, and a partial bar must never be used as a final one."""
    now = (now or datetime.now(IST)).astimezone(IST)
    if len(df) and df.index[-1].date() == now.date() and (now.hour, now.minute) < (16, 0):
        return df.iloc[:-1]
    return df


def load(ticker: str, cache: Path, complete: bool = True) -> pd.DataFrame | None:
    p = cache / f"{_fn(ticker)}.parquet"
    if not p.exists():
        return None
    df = pd.read_parquet(p)
    return complete_bars(df) if complete else df


def fetch_sector_info(symbols: list[str], path: Path, workers: int = 16) -> dict:
    """Yahoo sector/industry per symbol (cached in a json file; missing stays missing)."""
    info: dict = json.loads(path.read_text()) if path.exists() else {}

    def one(s: str) -> tuple[str, dict]:
        try:
            d = yf.Ticker(f"{s}.NS").info
            return s, {"sector": d.get("sector"), "industry": d.get("industry")}
        except Exception as exc:  # noqa: BLE001 - recorded per symbol
            return s, {"sector": None, "industry": None, "error": type(exc).__name__}

    todo = [s for s in symbols if s not in info]
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for k, (s, rec) in enumerate(pool.map(one, todo), 1):
            info[s] = rec
            if k % 50 == 0:
                path.write_text(json.dumps(info))
    path.write_text(json.dumps(info))
    return info
