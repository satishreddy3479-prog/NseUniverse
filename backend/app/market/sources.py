"""Parsers and fetchers for the public files the breadth analysis needs.

* NSE index constituent lists (archives.nseindia.com/content/indices/ind_nifty50list.csv, ind_nifty500list.csv):
  ``Company Name,Industry,Symbol,Series,ISIN Code``
* NSE security-wise full bhavcopy (archives.nseindia.com/products/content/sec_bhavdata_full_DDMMYYYY.csv), published
  after the close: previous close, close and traded quantity per symbol and series
* Kotak scrip master rows for the cash segment (token and trading symbol such as ``HDFCBANK-EQ``)

The fetch client is the same honest, rate-limited one used for the NSE participant files; a refusal is
reported, never worked around.
"""

from __future__ import annotations

import csv
import io
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from app.prediction.sources.nse import Fetched, fetch

LIST_URL = "https://archives.nseindia.com/content/indices/ind_{name}list.csv"
BHAV_URL = "https://archives.nseindia.com/products/content/sec_bhavdata_full_{d:%d%m%Y}.csv"
INDEXES = {"nifty50": (50, 50), "nifty500": (480, 520)}  # name -> (min, max) members accepted


class SourceError(Exception):
    """A downloaded file does not look like what it should; nothing is stored."""


@dataclass(frozen=True)
class Constituent:
    symbol: str
    name: str
    industry: str
    isin: str


@dataclass(frozen=True)
class BhavRow:
    session: date
    symbol: str
    prev_close: float | None
    close: float | None
    volume: int | None
    deliv_qty: int | None


def _clean(text: str) -> str:
    return text.lstrip("﻿")


def parse_index_list(text: str, index: str) -> list[Constituent]:
    """Rows of an NSE index list. Rejects a file whose size is not plausible for the index."""
    rd = csv.DictReader(io.StringIO(_clean(text)))
    cols = {(c or "").strip().lower(): c for c in (rd.fieldnames or [])}
    for need in ("symbol", "company name", "industry", "series"):
        if need not in cols:
            raise SourceError(f"constituent list has no '{need}' column")
    out: list[Constituent] = []
    seen: set[str] = set()
    for r in rd:
        sym = (r.get(cols["symbol"]) or "").strip()
        if not sym or (r.get(cols["series"]) or "").strip() != "EQ" or sym in seen:
            continue
        seen.add(sym)
        out.append(Constituent(sym, (r.get(cols["company name"]) or "").strip(), (r.get(cols["industry"]) or "").strip(), (r.get(cols.get("isin code", "")) or "").strip()))
    lo, hi = INDEXES[index]
    if not lo <= len(out) <= hi:
        raise SourceError(f"{index} list has {len(out)} stocks, expected {lo}-{hi}")
    return out


def _num(v: str | None) -> float | None:
    v = (v or "").strip()
    if not v or v == "-":
        return None
    try:
        return float(v.replace(",", ""))
    except ValueError:
        return None


def _int(v: str | None) -> int | None:
    n = _num(v)
    return None if n is None else int(n)


def parse_bhavcopy(text: str, only: set[str] | None = None) -> list[BhavRow]:
    """Equity (series EQ) rows of the full bhavcopy. ``only`` limits it to the symbols we track."""
    rd = csv.reader(io.StringIO(_clean(text)))
    header = [h.strip().upper() for h in next(rd, [])]
    idx = {h: i for i, h in enumerate(header)}
    for need in ("SYMBOL", "SERIES", "DATE1", "PREV_CLOSE", "CLOSE_PRICE", "TTL_TRD_QNTY"):
        if need not in idx:
            raise SourceError(f"bhavcopy has no {need} column")
    out: list[BhavRow] = []
    for row in rd:
        if len(row) < len(header):
            continue
        cells = [c.strip() for c in row]
        if cells[idx["SERIES"]] != "EQ":
            continue
        sym = cells[idx["SYMBOL"]]
        if only is not None and sym not in only:
            continue
        try:
            d = datetime.strptime(cells[idx["DATE1"]], "%d-%b-%Y").date()
        except ValueError:
            continue
        out.append(BhavRow(d, sym, _num(cells[idx["PREV_CLOSE"]]), _num(cells[idx["CLOSE_PRICE"]]), _int(cells[idx["TTL_TRD_QNTY"]]), _int(cells[idx["DELIV_QTY"]]) if "DELIV_QTY" in idx else None))
    if not out and only is None:
        raise SourceError("bhavcopy holds no equity rows")
    return out


@dataclass(frozen=True)
class TokenInfo:
    symbol: str  # NSE symbol, e.g. HDFCBANK or BAJAJ-AUTO
    token: str  # Kotak pSymbol
    trading_symbol: str  # e.g. HDFCBANK-EQ


def parse_scrip_master(rows: Iterable[Mapping[str, Any]]) -> dict[str, TokenInfo]:
    """Cash-segment equity rows -> symbol -> token. Column names are matched case-insensitively
    (pSymbol, pTrdSymbol); only ``-EQ`` trading symbols are kept."""
    out: dict[str, TokenInfo] = {}
    for r in rows:
        low = {str(k).strip().lower(): v for k, v in r.items()}
        trd = str(low.get("ptrdsymbol", "") or "").strip()
        tok = str(low.get("psymbol", "") or "").strip()
        seg = str(low.get("pexchseg", "nse_cm") or "nse_cm").strip().lower()
        if not trd.endswith("-EQ") or not tok or seg != "nse_cm":
            continue
        sym = trd[:-3]
        out.setdefault(sym, TokenInfo(sym, tok, trd))
    return out


def fetch_text(url: str) -> tuple[Fetched, str | None]:
    res = fetch(url, timeout=30.0)
    if res.status != 200 or res.body is None:
        return res, None
    try:
        return res, res.body.decode("utf-8-sig")
    except UnicodeDecodeError:
        return res, res.body.decode("latin-1")
