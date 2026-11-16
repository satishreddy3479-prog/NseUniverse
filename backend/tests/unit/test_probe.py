"""The read-only probe of what the broker returns for another underlying."""

from pathlib import Path

from fastapi.testclient import TestClient

from tests.conftest import make_app

LOCAL = ("127.0.0.1", 50000)


def test_the_probe_is_local_only_and_saves_the_raw_answer(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    with TestClient(app, client=("203.0.113.9", 50000)) as remote:
        assert remote.get("/api/probe/chain", params={"underlying": "BANKNIFTY"}).status_code == 403
    with TestClient(app, client=LOCAL) as c:
        body = c.get("/api/probe/chain", params={"underlying": "banknifty"}).json()
    assert body["underlying"] == "BANKNIFTY" and body["expiries"]
    assert body["expiry"] == str(body["expiries"][0])
    saved = Path(body["saved"])
    assert saved.exists() and saved.parent == tmp_path / "data" / "probe"
    assert saved.name.startswith("BANKNIFTY_")
