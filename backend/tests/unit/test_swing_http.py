"""The network side of the swing scanner (HttpFetcher) with a fake opener: retries, refusals and what each failure becomes. No network is used."""

from __future__ import annotations

import io
import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import pytest

from app.swing import fetch as F
from app.swing.fetch import FetchError, HttpFetcher

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "swing"


class Resp(io.BytesIO):
    def __enter__(self) -> Resp:
        return self

    def __exit__(self, *a: object) -> None:
        self.close()


class Opener:
    """Plays a script: each call to open() raises the next error or returns the next body."""

    def __init__(self, script: list[Any]) -> None:
        self.script, self.seen = list(script), []

    def open(self, req: urllib.request.Request, timeout: float = 0) -> Resp:
        self.seen.append(req.full_url)
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        return Resp(step if isinstance(step, bytes) else json.dumps(step).encode())


def http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://x.test/", code, "x", {}, None)  # type: ignore[arg-type]


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    slept: list[float] = []
    monkeypatch.setattr(F.time, "sleep", slept.append)
    return slept


def get(opener: Opener, url: str = "https://x.test/a?b=1", retries: int = 3) -> bytes:
    return HttpFetcher(retries=retries)._get(opener, urllib.request.Request(url))  # type: ignore[arg-type]  # noqa: S310 - a fake opener, nothing is opened


def test_a_busy_answer_is_retried_with_a_growing_pause_and_then_succeeds(no_sleep: list[float]) -> None:
    op = Opener([http_error(429), http_error(503), b"ok"])
    assert get(op) == b"ok" and len(op.seen) == 3
    assert no_sleep == [1.5, 3.0]  # 1.5 s x attempt number


def test_an_error_that_will_not_change_is_not_retried_and_a_dead_link_is_named_without_its_query(no_sleep: list[float]) -> None:
    op = Opener([http_error(404), b"never reached"])
    with pytest.raises(FetchError, match=r"https://x.test/a: HTTPError"):
        get(op)
    assert len(op.seen) == 1  # a 404 is final
    down = Opener([urllib.error.URLError("refused"), TimeoutError(), OSError("reset")])
    with pytest.raises(FetchError, match="OSError"):  # the last failure is the one reported
        get(down)
    assert len(down.seen) == 3


def test_only_fixed_https_endpoints_are_ever_requested() -> None:
    op = Opener([b"x"])
    with pytest.raises(FetchError, match="non-https"):
        get(op, url="http://x.test/")
    assert op.seen == []


def test_the_chartink_universe_needs_its_csrf_token_in_either_attribute_order(monkeypatch: pytest.MonkeyPatch) -> None:
    rows = {"data": [{"nsecode": "ABC", "name": "A"}, {"nsecode": "", "name": "no code"}, "junk"]}
    for page in (b'<meta name="csrf-token" content="tok1">', b'<meta content="tok2" name="csrf-token">'):
        op = Opener([page, rows])
        monkeypatch.setattr(urllib.request, "build_opener", lambda *a, op=op: op)
        assert HttpFetcher().universe() == [{"nsecode": "ABC", "name": "A"}]
        assert op.seen == [F.SCREENER_URL, F.PROCESS_URL]
    monkeypatch.setattr(urllib.request, "build_opener", lambda *a: Opener([b"<html>no token</html>"]))
    with pytest.raises(FetchError, match="CSRF"):
        HttpFetcher().universe()
    monkeypatch.setattr(urllib.request, "build_opener", lambda *a: Opener([b'<meta name="csrf-token" content="t">', b"<html>not json</html>"]))
    with pytest.raises(FetchError, match="not JSON"):
        HttpFetcher().universe()


def test_a_yahoo_chart_is_parsed_and_an_unreadable_one_fails_safe(monkeypatch: pytest.MonkeyPatch, no_sleep: list[float]) -> None:
    raw = json.loads(next(iter(sorted(FIX.glob("*chart*.json")) or sorted(FIX.glob("*.json")))).read_text(encoding="utf-8"))
    if "chart" in raw:
        monkeypatch.setattr(urllib.request, "build_opener", lambda *a: Opener([raw]))
        bars = HttpFetcher(pause_s=0.15).daily("RELIANCE.NS")
        assert bars and all(len(b) == 6 for b in bars) and no_sleep[0] == 0.15  # the polite pause came first
    monkeypatch.setattr(urllib.request, "build_opener", lambda *a: Opener([{"chart": {"result": [{"timestamp": [1], "indicators": {}}]}}]))
    with pytest.raises(FetchError, match="unreadable chart"):
        HttpFetcher().daily("X.NS")
    monkeypatch.setattr(urllib.request, "build_opener", lambda *a: Opener([b"not json"]))
    with pytest.raises(FetchError, match="unreadable chart"):
        HttpFetcher().daily("X.NS")
