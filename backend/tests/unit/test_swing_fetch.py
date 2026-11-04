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
