"""Stops the Kotak SDK's disabled log calls from costing CPU.

The SDK logs one INFO line for EVERY market-data packet (``sfeed_message_received``) from the thread that runs the event loop. Its structlog set-up filters by level only at the very end
(the default wrapper lets every call through to the processors), so each of those calls first ran the whole processor chain (context, timestamp, a recursive scrub of the event for secrets,
the formatter wrapper) and was dropped afterwards: about 28 microseconds per packet measured on a fast PC (``tests/unit/test_sdk_logging.py`` documents the mechanism), several times that on the
server's single vCPU, and the opening burst of ticks is thousands of packets a second. On 26 Nov 2026 the server's own loop profile (``/api/stream/health``) showed ~85 one-second stalls
in the first hour of the session with the loop thread inside that chain.

Here the wrapper is replaced by one that drops a call below the configured level before anything runs (about 0.8 microseconds). Warnings and errors are unchanged: they run the same
processors, so secrets are still censored.
"""

from __future__ import annotations

import logging
import os


def _level(name: str | None) -> int | None:
    if not name or name.upper() == "NOLOG":
        return None
    value = getattr(logging, name.upper(), None)
    return value if isinstance(value, int) else None


def quiet_sdk_logging() -> int | None:
    """Call after ``neo_api_client`` is imported (it configures structlog) and before the SDK logs anything. Returns the level calls are filtered at, or None if nothing was changed."""
    try:
        import structlog
    except ImportError:  # no SDK logging to speed up
        return None
    # the most verbose output the SDK was asked for (console or file): anything below it can never be written
    levels = [v for v in (_level(os.environ.get("NEO_LOG_LEVEL", "WARNING")), _level(os.environ.get("NEO_LOG_FILE_LEVEL", "WARNING"))) if v is not None]
    floor = min(levels) if levels else logging.CRITICAL  # both outputs off: only critical calls still pass
    cfg = structlog.get_config()
    structlog.configure(
        processors=cfg["processors"],
        logger_factory=cfg["logger_factory"],
        context_class=cfg["context_class"],
        wrapper_class=structlog.make_filtering_bound_logger(floor),
        cache_logger_on_first_use=cfg["cache_logger_on_first_use"],
    )
    return floor
