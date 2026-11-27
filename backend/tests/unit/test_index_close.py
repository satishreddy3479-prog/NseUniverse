"""The closing auction's last index value survives a restart (26 Nov 2026: 25,884.50 held only in an open browser; a reload showed the frozen chain level 25,889.20)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.stream.index_close import IndexClose

IST_OFFSET = timedelta(hours=5, minutes=30)


def ist(h: int, m: int, s: int = 0, day: int = 26) -> datetime:
    return datetime(2026, 11, day, h, m, s, tzinfo=UTC) - IST_OFFSET


def test_keeps_the_last_auction_value_across_a_restart(tmp_path: Path) -> None:
    c = IndexClose(tmp_path)
    for t, v in [(ist(15, 20, 5), 25870.1), (ist(15, 27, 30), 25883.6), (ist(15, 29, 58), 25884.5)]:
        c.observe(t, v, 25819.25)
    again = IndexClose(tmp_path)  # a new process reads the file
    got = again.latest()
    assert got is not None and got["day"] == "2026-11-26" and got["ltp"] == 25884.5 and got["prev_close"] == 25819.25


def test_ignores_traded_hours_and_missing_values_and_weekends(tmp_path: Path) -> None:
    c = IndexClose(tmp_path)
    c.observe(ist(12, 0), 25900.0, 25819.25)  # continuous trading: not a closing value
    c.observe(ist(15, 25), None, 25819.25)  # missing stays missing
    c.observe(ist(15, 25, day=28), 25900.0, 25819.25)  # Saturday
    assert c.latest() is None


def test_nothing_stored_after_the_index_feed_ends(tmp_path: Path) -> None:
    c = IndexClose(tmp_path)
    c.observe(ist(15, 29), 25884.5, None)
    c.observe(ist(15, 45), 25999.0, None)  # after the auction: the last auction value stays
    assert c.latest()["ltp"] == 25884.5  # type: ignore[index]


def test_a_corrupt_file_is_ignored(tmp_path: Path) -> None:
    (tmp_path / "index-close.json").write_text("{not json", encoding="utf-8")
    assert IndexClose(tmp_path).latest() is None


async def test_the_endpoint_serves_the_close_and_answers_day_null_without_one(tmp_path: Path) -> None:
    """27 Nov 2026: an edit removed the route decorator, the endpoint answered 404 on the server and no test noticed."""
    from types import SimpleNamespace

    import httpx
    from fastapi import FastAPI

    from app.api import routes

    app = FastAPI()
    app.include_router(routes.router)
    ic = IndexClose(tmp_path)
    app.state.stream = SimpleNamespace(index_close=ic)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/market/index-close")
        assert r.status_code == 200 and r.json() == {"day": None}
        ic.observe(ist(15, 29), 25884.5, 25819.25)
        body = (await c.get("/api/market/index-close")).json()
        assert body["day"] == "2026-11-26" and body["ltp"] == 25884.5
    app.state.stream = SimpleNamespace(index_close=None)  # an application built without it
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        assert (await c.get("/api/market/index-close")).json() == {"day": None}
