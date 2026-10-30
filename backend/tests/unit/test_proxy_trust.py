"""Behind Caddy a request is judged by its TCP peer (loopback), not by X-Forwarded-For.

Otherwise the live WebSocket and every control endpoint (Compute now, Update now,
start/stop stream) are rejected for every browser: the real address is not loopback.
"""

import threading
import time
import urllib.request
from collections.abc import Iterator

import pytest
import uvicorn
from fastapi import FastAPI, Request

from app.__main__ import server_options
from app.api.security import _is_loopback


@pytest.fixture
def server() -> Iterator[int]:
    app = FastAPI()

    @app.get("/who")
    def who(request: Request) -> dict[str, bool]:
        return {"loopback": _is_loopback(request.client.host if request.client else None)}

    port = 18766
    cfg = uvicorn.Config(app, host="127.0.0.1", port=port, **server_options())  # type: ignore[arg-type]
    srv = uvicorn.Server(cfg)
    t = threading.Thread(target=srv.run, daemon=True)
    t.start()
    for _ in range(50):
        if srv.started:
            break
        time.sleep(0.1)
    yield port
    srv.should_exit = True
    t.join(timeout=5)


def test_a_request_forwarded_by_the_proxy_still_counts_as_local(server: int) -> None:
    url = f"http://127.0.0.1:{server}/who"
    req = urllib.request.Request(url, headers={"X-Forwarded-For": "203.0.113.9"})
    assert b'"loopback":true' in urllib.request.urlopen(req, timeout=5).read()  # noqa: S310


def test_the_default_would_have_rejected_it() -> None:
    # uvicorn's default replaces the peer with the forwarded address
    assert server_options()["proxy_headers"] is False
