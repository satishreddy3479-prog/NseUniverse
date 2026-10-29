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


CASH_CSV = """Category,Date,Buy Value(Rs Crores),Sell Value(Rs Crores),Net Value(Rs Crores)
DII **,28-Oct-2026,"16,834.50","16,191.10",643.40
FII/FPI *,28-Oct-2026,"16,834.50","15,962.70",871.80
"""


def test_cash_csv_parses_and_rejects_inconsistent_rows() -> None:
    from app.prediction.sources.nse import parse_cash_csv

    rows = parse_cash_csv(CASH_CSV)
    assert {r["category"] for r in rows} == {"DII", "FII/FPI"} and rows[0]["session"] == date(2026, 10, 28)
    with pytest.raises(NseParseError, match="does not equal"):
        parse_cash_csv(CASH_CSV.replace("643.40", "9000.00"))
    with pytest.raises(NseParseError, match="no column"):
        parse_cash_csv("a,b\n1,2\n")


def test_cash_window_keeps_only_the_newest_seven_sessions(tmp_path: Path) -> None:
    s = _svc(tmp_path, Fake(set()), [])
    for d in range(1, 12):  # 11 sessions, one import each
        text = f"Category,Date,Buy,Sell,Net\nFII/FPI,{d:02d}-Oct-2026,100,40,60\nDII,{d:02d}-Oct-2026,50,70,-20\n"
        r = s.import_cash_csv(text)
    days = sorted({row["session"] for row in s.store.cash_rows()})
    assert days == [f"2026-10-{d:02d}" for d in range(5, 12)] and r["sessions_kept"] == 7


def test_participant_window_backs_up_first_then_keeps_only_the_newest_sessions(tmp_path: Path) -> None:
    import sqlite3

    days = [date(2026, 10, d) for d in range(1, 15) if date(2026, 10, d).weekday() < 5]  # 10 weekdays
    have = {d.strftime("%d%m%Y") for d in days}
    s = _svc(tmp_path, Fake(have), days)
    s.run()
    assert s.store.coverage()["fao_participant_oi"]["files"] == 7  # run() already trimmed to the window
    backups = list((tmp_path / "backups").glob("nse_flows_before_prune_*.sqlite3"))
    assert len(backups) == 1
    old = sqlite3.connect(backups[0])
    assert old.execute("SELECT COUNT(*) FROM raw_files WHERE kind='fao_participant_oi'").fetchone()[0] == 10  # nothing lost
    assert sorted(s.store.participant_rows("fao_participant_oi"))[0] == days[-7]
    again = s.store.prune_participant(7, tmp_path / "backups")
    assert again["deleted_files"] == 0
    with pytest.raises(sqlite3.DatabaseError):
        s.store._db.execute("DELETE FROM raw_files")  # the protection is back after pruning


NSDL_HTML = b"""<html><body><table><tr><td>note</td></tr></table>
<table>
<tr><th>Reporting Date</th><th>Debt/Debt-VRR/Equity/Hybrid</th><th>Investment Route</th><th>Gross Purchases(Rs. Crore)</th><th>Gross Sales (Rs. Crore)</th><th>Net Investment (Rs. Crore)</th><th>US$</th><th>Conv</th></tr>
<tr><td rowspan="3">28-Oct-2026</td><td rowspan="3">Equity</td><td>Stock Exchange</td><td>24478.57</td><td>20280.67</td><td>4197.90</td><td>441.13</td><td>Rs.95.1623</td></tr>
<tr><td>Primary market &amp; others</td><td>6390.22</td><td>4.22</td><td>6386.00</td><td>671.06</td></tr>
<tr><td>Sub-total</td><td>30868.79</td><td>20284.89</td><td>10583.90</td><td>1112.19</td></tr>
<tr><td>Debt-FAR</td><td>Stock Exchange</td><td>813.00</td><td>3395.87</td><td>(2582.87)</td><td>(271.42)</td></tr>
</table></body></html>"""


def test_nsdl_fpi_page_is_parsed_from_the_real_layout_and_validated() -> None:
    from app.prediction.sources.nse import parse_nsdl_fpi

    rows = parse_nsdl_fpi(NSDL_HTML)
    assert rows[0]["category"] == "FPI equity (stock exchange)" and rows[0]["net"] == 4197.90 and rows[0]["session"] == date(2026, 10, 28)
    assert rows[1]["net"] == 10583.90 and rows[1]["buy"] == 30868.79
    with pytest.raises(NseParseError, match="does not equal"):
        parse_nsdl_fpi(NSDL_HTML.replace(b"4197.90", b"9999.90"))
    with pytest.raises(NseParseError, match="not found"):
        parse_nsdl_fpi(b"<html><body><table><tr><td>x</td></tr></table></body></html>")


def test_nsdl_is_fetched_once_a_day_and_stored_beside_the_nse_figures(tmp_path: Path) -> None:
    calls: list[int] = []

    def nsdl() -> Fetched:
        calls.append(1)
        return Fetched(200, NSDL_HTML)

    evening = datetime(2026, 10, 28, 13, 30, tzinfo=UTC)
    s = FlowsService(FlowsStore(tmp_path), lambda: [], fetcher=Fake(set()), cash_fetcher=lambda: Fetched(0, None, "offline"), nsdl_fetcher=nsdl, pause_s=0, clock=lambda: evening)
    s.run()
    s.run()
    assert len(calls) == 1 and s.nsdl_note is None
    assert {r["category"] for r in s.store.cash_rows()} == {"FPI equity (stock exchange)", "FPI equity (incl. primary market)"}


# ---------------------------------------------------------------- newest session, schedule, run log
from datetime import timedelta  # noqa: E402


class Clock:
    def __init__(self, at: datetime) -> None:
        self.at = at

    def __call__(self) -> datetime:
        return self.at


def _live(tmp_path: Path, fetcher: Fake, sessions: list[date], at: datetime) -> tuple[FlowsService, Clock]:
    clock = Clock(at)
    svc = FlowsService(
        FlowsStore(tmp_path), lambda: sessions, fetcher=fetcher, pause_s=0, clock=clock,
        cash_fetcher=lambda: Fetched(0, None, "offline"), nsdl_fetcher=lambda: Fetched(0, None, "offline"),
    )  # fmt: skip
    return svc, clock


EVENING = datetime(2026, 10, 29, 14, 0, tzinfo=UTC)  # 19:30 IST on Thursday 29 Oct


def test_the_volume_file_title_is_accepted_in_singular_form() -> None:
    body = csv_for("Oct 28, 2026", "Trading Volume")
    assert parse_participant(body, "fao_participant_vol", date(2026, 10, 28))["FII"]["Future Index Long"] == 3


def test_the_newest_session_is_requested_even_before_its_price_bar_exists(tmp_path: Path) -> None:
    f = Fake({"29102026", "28102026"})
    s, _ = _live(tmp_path, f, [date(2026, 10, 28)], EVENING)  # the bar list stops at 28 Oct
    s.run()
    assert s.store.coverage()["fao_participant_oi"]["last"] == "2026-10-29"
    assert s.store.coverage()["fao_participant_vol"]["last"] == "2026-10-29"


def test_the_expected_session_follows_the_publication_time_and_skips_weekends(tmp_path: Path) -> None:
    s, _ = _live(tmp_path, Fake(set()), [], EVENING)
    assert s.expected_session(datetime(2026, 10, 29, 14, 0, tzinfo=UTC)) == date(2026, 10, 29)  # 19:30 IST
    assert s.expected_session(datetime(2026, 10, 29, 9, 0, tzinfo=UTC)) == date(2026, 10, 28)  # 14:30 IST: not yet
    assert s.expected_session(datetime(2026, 10, 31, 14, 0, tzinfo=UTC)) == date(2026, 10, 30)  # Saturday -> Friday


def test_automatic_checks_repeat_only_while_the_newest_session_is_missing(tmp_path: Path) -> None:
    f = Fake({"28102026"})  # the 29 Oct files are not published yet
    s, clock = _live(tmp_path, f, [date(2026, 10, 28)], EVENING)
    assert s.due()  # first check after start
    s.run()
    assert s.missing_expected() and not s.due()  # just ran: wait
    clock.at += timedelta(minutes=31)
    assert s.due()  # still missing, 30 minutes later
    f.available.add("29102026")
    s.run()  # now published
    clock.at += timedelta(hours=2)
    assert s.missing_expected() == ["cash"] and s.due()  # cash feed offline in this test: still wanted
    s.cash_note = None
    s.store.save_cash([{"session": date(2026, 10, 29), "category": "FII/FPI", "buy": 2.0, "sell": 1.0, "net": 1.0}])
    assert s.missing_expected() == [] and not s.due()  # everything for the session is stored: stop


def test_no_automatic_check_before_the_evening_publication_time(tmp_path: Path) -> None:
    s, clock = _live(tmp_path, Fake(set()), [], datetime(2026, 10, 29, 9, 0, tzinfo=UTC))  # 14:30 IST
    s.last_attempt = clock.at - timedelta(hours=2)
    s.store.save_cash([{"session": date(2026, 10, 27), "category": "FII/FPI", "buy": 2.0, "sell": 1.0, "net": 1.0}])
    assert s.missing_expected() and not s.due()  # 28 Oct is expected and missing, but not before 18:30 IST


def test_a_manual_update_is_never_overwritten_and_the_run_log_tells_auto_from_manual(tmp_path: Path) -> None:
    f = Fake({"28102026", "29102026"})
    s, clock = _live(tmp_path, f, [date(2026, 10, 28)], EVENING)
    s.run("manual")
    calls_after_manual = len(f.calls)
    clock.at += timedelta(minutes=40)
    r = s.run("auto")  # everything is already stored: no file is requested again
    assert r["stored"] == 0 and len([c for c in f.calls[calls_after_manual:] if "29102026" in c]) == 0
    runs = s.store.last_runs()
    assert runs["participant_oi"]["last_manual_ok"]["newest_session"] == "2026-10-29"
    assert runs["participant_oi"]["last_auto_ok"]["trigger"] == "auto"
    assert runs["participant_vol"]["last_auto_ok"]["at"] > runs["participant_vol"]["last_manual_ok"]["at"]
    assert s.status()["expected_session"] == "2026-10-29" and "components" in s.status()


def test_a_failed_check_is_not_recorded_as_a_successful_one(tmp_path: Path) -> None:
    s, _ = _live(tmp_path, Fake(set(), status=403), [date(2026, 10, 28)], EVENING)
    s.run("auto")
    runs = s.store.last_runs()
    assert runs["participant_oi"]["last"]["ok"] is False and runs["participant_oi"]["last_auto_ok"] is None
