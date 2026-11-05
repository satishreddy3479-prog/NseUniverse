"""Parsing of the real Yahoo and Chartink responses captured in tests/fixtures/swing.

The captured responses were taken just after midnight IST: Yahoo's newest bar (4 Nov) still had no
close, which is real behaviour the parser must handle by dropping that bar, never by guessing.
"""

from __future__ import annotations

import copy
import json
from datetime import datetime
from pathlib import Path

import pytest

from app.swing.fetch import IST, FetchError, parse_chart, parse_universe

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "swing"


def load(name: str) -> dict:
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def result(raw: dict) -> dict:
    return raw["chart"]["result"][0]


def clean_rows(raw: dict) -> list[int]:
    q = result(raw)["indicators"]["quote"][0]
    return [k for k in range(len(result(raw)["timestamp"])) if all(q[f][k] is not None for f in q)]


def evening(raw: dict, hour: int = 18) -> datetime:
    return datetime.fromtimestamp(result(raw)["timestamp"][-1], IST).replace(hour=hour, minute=0)


def test_real_yahoo_chart_becomes_ist_dated_complete_bars() -> None:
    raw = load("yahoo_chart_TITAN.json")
    bars = parse_chart(raw, evening(raw))
    rows = clean_rows(raw)
    assert len(bars) == len(rows) < len(result(raw)["timestamp"])  # the unfinished newest bar is not guessed
    q = result(raw)["indicators"]["quote"][0]
    k = rows[0]
    assert bars[0] == (datetime.fromtimestamp(result(raw)["timestamp"][k], IST).date().isoformat(),
                       q["open"][k], q["high"][k], q["low"][k], q["close"][k], float(q["volume"][k]))
    assert [b[0] for b in bars] == sorted(b[0] for b in bars)
    assert all(b[3] <= b[2] and b[3] <= b[1] for b in bars)  # low <= open and high on real data


def test_todays_bar_is_dropped_until_the_session_is_over() -> None:
    raw = copy.deepcopy(load("yahoo_chart_NSEI.json"))
    q = result(raw)["indicators"]["quote"][0]
    last = len(q["close"]) - 1
    q["close"][last] = q["open"][last]  # a finished newest bar, so the clock is the only reason to drop it
    full = parse_chart(raw, evening(raw, 16))
    partial = parse_chart(raw, evening(raw, 12))
    assert len(partial) == len(full) - 1 and partial[-1][0] < full[-1][0]
    assert len(parse_chart(raw, evening(raw, 23))) == len(full)


def test_bars_with_a_missing_value_are_dropped_not_filled() -> None:
    raw = copy.deepcopy(load("yahoo_chart_TITAN.json"))
    before = len(parse_chart(raw, evening(raw)))
    q = result(raw)["indicators"]["quote"][0]
    q["close"][3] = None
    q["volume"][5] = None
    assert len(parse_chart(raw, evening(raw))) == before - 2


def test_empty_or_error_chart_is_an_error() -> None:
    with pytest.raises(FetchError):
        parse_chart({"chart": {"result": None, "error": {"code": "Not Found"}}})


def test_real_chartink_rows_are_parsed() -> None:
    sample = load("chartink_process_sample.json")
    rows = parse_universe({"data": sample["rows"]})
    assert [r["nsecode"] for r in rows][:2] == ["MRF", "BOSCHLTD"] and len(rows) == 6
    with pytest.raises(FetchError):
        parse_universe({"nodata": 1})


def test_nse_day_reads_the_exchange_file_and_skips_rows_without_prices(monkeypatch) -> None:
    """The columns and values are the real NSE bhavcopy layout (4 Nov 2026 lines for ANANDRATHI and ARIS)."""
    import app.market.sources as sources
    from app.swing.fetch import HttpFetcher

    head = ("SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, "
            "TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER")
    lines = [
        head,
        "ANANDRATHI, EQ, 04-Nov-2026, 2288.00, 2296.00, 2309.00, 2285.00, 2296.00, 2296.00, 2297.00, 296347, 6807.0, 9000, 150000, 50.6",
        "ARIS, EQ, 04-Nov-2026, 143.52, 145.20, 150.40, 141.21, 147.38, 147.38, 146.00, 1853837, 2706.0, 7000, 900000, 48.5",
        "NOOPEN, EQ, 04-Nov-2026, 10.00, -, 11.00, 9.00, 10.00, 10.00, 10.00, 100, 1.0, 5, 50, 50.0",
        "ABC, BE, 04-Nov-2026, 10.00, 10.00, 11.00, 9.00, 10.00, 10.00, 10.00, 100, 1.0, 5, 50, 50.0",
    ]
    text = chr(10).join(lines)

    class Res:
        error, status = None, 200

    monkeypatch.setattr(sources, "fetch_text", lambda url: (Res(), text))
    got = HttpFetcher().nse_day("2026-11-04")
    assert got["ANANDRATHI"] == ("2026-11-04", 2296.0, 2309.0, 2285.0, 2296.0, 296347.0)
    assert got["ARIS"][1:5] == (145.2, 150.4, 141.21, 147.38)
    assert "NOOPEN" not in got and "ABC" not in got  # no open price: missing stays missing; other series are not equities here
    monkeypatch.setattr(sources, "fetch_text", lambda url: (Res(), None))
    assert HttpFetcher().nse_day("2026-11-04") == {}  # not published yet: no second source, the pass retries
