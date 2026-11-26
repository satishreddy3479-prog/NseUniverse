"""The Kotak SDK logs every market-data packet at INFO; its disabled calls must not run the processor chain (see ``app/broker/sdk_logging.py``)."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from typing import Any

import pytest
import structlog

from app.broker.sdk_logging import quiet_sdk_logging


@pytest.fixture
def counted(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[str]]:
    """structlog with one counting processor and the SDK's default wrapper (every call reaches the processors), restored afterwards."""
    monkeypatch.setenv("NEO_LOG_LEVEL", "WARNING")
    monkeypatch.setenv("NEO_LOG_FILE_LEVEL", "WARNING")
    seen: list[str] = []
    out: list[Any] = []

    def count(_l: Any, method: str, event: dict[str, Any]) -> dict[str, Any]:
        seen.append(method)
        return event

    def sink(_l: Any, _m: str, event: dict[str, Any]) -> Any:
        out.append(event)
        raise structlog.DropEvent

    before = structlog.get_config()
    structlog.configure(processors=[count, sink], wrapper_class=structlog.stdlib.BoundLogger, logger_factory=structlog.stdlib.LoggerFactory(), cache_logger_on_first_use=False)
    try:
        yield seen
    finally:
        structlog.configure(**{k: v for k, v in before.items() if k in ("processors", "wrapper_class", "logger_factory", "context_class", "cache_logger_on_first_use")})


def test_before_the_change_every_disabled_call_ran_the_processors(counted: list[str]) -> None:
    structlog.get_logger("neo_api_client.websocket.feed.client").info("sfeed_message_received", instrument_token="1")
    assert counted == ["info"]  # the cost: a call that is never written still went through the chain


def test_after_it_a_call_below_the_level_runs_nothing_and_warnings_still_do(counted: list[str]) -> None:
    assert quiet_sdk_logging() == logging.WARNING
    log = structlog.get_logger("neo_api_client.websocket.feed.client")
    log.info("sfeed_message_received", instrument_token="1")
    log.debug("x")
    assert counted == []  # nothing ran for the packet-by-packet INFO calls
    log.warning("sfeed_disconnect", code=1006)
    log.error("sfeed_authentication_failed")
    assert counted == ["warning", "error"]  # the same processors (so the secret scrub) still run for what is written


def test_a_more_verbose_level_asked_for_keeps_its_calls(counted: list[str], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NEO_LOG_LEVEL", "INFO")
    assert quiet_sdk_logging() == logging.INFO
    structlog.get_logger("neo_api_client.x").info("kept")
    assert counted == ["info"]


def test_both_outputs_off_filters_everything(counted: list[str], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NEO_LOG_LEVEL", "NOLOG")
    monkeypatch.setenv("NEO_LOG_FILE_LEVEL", "NOLOG")
    assert quiet_sdk_logging() == logging.CRITICAL
    structlog.get_logger("neo_api_client.x").error("never written anyway")
    assert counted == []
