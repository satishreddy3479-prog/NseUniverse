"""Observation store + OI intelligence. Hand-calculated expectations; the arithmetic is in comments.

Test inputs are small made-up chains (units, rupees) used only to check formulas; the application
itself never creates numbers. A separate test replays the real captured Kotak chain.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.analytics.oi import oi_change, oi_heatmap, oi_series, premium_decay, universe
from app.domain.models import (
    Completeness,
    DataSource,
    ExpiryKind,
    OptionChainRow,
    OptionChainSnapshot,
    OptionQuote,
)
from app.services.backfill import backfill_observations
from app.services.history import observe
from app.storage.observations import ObservationStore
from app.storage.store import SnapshotStore
from tests.conftest import make_app

EXP = "2026-11-03"
A = datetime(2026, 10, 27, 10, 0, tzinfo=UTC)  # previous session
B = datetime(2026, 10, 28, 3, 45, tzinfo=UTC)  # 09:15 IST, session open
C = datetime(2026, 10, 28, 4, 15, tzinfo=UTC)  # identical to B (stored as 'unchanged')
D = datetime(2026, 10, 28, 4, 45, tzinfo=UTC)  # latest


def quote(side: str, ltp: float | None, oi: int | None, prev: int | None) -> OptionQuote:
    return OptionQuote(
        exchange_segment="nse_fo", instrument_token=None, trading_symbol=None, option_type=side,
        ltp=ltp, open=None, high=None, low=None, prev_close=None, close=None, volume=10,
        oi=oi, oi_previous=prev, oi_change=None, oi_change_pct=None, moneyness=None,
    )  # fmt: skip


def snap(
    sid: str, at: datetime, spot: float | None, ce: dict[int, tuple], pe: dict[int, tuple]
) -> OptionChainSnapshot:
    rows = [
        OptionChainRow(strike=k, call=quote("CE", *ce[k]), put=quote("PE", *pe[k]))
        for k in sorted(ce)
    ]
    return OptionChainSnapshot(
        snapshot_id=sid, session_id="s1", underlying="NIFTY", expiry=date(2026, 11, 3),
        expiry_kinds=[ExpiryKind.WEEKLY], source=DataSource.SNAPSHOT, retrieved_at=at, lot_size=65,
        multiplier=1, requested_strike_count=3, completeness=Completeness.COMPLETE, rows=rows,
        ce_count=len(ce), pe_count=len(pe), underlying_ltp=spot,
    )  # fmt: skip


# (ltp, oi, oi_prev) per strike; prev-day OI is the same in every observation
PREV_CE, PREV_PE = {100: 50, 110: 40, 120: 30}, {100: 10, 110: 20, 120: 30}


def chain(sid: str, at: datetime, spot: float, ce_oi, pe_oi, ce_ltp, pe_ltp) -> OptionChainSnapshot:
    ce = {k: (ce_ltp[k], ce_oi[k], PREV_CE[k]) for k in PREV_CE}
    pe = {k: (pe_ltp[k], pe_oi[k], PREV_PE[k]) for k in PREV_PE}
    return snap(sid, at, spot, ce, pe)


@pytest.fixture
def obs(tmp_path: Path) -> ObservationStore:
    o = ObservationStore(tmp_path)
    o.record_snapshot(
        chain("a", A, 108.0, {100: 50, 110: 40, 120: 30}, {100: 10, 110: 20, 120: 30},
              {100: 15, 110: 8, 120: 3}, {100: 2, 110: 6, 120: 14}),
        unchanged=False,
    )  # fmt: skip
    b = chain("b", B, 109.0, {100: 60, 110: 40, 120: 25}, {100: 10, 110: 25, 120: 30},
              {100: 14, 110: 9, 120: 3.5}, {100: 2.5, 110: 5, 120: 13})  # fmt: skip
    o.record_snapshot(b, unchanged=False)
    o.record_snapshot(b.model_copy(update={"snapshot_id": "c", "retrieved_at": C}), unchanged=True)
    o.record_snapshot(
        chain("d", D, 111.0, {100: 55, 110: 60, 120: 25}, {100: 0, 110: 25, 120: 40},
              {100: 16, 110: 10, 120: 3}, {100: 2, 110: 4.5, 120: 12}),
        unchanged=False,
    )  # fmt: skip
    return o


def rows_by(res, side: str) -> dict[float, object]:
    return {r.strike: r for r in res.rows if r.side == side}


class TestStore:
    def test_unchanged_samples_resolve_to_the_earlier_values(self, obs: ObservationStore) -> None:
        s = obs.samples("NIFTY", EXP)
        assert [x.unchanged for x in s] == [False, False, True, False]
        assert s[2].values_from == s[1].sample_id  # C carries B's values
        assert obs.contracts(s[2].values_from)[(110.0, 0)].oi == 40

    def test_idempotent_per_snapshot_id_and_prices_are_exact(self, obs: ObservationStore) -> None:
        n = obs.stats()["samples"]
        obs.record_snapshot(
            chain("a", A, 108.0, {100: 50, 110: 40, 120: 30}, {100: 10, 110: 20, 120: 30},
                  {100: 15, 110: 8, 120: 3}, {100: 2, 110: 6, 120: 14}),
            unchanged=False,
        )  # fmt: skip
        assert obs.stats()["samples"] == n
        c = obs.contracts(obs.samples("NIFTY", EXP)[1].sample_id)
        assert (
            c[(120.0, 0)].ltp == 3.5 and c[(100.0, 1)].ltp == 2.5
        )  # paise round-trip, no float drift

    def test_missing_stays_null_never_zero(self, tmp_path: Path) -> None:
        o = ObservationStore(tmp_path)
        s = snap("m", B, None, {100: (None, None, None)}, {100: (5.0, 7, None)})
        o.record_snapshot(s, unchanged=False)
        sample = o.samples("NIFTY", EXP)[0]
        assert sample.spot is None
        ce = o.contracts(sample.sample_id)[(100.0, 0)]
        assert (ce.ltp, ce.oi, ce.oi_prev) == (None, None, None)

    def test_stored_garbage_reads_as_missing_without_altering_the_row(self, tmp_path: Path) -> None:
        o = ObservationStore(tmp_path)
        s = snap("g", B, 100.0, {100: (5.0, 7, 6)}, {100: (5.0, 7, 6)})
        sid = o.record_snapshot(s, unchanged=False)
        assert sid is not None
        bad = 223_000_000_000_000_000  # real corrupt OI seen on 30 Oct 2026
        o._db.execute("UPDATE contracts SET oi=? WHERE sample_id=? AND side=0", (bad, sid))
        o._db.commit()
        c = o.contracts(sid)
        assert c[(100.0, 0)].oi is None  # reads as missing, not as 2.23e17
        assert c[(100.0, 1)].oi == 7  # neighbours untouched
        row = o._db.execute("SELECT oi FROM contracts WHERE sample_id=? AND side=0", (sid,)).fetchone()
        assert row[0] == bad  # stored row never modified

    def test_old_contract_rows_pruned_only_with_matching_archive_and_anchor_kept(
        self, tmp_path: Path
    ) -> None:
        o = ObservationStore(tmp_path)
        z1_at = datetime(2026, 10, 26, 10, 0, tzinfo=UTC)
        z2_at = datetime(2026, 10, 26, 10, 5, tzinfo=UTC)
        args = ({100: 50, 110: 40, 120: 30}, {100: 10, 110: 20, 120: 30},
                {100: 15, 110: 8, 120: 3}, {100: 2, 110: 6, 120: 14})  # fmt: skip
        z1 = o.record_snapshot(chain("z1", z1_at, 108.0, *args), unchanged=False)
        z2 = o.record_snapshot(chain("z2", z2_at, 108.5, *args), unchanged=False)
        o.record_snapshot(chain("a", A, 108.0, *args), unchanged=False)
        o.record_snapshot(chain("b", B, 109.0, *args), unchanged=False)
        day = "2026-10-26"

        def rows(sid: int | None) -> int:
            return len(o.contracts(sid or 0))

        # 3 days stored, keep 2: only 26 Oct is old. Without an archive nothing goes.
        res = o.plan_contract_pruning(2, {}, delete=True)
        assert res["rows"] == 0 and res["blocked"] == [{"day": day, "reason": "no verified archive"}]
        # an archive that holds fewer rows than the database blocks it as well
        assert o.plan_contract_pruning(2, {day: 11}, delete=True)["rows"] == 0
        # dry run reports 6 rows (z1: 3 strikes x 2 sides) and removes nothing
        dry = o.plan_contract_pruning(2, {day: 12})
        assert dry["dry_run"] and dry["rows"] == 6 and dry["days"] == [day] and rows(z1) == 6
        # real run removes z1's rows, keeps z2 (newest changed sample of the day, anchor) and later days
        done = o.plan_contract_pruning(2, {day: 12}, delete=True)
        assert not done["dry_run"] and done["rows"] == 6
        assert rows(z1) == 0 and rows(z2) == 6
        assert len(o.samples("NIFTY", EXP)) == 4  # sample rows (time, spot) are never removed
        assert o.plan_contract_pruning(2, {day: 12}, delete=True)["rows"] == 0  # idempotent
        assert o.plan_contract_pruning(0, {day: 12}, delete=True)["rows"] == 0  # 0 = keep everything

    def test_data_survives_a_restart_and_events_are_logged(self, tmp_path: Path) -> None:
        o = ObservationStore(tmp_path)
        o.record_snapshot(
            snap("p", B, 109.0, {100: (1.0, 5, 4)}, {100: (1.0, 5, 4)}), unchanged=False
        )
        o.record_event("stream_state", "connecting -> streaming", "s1")
        o.close()
        again = ObservationStore(tmp_path)
        assert again.stats()["samples"] == 1 and again.stats()["contract_rows"] == 2
        assert again.events()[0]["kind"] == "stream_state"
        assert again.stats()["db_bytes"] > 0


class TestOiChange:
    def test_session_open_baseline_hand_calculated(self, obs: ObservationStore) -> None:
        r = oi_change(obs, "NIFTY", EXP, "session_open")
        assert r.baseline.at == B and r.current_at == D and r.atm_strike == 110
        ce, pe = rows_by(r, "CE"), rows_by(r, "PE")
        # CE oi: 100: 55-60=-5  110: 60-40=+20 (50%)  120: 25-25=0
        assert (ce[100].change, ce[110].change, ce[120].change) == (-5, 20, 0)
        assert ce[110].change_pct == pytest.approx(50.0)
        assert [ce[k].label for k in (100, 110, 120)] == [
            "OI decreased",
            "OI increased",
            "OI unchanged",
        ]
        # PE oi: 100: 0-10=-10 (-100%)  110: 25-25=0  120: 40-30=+10
        assert (pe[100].change, pe[110].change, pe[120].change) == (-10, 0, 10)
        assert pe[100].change_pct == pytest.approx(-100.0)
        assert r.totals.ce_oi == 140 and r.totals.pe_oi == 65
        assert r.totals.ce_change == 15 and r.totals.pe_change == 0
        assert r.underlying_change == 2.0  # 111 - 109

    def test_previous_baseline_is_the_last_observation_with_different_values(self, obs) -> None:
        r = oi_change(obs, "NIFTY", EXP, "previous")
        assert r.baseline.at == C  # the unchanged sample C holds B's values; A is older
        assert rows_by(r, "CE")[110].change == 20

    def test_selected_time_uses_the_latest_observation_at_or_before_it(self, obs) -> None:
        r = oi_change(obs, "NIFTY", EXP, "at", at=datetime(2026, 10, 28, 4, 20, tzinfo=UTC))
        assert r.baseline.at == C and rows_by(r, "CE")[110].change == 20
        early = oi_change(obs, "NIFTY", EXP, "at", at=datetime(2026, 10, 20, tzinfo=UTC))
        assert early.baseline.at is None and early.warnings
        assert all(x.label == "Insufficient data" and x.change is None for x in early.rows)

    def test_previous_session_baseline(self, obs: ObservationStore) -> None:
        r = oi_change(obs, "NIFTY", EXP, "prev_session")
        assert r.baseline.at == A
        # CE: 100: 55-50=+5   110: 60-40=+20   120: 25-30=-5
        assert [rows_by(r, "CE")[k].change for k in (100, 110, 120)] == [5, 20, -5]

    def test_broker_previous_day_field_is_labelled_and_has_no_price_baseline(self, obs) -> None:
        r = oi_change(obs, "NIFTY", EXP, "broker_prev_day")
        assert "unverified" in r.baseline.label
        ce = rows_by(r, "CE")
        assert [ce[k].change for k in (100, 110, 120)] == [5, 20, -5]
        assert ce[110].price_change is None and ce[110].relation is None

    def test_price_and_oi_relation_is_descriptive_only(self, obs: ObservationStore) -> None:
        r = oi_change(obs, "NIFTY", EXP, "session_open")
        ce, pe = rows_by(r, "CE"), rows_by(r, "PE")
        assert ce[110].relation == "OI up, premium up"  # +20 ; 10-9=+1
        assert pe[100].relation == "OI down, premium down"  # -10 ; 2-2.5=-0.5
        assert ce[120].relation == "OI flat, premium down"  # 0 ; 3-3.5
        assert ce[110].price_change == 1.0
        text = " ".join(r.definitions.values()).lower()
        assert "bullish" not in text and "support" in text  # states what it does NOT claim

    def test_concentration_and_its_change(self, obs: ObservationStore) -> None:
        r = oi_change(obs, "NIFTY", EXP, "session_open")
        ce = {c.strike: c for c in r.concentration if c.side == "CE"}
        # now 55/60/25 of 140; at open 60/40/25 of 125
        assert ce[110].share_pct == pytest.approx(60 / 140 * 100)
        assert ce[110].baseline_share_pct == pytest.approx(40 / 125 * 100)
        assert ce[110].share_change_pts == pytest.approx(60 / 140 * 100 - 32.0)
        pe = {c.strike: c for c in r.concentration if c.side == "PE"}
        assert 100.0 not in pe  # zero OI is not a concentration
        assert pe[120].share_pct == pytest.approx(40 / 65 * 100)

    def test_strike_universe_is_selectable(self, obs: ObservationStore) -> None:
        r = oi_change(obs, "NIFTY", EXP, "session_open", each_side=0)
        assert {x.strike for x in r.rows} == {110.0}
        assert universe([100, 110, 120], 111.0, 1) == [100, 110, 120]
        assert universe([100, 110, 120], None, 1) == [100, 110, 120]

    def test_zero_baseline_gives_no_percentage_and_missing_gives_no_change(self, tmp_path) -> None:
        o = ObservationStore(tmp_path)
        o.record_snapshot(
            snap("x1", B, 100.0, {100: (1.0, 0, None)}, {100: (1.0, None, None)}), unchanged=False
        )
        o.record_snapshot(
            snap("x2", D, 100.0, {100: (1.0, 30, None)}, {100: (1.0, 5, None)}), unchanged=False
        )
        r = oi_change(o, "NIFTY", EXP, "session_open", each_side=None)
        ce, pe = rows_by(r, "CE")[100], rows_by(r, "PE")[100]
        assert ce.change == 30 and ce.change_pct is None  # baseline 0: percentage undefined
        assert pe.change is None and pe.label == "Insufficient data"  # baseline missing, not 0

    def test_no_data_is_reported(self, tmp_path: Path) -> None:
        r = oi_change(ObservationStore(tmp_path), "NIFTY", EXP, "previous")
        assert r.rows == [] and r.warnings


class TestHeatmap:
    def test_session_open_grid(self, obs: ObservationStore) -> None:
        h = oi_heatmap(obs, "NIFTY", EXP, "CE", "session_open", since=B)
        assert h.strikes == [100.0, 110.0, 120.0] and h.times == [B, C, D]
        assert h.change == [
            [0, 0, -5],
            [0, 0, 20],
            [0, 0, 0],
        ]  # D-B per strike; B,C equal the baseline
        assert h.missing_cells == 0 and h.baseline.at == B

    def test_change_since_previous_column(self, obs: ObservationStore) -> None:
        h = oi_heatmap(obs, "NIFTY", EXP, "CE", "previous", since=B)
        # B-A: +10, 0, -5 ; C-B: 0 ; D-C: -5, +20, 0
        assert h.change == [[10, 0, -5], [0, 0, 20], [-5, 0, 0]]

    def test_broker_field_and_puts(self, obs: ObservationStore) -> None:
        h = oi_heatmap(obs, "NIFTY", EXP, "PE", "broker_prev_day", since=D)
        assert h.change == [[-10], [5], [10]]  # D oi 0/25/40 minus previous-day 10/20/30

    def test_missing_cells_are_none_and_counted(self, tmp_path: Path) -> None:
        o = ObservationStore(tmp_path)
        o.record_snapshot(
            snap("y1", B, 100.0, {100: (1.0, 10, None)}, {100: (1.0, 10, None)}), unchanged=False
        )
        o.record_snapshot(
            snap("y2", D, 100.0, {100: (1.0, None, None)}, {100: (1.0, 10, None)}), unchanged=False
        )
        h = oi_heatmap(o, "NIFTY", EXP, "CE", "session_open", each_side=None)
        assert h.change == [[0, None]] and h.missing_cells == 1

    def test_long_series_is_thinned_without_losing_the_latest(self, tmp_path: Path) -> None:
        o = ObservationStore(tmp_path)
        for i in range(10):
            at = datetime(2026, 10, 28, 4, i, tzinfo=UTC)
            o.record_snapshot(
                snap(f"z{i}", at, 100.0, {100: (1.0, 10 + i, None)}, {100: (1.0, 5, None)}),
                unchanged=False,
            )
        h = oi_heatmap(o, "NIFTY", EXP, "CE", "session_open", each_side=None, max_columns=4)
        assert h.stride == 3 and h.times[-1] == datetime(2026, 10, 28, 4, 9, tzinfo=UTC)
        assert h.change[0][-1] == 9 and h.warnings


class TestEngineWiring:
    def test_every_capture_is_observed_unchanged_ones_by_time_only(self, tmp_path: Path) -> None:
        app = make_app(tmp_path, sampler_enabled=False)
        with TestClient(app, client=("127.0.0.1", 50000)) as c:
            svc, obs = app.state.snapshot_service, app.state.observations
            import asyncio

            loop = asyncio.new_event_loop()
            loop.run_until_complete(svc.capture(skip_unchanged=True))
            loop.run_until_complete(svc.capture(skip_unchanged=True))  # identical real payload
            loop.close()
            s = obs.samples("NIFTY", EXP)
            assert [x.unchanged for x in s] == [False, True]
            assert "app_started" in {e["kind"] for e in obs.events()}
            assert c.get("/api/observations/status").json()["samples"] >= 2

    def test_backfill_imports_real_stored_snapshots_once(self, tmp_path: Path) -> None:
        app = make_app(tmp_path / "a", sampler_enabled=False)
        with TestClient(app, client=("127.0.0.1", 50000)) as c:
            c.post("/api/snapshots/capture", params={"expiry": EXP})
            c.post("/api/snapshots/capture", params={"expiry": EXP})
            store: SnapshotStore = app.state.store
            fresh = ObservationStore(tmp_path / "fresh")
            assert backfill_observations(store, fresh, "NIFTY") == 2
            assert backfill_observations(store, fresh, "NIFTY") == 0  # idempotent
            s = fresh.samples("NIFTY", EXP)
            assert [x.unchanged for x in s] == [
                False,
                True,
            ]  # the second real capture was identical
            first = fresh.contracts(s[0].values_from)
            assert len(first) == 162 and first[(22700.0, 0)].oi is not None


class TestApi:
    def test_oi_endpoints_on_real_captured_chain_and_input_validation(self, tmp_path: Path) -> None:
        app = make_app(tmp_path, sampler_enabled=False)
        with TestClient(app, client=("127.0.0.1", 50000)) as c:
            for _ in range(2):
                c.post("/api/snapshots/capture", params={"expiry": EXP})
            r = c.get(
                "/api/oi/change",
                params={"expiry": EXP, "baseline": "broker_prev_day", "strikes": "5"},
            )
            assert r.status_code == 200
            body = r.json()
            assert body["atm_strike"] == 22700.0 and len(body["rows"]) == 22  # 11 strikes x CE/PE
            atm_ce = next(x for x in body["rows"] if x["strike"] == 22700.0 and x["side"] == "CE")
            # real payload: OI minus the broker's previous-day OI (both are units)
            assert atm_ce["change"] == atm_ce["oi"] - atm_ce["baseline_oi"]
            assert atm_ce["label"] in {"OI increased", "OI decreased", "OI unchanged"}
            # the two captures are identical, so a 'previous distinct' baseline does not exist
            prev = c.get("/api/oi/change", params={"expiry": EXP, "baseline": "previous"}).json()
            assert prev["baseline"]["at"] is None and prev["warnings"]
            assert all(x["label"] == "Insufficient data" for x in prev["rows"])
            hm = c.get(
                "/api/oi/heatmap", params={"expiry": EXP, "side": "PE", "strikes": "3"}
            ).json()
            assert len(hm["strikes"]) == 7 and len(hm["times"]) == 2
            assert all(v == 0 for row in hm["change"] for v in row)  # identical captures: no change
            assert (
                c.get("/api/oi/change", params={"expiry": EXP, "strikes": "x"}).status_code == 422
            )
            assert c.get("/api/oi/change", params={"expiry": EXP, "at": "nope"}).status_code == 422
            assert (
                c.get("/api/oi/change", params={"expiry": EXP, "baseline": "tomorrow"}).status_code
                == 422
            )
            assert (
                c.get("/api/oi/heatmap", params={"expiry": EXP, "baseline": "x"}).status_code == 422
            )


class TestPremiumDecay:
    def test_sums_the_price_change_of_the_same_contracts(self, obs: ObservationStore) -> None:
        r = premium_decay(obs, "NIFTY", EXP, each_side=None, since=B)
        assert r.times == [B, C, D] and r.baseline_at == B and r.spot == [109.0, 109.0, 111.0]
        # calls D-B: 16-14, 10-9, 3-3.5 = +2 +1 -0.5 ; puts D-B: 2-2.5, 4.5-5, 12-13 = -0.5 -0.5 -1
        assert r.ce == [0.0, 0.0, 2.5] and r.pe == [0.0, 0.0, -2.0]
        assert r.ce_strikes_used == [3, 3, 3] and r.warnings == []

    def test_the_strike_set_is_fixed_not_re_centred_on_each_sample(
        self, obs: ObservationStore
    ) -> None:
        # newest spot 111 -> nearest strike 110. Only that strike is summed at every point, even though
        # the spot at B was 109 (also nearest to 110 here); calls 10-9 = +1, puts 4.5-5 = -0.5
        r = premium_decay(obs, "NIFTY", EXP, each_side=0, since=B)
        assert r.strikes == [110.0] and r.ce == [0.0, 0.0, 1.0] and r.pe == [0.0, 0.0, -0.5]

    def test_missing_or_zero_prices_are_left_out_and_counted_never_zero_filled(
        self, tmp_path: Path
    ) -> None:
        o = ObservationStore(tmp_path)
        o.record_snapshot(
            snap(
                "y1",
                B,
                100.0,
                {100: (5.0, 10, None), 110: (3.0, 10, None)},
                {100: (4.0, 10, None), 110: (6.0, 10, None)},
            ),
            unchanged=False,
        )
        o.record_snapshot(
            snap(
                "y2",
                D,
                100.0,
                {100: (7.0, 10, None), 110: (None, 10, None)},
                {100: (0.0, 10, None), 110: (7.0, 10, None)},
            ),
            unchanged=False,
        )
        r = premium_decay(o, "NIFTY", EXP, each_side=None, since=B)
        # calls at D: strike 110 has no price -> only 100: 7-5 = +2 ; puts at D: strike 100 price 0 -> only 110: 7-6 = +1
        assert r.ce == [0.0, 2.0] and r.pe == [0.0, 1.0]
        assert r.ce_strikes_used == [2, 1] and r.pe_strikes_used == [2, 1] and r.warnings

    def test_needs_two_samples(self, obs: ObservationStore) -> None:
        r = premium_decay(obs, "NIFTY", EXP, since=D)
        assert r.times == [] and r.warnings


class TestOiSeries:
    def test_totals_change_and_pcr_over_the_same_strikes(self, obs: ObservationStore) -> None:
        r = oi_series(obs, "NIFTY", EXP, each_side=None, since=B)
        assert r.times == [B, C, D] and r.strikes == [100.0, 110.0, 120.0]
        # B: calls 60+40+25 = 125, puts 10+25+30 = 65 ; D: calls 55+60+25 = 140, puts 0+25+40 = 65
        assert r.ce_oi == [125, 125, 140] and r.pe_oi == [65, 65, 65]
        # previous-day OI: calls 50+40+30 = 120, puts 10+20+30 = 60
        assert r.ce_change == [5, 5, 20] and r.pe_change == [5, 5, 5]
        assert r.pcr == [0.52, 0.52, 0.4643]  # 65/125, 65/125, 65/140

    def test_missing_oi_is_left_out_and_counted(self, tmp_path: Path) -> None:
        o = ObservationStore(tmp_path)
        o.record_snapshot(
            snap("z1", B, 100.0, {100: (1.0, 10, 8), 110: (1.0, None, 5)}, {100: (1.0, 20, 10), 110: (1.0, 30, None)}),
            unchanged=False,
        )
        r = oi_series(o, "NIFTY", EXP, each_side=None)
        assert r.ce_oi == [10] and r.ce_strikes_used == [1]  # strike 110 has no OI
        assert r.ce_change == [2]  # 10 - 8; the strike without OI is not zero-filled
        assert r.pe_oi == [50] and r.pe_change == [10]  # strike 110 has no previous-day OI: left out of the change
        assert r.warnings

    def test_no_data_is_reported(self, tmp_path: Path) -> None:
        r = oi_series(ObservationStore(tmp_path), "NIFTY", EXP)
        assert r.times == [] and r.warnings


class TestFixedUniverse:
    def test_totals_sum_the_same_strikes_whatever_the_atm_was(self) -> None:
        ce = {100: (15, 50, 50), 110: (8, 40, 40), 120: (3, 30, 30)}
        pe = {100: (2, 10, 10), 110: (6, 20, 20), 120: (14, 30, 30)}
        low = snap("f1", A, 99.0, ce, pe)  # ATM would be 100
        high = snap("f2", B, 121.0, ce, pe)  # ATM would be 120
        free_low, free_high = observe(low, 0), observe(high, 0)
        assert free_low.total_ce_premium == 15 and free_high.total_ce_premium == 3  # sliding: different strikes
        fixed = frozenset({110.0, 120.0})
        a, b = observe(low, 0, fixed), observe(high, 0, fixed)
        assert a.total_ce_premium == b.total_ce_premium == 8 + 3  # same two strikes in both
        assert a.total_pe_premium == b.total_pe_premium == 6 + 14
        assert a.total_ce_oi == 70 and a.strikes_in_universe == 2
        assert a.atm_strike == 100.0 and b.atm_strike == 120.0  # the ATM itself still follows the snapshot
