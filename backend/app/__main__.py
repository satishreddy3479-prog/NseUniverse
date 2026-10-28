"""Run the backend: ``python -m app`` (from the backend/ folder)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import uvicorn
from pydantic import ValidationError

from app.config import get_settings


def main() -> int:
    try:
        settings = get_settings()
    except ValidationError as e:
        # Only field names and messages; pydantic does not echo SecretStr values.
        print("Configuration error in backend/.env:", file=sys.stderr)
        for err in e.errors():
            loc = ".".join(str(p) for p in err.get("loc", [])) or "settings"
            print(f"  - {loc}: {err.get('msg')}", file=sys.stderr)
        return 2
    if not settings.host_is_loopback():
        print(
            "Refusing to bind to a non-loopback APP_HOST: Phase 1 has no authentication. "
            "Use 127.0.0.1.",
            file=sys.stderr,
        )
        return 2
    if os.environ.get("APP_RELOAD") == "1":
        # Development: the backend restarts by itself a moment after any file in app/ is saved, so a
        # browser refresh is enough to see a change. (Each restart signs in to the broker again.)
        uvicorn.run(
            "app.main:create_app",
            factory=True,
            host=settings.app_host,
            port=settings.app_port,
            reload=True,
            reload_dirs=[str(Path(__file__).resolve().parent)],
            reload_delay=1.5,
            timeout_graceful_shutdown=3,  # open browser sockets must not hold a restart for minutes
            log_config=None,
            access_log=False,
        )
        return 0
    from app.main import create_app

    uvicorn.run(
        create_app(settings),
        host=settings.app_host,
        port=settings.app_port,
        log_config=None,
        access_log=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
