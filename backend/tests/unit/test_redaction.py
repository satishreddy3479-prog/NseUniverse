import logging
from pathlib import Path

from app.logging_setup import REDACTED, Redactor, log_event, setup_logging


def test_redacts_known_secret_values() -> None:
    r = Redactor(["supersecretvalue", "246810"])
    out = r.redact("login with supersecretvalue and mpin 246810")
    assert "supersecretvalue" not in out and "246810" not in out
    assert out.count(REDACTED) == 2


def test_redacts_jwt_and_key_value_pairs() -> None:
    r = Redactor([])
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgh"
    out = r.redact(f'{{"token": "abc123", "sid":"s-1"}} bearer {jwt} totp=123456')
    assert "abc123" not in out and "s-1" not in out and jwt not in out and "123456" not in out


def test_instrument_tokens_are_not_redacted() -> None:
    out = Redactor([]).redact("instrument nse_fo|44498 subscribed")
    assert "44498" in out


def test_log_output_is_redacted(tmp_path: Path) -> None:
    setup_logging("INFO", tmp_path, ["my-secret-key-123"])
    lg = logging.getLogger("t")
    log_event(lg, logging.INFO, "using my-secret-key-123", extra_field="my-secret-key-123")
    for h in logging.getLogger().handlers:
        h.flush()
    text = (tmp_path / "backend.log").read_text()
    assert "my-secret-key-123" not in text and REDACTED in text
