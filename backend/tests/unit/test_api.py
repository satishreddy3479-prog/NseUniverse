from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tests.conftest import make_app

LOCAL = ("127.0.0.1", 50000)


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    app = make_app(tmp_path)
    with TestClient(app, client=LOCAL) as c:
        yield c


def test_health_and_status(client: TestClient) -> None:
    assert client.get("/api/health").json()["status"] == "ok"
    st = client.get("/api/status").json()
    assert "data_mode" not in st and "data_source" not in st  # there is no demo mode
    assert st["auth"]["state"] == "authenticated"
    assert st["stream"]["implemented"] is True and st["stream"]["state"] == "stopped"
    assert st["stream"]["market"]["state"] == "unknown"


def test_config_status_exposes_presence_only(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    with TestClient(app, client=LOCAL) as c:
        body = c.get("/api/config/status").text
    assert "ck-abcdef123456" not in body
    assert '"kotak_consumer_key":true' in body


def test_expiries_capture_and_read_back_real_captured_chain(client: TestClient) -> None:
    sel = client.get("/api/expiries?underlying=NIFTY").json()
    assert sel["source"] == "snapshot"
    assert sel["weekly"] == "2026-11-03" and sel["monthly"] == "2026-11-23"
    assert sel["weekly_equals_monthly"] is False and sel["monthly_is_next_month"] is True

    caps = client.post("/api/snapshots/capture").json()
    assert [c["expiry"] for c in caps] == ["2026-11-03", "2026-11-23"]
    assert caps[0]["expiry_kinds"] == ["weekly"] and caps[1]["expiry_kinds"] == ["monthly"]
    assert all(c["source"] == "snapshot" and c["strikes"] == 81 for c in caps)
    assert all(c["underlying_ltp"] == 22698.85 for c in caps)

    chain = client.get("/api/option-chain?expiry=2026-11-03").json()
    snap = chain["snapshot"]
    assert chain["display_source"] == "snapshot" and chain["stale"] is False
    assert snap["completeness"] == "complete" and len(snap["rows"]) == 81
    assert snap["lot_size"] == 65 and snap["underlying_prev_close"] == 22749.75
    assert snap["rows"][0]["strike"] == 20700.0 and snap["rows"][-1]["strike"] == 24700.0
    atm = next(r for r in snap["rows"] if r["call"]["moneyness"] == "ATM")
    assert atm["strike"] == 22700.0  # nearest strike to the real spot 22698.85
    c = atm["call"]
    assert (
        c["oi_change"] == c["oi"] - c["oi_previous"]
    )  # computed, not the source's price-change field
    assert c["oi"] % 65 == 0  # OI is in units (multiples of the lot size)

    sid = caps[0]["snapshot_id"]
    assert client.get(f"/api/snapshots/{sid}").json()["snapshot"]["snapshot_id"] == sid
    csv = client.get(f"/api/snapshots/{sid}/csv")
    assert csv.status_code == 200 and csv.text.startswith("underlying,")
    assert len(client.get("/api/snapshots").json()) == len(caps)
    assert client.get("/api/sessions").json()[0]["snapshot_count"] == len(caps)


def test_capture_of_one_expiry_fetches_only_that_expiry(tmp_path: Path) -> None:
    from tests.replay import ReplayBroker

    broker = ReplayBroker()
    from app.main import create_app
    from tests.conftest import make_settings

    app = create_app(make_settings(tmp_path / "b"), broker=broker)
    with TestClient(app, client=LOCAL) as c:
        r = c.post("/api/snapshots/capture?expiry=2026-11-23")
        assert r.status_code == 200 and [x["expiry"] for x in r.json()] == ["2026-11-23"]
    assert broker.chain_calls == ["2026-11-23"]


def test_option_chain_404_without_snapshot(client: TestClient) -> None:
    r = client.get("/api/option-chain?expiry=2030-01-01")
    assert r.status_code == 404 and r.json()["detail"]["code"] == "no_snapshot"


def test_capture_unlisted_expiry_rejected(client: TestClient) -> None:
    r = client.post("/api/snapshots/capture?expiry=2030-01-01")
    assert r.status_code == 400


def test_validation_errors_are_structured(client: TestClient) -> None:
    r = client.get("/api/option-chain?expiry=not-a-date")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "validation_error"
    assert client.get("/api/expiries?underlying=BANKNIFTY").status_code == 400
    assert client.get("/api/expiries?underlying=NI;FTY").status_code == 422
    assert client.get("/api/snapshots/..%2Fetc").status_code in (400, 404)


def test_control_endpoints_reject_remote_clients(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    with TestClient(app, client=("203.0.113.9", 4000)) as c:
        assert c.post("/api/snapshots/capture").status_code == 403
        assert c.post("/api/auth/login").status_code == 403
        assert c.get("/api/health").status_code == 200


def test_control_endpoints_reject_foreign_origin(client: TestClient) -> None:
    r = client.post("/api/snapshots/capture", headers={"Origin": "http://evil.example"})
    assert r.status_code == 403
    ok = client.post("/api/snapshots/capture", headers={"Origin": "http://localhost:5173"})
    assert ok.status_code == 200


def test_cors_allows_only_configured_origins(client: TestClient) -> None:
    good = client.get("/api/health", headers={"Origin": "http://localhost:5173"})
    bad = client.get("/api/health", headers={"Origin": "http://evil.example"})
    assert good.headers.get("access-control-allow-origin") == "http://localhost:5173"
    assert "access-control-allow-origin" not in bad.headers


def test_history_observations_match_an_independent_calculation_from_the_raw_payload(
    client: TestClient,
) -> None:
    import json

    from tests.replay import load_payload

    assert client.get("/api/history/observations?expiry=2026-11-03").json()["observations"] == []
    client.post("/api/snapshots/capture?expiry=2026-11-03")
    client.post("/api/snapshots/capture?expiry=2026-11-03")
    h = client.get("/api/history/observations?expiry=2026-11-03&strikes=10").json()
    assert len(h["observations"]) == 2 and h["distinct_observations"] == 1
    assert [o["same_as_previous"] for o in h["observations"]] == [False, True]
    o = h["observations"][0]

    # independent calculation straight from the real Kotak payload
    raw = load_payload("2026-11-03")
    by_strike = {}
    for side in ("call", "put"):
        for item in raw[side]:
            k = float(item["inst"]["strkPrc"])
            by_strike.setdefault(k, {})[side] = item
    strikes = sorted(by_strike)
    atm = next(k for k in strikes if by_strike[k]["call"]["inst"]["moneyness"] == "atm")
    i = strikes.index(atm)
    uni = strikes[i - 10 : i + 11]

    def ltp(item: dict) -> float:
        return float(item["quote"]["ltp"])

    assert o["atm_strike"] == atm == 22700.0
    assert o["strikes_in_universe"] == 21
    assert o["total_ce_premium"] == pytest.approx(sum(ltp(by_strike[k]["call"]) for k in uni))
    assert o["total_pe_premium"] == pytest.approx(sum(ltp(by_strike[k]["put"]) for k in uni))
    assert o["atm_call_ltp"] == pytest.approx(ltp(by_strike[atm]["call"]))
    assert o["straddle"] == pytest.approx(ltp(by_strike[atm]["call"]) + ltp(by_strike[atm]["put"]))
    assert o["total_ce_oi"] == sum(int(by_strike[k]["call"]["oi"]["cur"]) for k in uni)
    assert o["underlying_ltp"] == 22698.85 and "total_ce_premium" in h["definitions"]
    json.dumps(h)  # serialisable


def test_history_rejects_bad_parameters(client: TestClient) -> None:
    assert client.get("/api/history/observations?expiry=nope").status_code == 422
    assert client.get("/api/history/observations?expiry=2026-11-03&strikes=0").status_code == 422
