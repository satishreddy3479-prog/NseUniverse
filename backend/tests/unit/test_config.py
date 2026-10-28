from pathlib import Path

import pytest
from pydantic import ValidationError

from tests.conftest import CREDS, make_settings


def test_all_credentials_present(tmp_path: Path) -> None:
    s = make_settings(tmp_path)
    assert all(s.credential_presence().values())
    assert "246810" not in repr(s) and "JBSWY3DPEHPK3PXP" not in repr(s)


def test_missing_credentials_are_listed_by_name_without_values(tmp_path: Path) -> None:
    with pytest.raises(ValidationError) as ei:
        make_settings(tmp_path, kotak_mpin=None, kotak_totp_secret=None)
    msg = str(ei.value)
    assert "KOTAK_MPIN" in msg and "KOTAK_TOTP_SECRET" in msg
    assert "KOTAK_CONSUMER_KEY" not in msg.split("required in backend/.env")[1]
    assert CREDS["kotak_consumer_key"] not in msg


def test_there_is_no_demo_mode_setting(tmp_path: Path) -> None:
    s = make_settings(tmp_path)
    assert not hasattr(s, "data_mode")


def test_blank_credentials_count_as_missing(tmp_path: Path) -> None:
    with pytest.raises(ValidationError):
        make_settings(tmp_path, kotak_mpin="   ")


@pytest.mark.parametrize("count", [15, 5, 1000])
def test_strike_count_must_be_multiple_of_ten_in_range(tmp_path: Path, count: int) -> None:
    with pytest.raises(ValidationError):
        make_settings(tmp_path, option_chain_strike_count=count)


def test_underlying_normalized_and_validated(tmp_path: Path) -> None:
    assert make_settings(tmp_path, underlying=" nifty ").underlying == "NIFTY"
    with pytest.raises(ValidationError):
        make_settings(tmp_path, underlying="NIFTY;DROP")


@pytest.mark.parametrize(
    "host,ok",
    [
        ("127.0.0.1", True),
        ("localhost", True),
        ("::1", True),
        ("0.0.0.0", False),
        ("192.168.1.5", False),
    ],
)
def test_loopback_detection(tmp_path: Path, host: str, ok: bool) -> None:
    assert make_settings(tmp_path, app_host=host).host_is_loopback() is ok


def test_origins_parsing(tmp_path: Path) -> None:
    s = make_settings(tmp_path, allowed_origins=" http://a:1 , ,http://b:2")
    assert s.origins() == ["http://a:1", "http://b:2"]


def test_stream_autostart_defaults_on() -> None:
    from app.config import Settings

    assert Settings(_env_file=None, **CREDS).stream_autostart is True
