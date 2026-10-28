from __future__ import annotations

import json
from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from app.prediction.flows_service import FlowsService
from app.prediction.flows_store import FlowsStore
from app.prediction.sources.nse import Fetched, NseParseError, parse_fii_dii, parse_participant

HEAD = (
    "Client Type,Future Index Long,Future Index Short,Future Stock Long,Future Stock Short,"
    "Option Index Call Long,Option Index Put Long,Option Index Call Short,Option Index Put Short,"
    "Option Stock Call Long,Option Stock Put Long,Option Stock Call Short,Option Stock Put Short,"
    "Total Long Contracts,Total Short Contracts"
)


def csv_for(day: str = "Oct 28, 2026", kind: str = "Open Interest", bad_total: bool = False) -> bytes:
    def row(n: str, v: int) -> str:
        return n + "," + ",".join(str(v * (i + 1)) for i in range(14))

    vals = {"Client": 1, "DII": 2, "FII": 3, "Pro": 4}
    tot = sum(vals.values()) + (500 if bad_total else 0)
    lines = [f"Participant wise {kind} (no. of contracts) in Equity Derivatives as on {day}", HEAD]
    lines += [row(n, v) for n, v in vals.items()] + [row("TOTAL", tot)]
    return ("\n".join(lines) + "\n").encode()


def test_parse_valid_file_and_checks() -> None:
    p = parse_participant(csv_for(), "fao_participant_oi", date(2026, 10, 28))
    assert p["FII"]["Future Index Long"] == 3 and set(p) == {"Client", "DII", "FII", "Pro", "TOTAL"}
    with pytest.raises(NseParseError, match="requested"):
        parse_participant(csv_for(), "fao_participant_oi", date(2026, 10, 27))
    with pytest.raises(NseParseError, match="add up"):
        parse_participant(csv_for(bad_total=True), "fao_participant_oi", date(2026, 10, 28))
    with pytest.raises(NseParseError, match="look like"):
        parse_participant(csv_for(kind="Trading Volumes"), "fao_participant_oi", date(2026, 10, 28))


def test_totals_off_by_a_contract_are_accepted_as_nse_publishes_them() -> None:
    body = csv_for().replace(b"TOTAL,10,", b"TOTAL,9,")  # first column total one short of the sum
    assert parse_participant(body, "fao_participant_oi", date(2026, 10, 28))["TOTAL"]["Future Index Long"] == 9


def test_parse_fii_dii_requires_consistent_rows() -> None:
    ok = json.dumps([{"category": "DII **", "date": "28-Oct-2026", "buyValue": "12,000.50", "sellValue": "10,000.50", "netValue": "2000.00"}]).encode()
    assert parse_fii_dii(ok)[0]["net"] == 2000.0
    bad = json.dumps([{"category": "FII/FPI *", "date": "28-Oct-2026", "buyValue": "100", "sellValue": "50", "netValue": "900"}]).encode()
    with pytest.raises(NseParseError):
        parse_fii_dii(bad)


class Fake:
    def __init__(self, available: set[str], status: int = 200) -> None:
        self.available, self.status, self.calls = available, status, []

    def __call__(self, url: str) -> Fetched:
        self.calls.append(url)
        if self.status != 200:
            return Fetched(self.status, None, f"HTTP {self.status}")
        d = url.rsplit("_", 1)[1][:8]
        if d not in self.available:
            return Fetched(404, None, "HTTP 404")
        day = date(int(d[4:]), int(d[2:4]), int(d[:2]))
        kind = "Open Interest" if "_oi_" in url else "Trading Volumes"
        return Fetched(200, csv_for(day.strftime("%b %d, %Y"), kind))


def _svc(tmp_path: Path, fetcher: Fake, sessions: list[date]) -> FlowsService:
    now = datetime(2026, 10, 28, 15, 0, tzinfo=UTC)
    return FlowsService(
        FlowsStore(tmp_path), lambda: sessions, fetcher=fetcher, pause_s=0, clock=lambda: now,
        cash_fetcher=lambda: Fetched(0, None, "offline"),
    )


def test_backfill_stores_files_resumes_and_stops_at_history_start(tmp_path: Path) -> None:
    sessions = [date(2026, 10, d) for d in (26, 27, 28)] + [date(2020, 1, d) for d in range(1, 60 if False else 3)]
    have = {"28102026", "27102026", "26102026"}
    f = Fake(have)
    s = _svc(tmp_path, f, sessions)
    r = s.run()
    assert r["stored"] == 6  # three sessions x two kinds
    cov = s.store.coverage()
    assert cov["fao_participant_oi"]["files"] == 3 and cov["fao_participant_oi"]["first"] == "2026-10-26"
    n_calls = len(f.calls)
    s.run()  # second run re-requests nothing already stored; old finished-404 days are not retried
    assert len(f.calls) - n_calls <= 2 * 2  # only the recent-404 retry window, never the stored ones
    assert s.cash_note and "unavailable" in s.cash_note


def test_blocked_by_nse_stops_without_retrying(tmp_path: Path) -> None:
    f = Fake(set(), status=403)
    s = _svc(tmp_path, f, [date(2026, 10, 28), date(2026, 10, 27)])
    r = s.run()
    assert s.blocked and "403" in s.blocked and r["requests"] == 1 and r["stored"] == 0


def test_stored_values_cannot_be_changed(tmp_path: Path) -> None:
    import sqlite3

    s = _svc(tmp_path, Fake({"28102026"}), [date(2026, 10, 28)])
    s.run()
    with pytest.raises(sqlite3.DatabaseError):
        s.store._db.execute("UPDATE participant SET metrics='{}'")
