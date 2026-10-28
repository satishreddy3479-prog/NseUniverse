"""Structured JSON logging with secret redaction.

Must be configured before ``neo_api_client`` is imported, because the SDK reads
its NEO_LOG_* environment variables at import time.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# JWT-like tokens and long opaque strings that look like credentials.
_JWT_RE = re.compile(r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{4,}")
_KV_RE = re.compile(
    r"(?i)\b(token|sid|rid|auth|authorization|mpin|totp|otp|password|secret|consumer_key)"
    r"(\"?\s*[:=]\s*\"?)([^\s\",}]+)"
)
REDACTED = "[REDACTED]"


class Redactor:
    def __init__(self, secrets: list[str] | None = None) -> None:
        self._secrets = sorted({s for s in (secrets or []) if s}, key=len, reverse=True)

    def redact(self, text: str) -> str:
        for s in self._secrets:
            if s in text:
                text = text.replace(s, REDACTED)
        text = _JWT_RE.sub(REDACTED, text)
        return _KV_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}{REDACTED}", text)


class RedactingFilter(logging.Filter):
    def __init__(self, redactor: Redactor) -> None:
        super().__init__()
        self._redactor = redactor

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        record.msg = self._redactor.redact(msg)
        record.args = None
        extra = getattr(record, "fields", None)
        if isinstance(extra, dict):
            record.fields = json.loads(self._redactor.redact(json.dumps(extra, default=str)))
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        fields = getattr(record, "fields", None)
        if isinstance(fields, dict):
            payload.update(fields)
        if record.exc_info:
            payload["exc_type"] = record.exc_info[0].__name__ if record.exc_info[0] else None
        return json.dumps(payload, default=str)


def configure_sdk_logging_env(log_dir: Path) -> None:
    """Point the Kotak SDK's own rotating log into our git-ignored log dir."""
    log_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("NEO_LOG_LEVEL", "WARNING")
    os.environ.setdefault("NEO_LOG_FILE_LEVEL", "WARNING")
    os.environ.setdefault("NEO_LOG_FILE_PATH", str(log_dir / "neo-api-client.log"))


def setup_logging(level: str, log_dir: Path, secrets: list[str]) -> Redactor:
    configure_sdk_logging_env(log_dir)
    redactor = Redactor(secrets)
    root = logging.getLogger()
    root.setLevel(level.upper())
    for h in list(root.handlers):
        if getattr(h, "_nse_universe", False):
            root.removeHandler(h)
    formatter = JsonFormatter()
    redact_filter = RedactingFilter(redactor)

    console = logging.StreamHandler()
    console.setFormatter(formatter)
    console.addFilter(redact_filter)
    console._nse_universe = True  # type: ignore[attr-defined]
    root.addHandler(console)

    file_handler = logging.FileHandler(log_dir / "backend.log", encoding="utf-8")
    file_handler.setFormatter(formatter)
    file_handler.addFilter(redact_filter)
    file_handler._nse_universe = True  # type: ignore[attr-defined]
    root.addHandler(file_handler)
    return redactor


def log_event(logger: logging.Logger, level: int, msg: str, **fields: Any) -> None:
    logger.log(level, msg, extra={"fields": fields})
