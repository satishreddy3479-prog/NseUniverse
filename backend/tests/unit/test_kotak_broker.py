import logging
from pathlib import Path
from typing import Any

import pytest

from app.broker.base import AuthState, BrokerError
from app.broker.kotak import KotakBroker, extract_error
from tests.conftest import make_settings


class FakeNeo:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.login_resp: dict[str, Any] = {"data": {"status": "success", "token": "view"}}
        self.validate_resp: dict[str, Any] = {"data": {"status": "success", "token": "eyJ.x.y"}}
        self.expiries_resp: Any = {
            "exchange": "nse_fo",
            "underlying": "NIFTY",
            "expiries": ["2026-11-03"],
        }
        self.chain_resp: Any = {"call": [], "put": []}
        self.raise_on: str | None = None

    def _rec(self, name: str, **kw: Any) -> None:
        self.calls.append((name, kw))
        if self.raise_on == name:
            raise RuntimeError("socket blew up with secret ck-abcdef123456")

    def totp_login(self, **kw: Any) -> Any:
        self._rec("totp_login", **kw)
        return self.login_resp

    def totp_validate(self, **kw: Any) -> Any:
        self._rec("totp_validate", **kw)
        return self.validate_resp

    def expiries(self, **kw: Any) -> Any:
        self._rec("expiries", **kw)
        return self.expiries_resp

    def option_chain(self, **kw: Any) -> Any:
        self._rec("option_chain", **kw)
        return self.chain_resp


@pytest.fixture
def broker(tmp_path: Path) -> tuple[KotakBroker, FakeNeo]:
    fake = FakeNeo()
    s = make_settings(tmp_path)
    return KotakBroker(s, client_factory=lambda **kw: fake), fake


@pytest.mark.parametrize(
    "resp,code",
    [
        ({"error": [{"code": "400", "message": "Missing"}]}, "400"),
        ({"Error": "Unexpected response format", "StatusCode": 502}, "502"),
        ({"fault": {"message": "denied"}}, "fault"),
        ("text", "bad_response"),
    ],
)
def test_extract_error(resp: Any, code: str) -> None:
    err = extract_error(resp)
    assert err is not None and err[0] == code


def test_extract_error_none_for_success() -> None:
    assert extract_error({"expiries": []}) is None


async def test_login_success_uses_generated_totp(broker: tuple[KotakBroker, FakeNeo]) -> None:
    b, fake = broker
    status = await b.login()
    assert status.state is AuthState.AUTHENTICATED
    name, kw = fake.calls[0]
    assert name == "totp_login" and kw["ucc"] == "UCC1234"
    assert len(kw["totp"]) == 6 and kw["totp"].isdigit()
    assert fake.calls[1] == ("totp_validate", {"mpin": "246810"})


async def test_login_failure_is_reported_safely(
    broker: tuple[KotakBroker, FakeNeo], caplog: pytest.LogCaptureFixture
) -> None:
    b, fake = broker
    fake.validate_resp = {"error": [{"code": "401", "message": "Invalid MPIN"}]}
    with caplog.at_level(logging.INFO):
        status = await b.login()
    assert status.state is AuthState.FAILED and status.last_error
    assert "246810" not in caplog.text


async def test_expiries_and_chain(broker: tuple[KotakBroker, FakeNeo]) -> None:
    b, fake = broker
    assert await b.get_expiries("NIFTY") == ["2026-11-03"]
    assert await b.get_option_chain("NIFTY", "2026-11-03", 40) == {"call": [], "put": []}
    assert (
        "option_chain",
        {"exchange": "nse_fo", "underlying": "NIFTY", "expiry": "2026-11-03", "count": 40},
    ) in fake.calls


async def test_rate_limit_classified(broker: tuple[KotakBroker, FakeNeo]) -> None:
    b, fake = broker
    fake.chain_resp = {"error": [{"code": "429", "message": "Too many requests"}]}
    with pytest.raises(BrokerError) as ei:
        await b.get_option_chain("NIFTY", "2026-11-03", 40)
    assert ei.value.code == "rate_limited" and ei.value.retryable


async def test_sdk_exception_text_not_leaked(broker: tuple[KotakBroker, FakeNeo]) -> None:
    b, fake = broker
    fake.raise_on = "expiries"
    with pytest.raises(BrokerError) as ei:
        await b.get_expiries("NIFTY")
    assert "ck-abcdef123456" not in ei.value.message and ei.value.code == "transport"


async def test_expiries_missing_list_is_error(broker: tuple[KotakBroker, FakeNeo]) -> None:
    b, fake = broker
    fake.expiries_resp = {"exchange": "nse_fo"}
    with pytest.raises(BrokerError):
        await b.get_expiries("NIFTY")
