"""Kotak Neo adapter built on the official ``kotakneoapi`` SDK (v3.0.x).

Verified against SDK source v3.0.13:
- ``NeoAPI(consumer_key=..., environment="prod")``
- ``totp_login(mobile_number=, ucc=, totp=)`` then ``totp_validate(mpin=)``
- ``expiries(exchange, underlying)`` and ``option_chain(exchange, underlying, expiry, count=)``
  authenticate with the consumer key only and return dicts (errors are returned,
  not raised).

The SDK is synchronous; calls run in a worker thread so the event loop stays free.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any

from app.broker.base import AuthState, AuthStatus, BrokerError
from app.config import Settings
from app.logging_setup import log_event
from app.stream.feed import FeedSession

logger = logging.getLogger(__name__)

EXCHANGE_FO = "nse_fo"
MIN_CALL_INTERVAL_S = 0.35  # conservative client-side spacing between REST calls


def extract_error(resp: Any) -> tuple[str, str] | None:
    """Return (code, safe message) if ``resp`` is an SDK/back-end error payload."""
    if not isinstance(resp, Mapping):
        return "bad_response", "unexpected response type from broker"
    if "error" in resp and resp["error"]:
        err = resp["error"]
        first = err[0] if isinstance(err, list) and err else err
        if isinstance(first, Mapping):
            return str(first.get("code", "error")), str(first.get("message", "broker error"))[:200]
        return "error", str(first)[:200]
    if "Error" in resp:
        status = resp.get("StatusCode")
        return (str(status) if status else "error"), str(resp.get("Error"))[:200]
    if "fault" in resp:
        fault = resp["fault"]
        msg = fault.get("message") if isinstance(fault, Mapping) else fault
        return "fault", str(msg)[:200]
    return None


def _classify(code: str, message: str) -> BrokerError:
    low = message.lower()
    if code == "429" or "too many" in low:
        return BrokerError(
            "broker rate limit reached; retry later", code="rate_limited", retryable=True
        )
    if code in ("401", "403") or "session" in low or "2fa" in low:
        return BrokerError("broker rejected the session/credentials", code="auth", retryable=True)
    if code == "400":
        return BrokerError(f"broker rejected the request: {message}", code="bad_request")
    return BrokerError(f"broker error ({code}): {message}", code="broker_error", retryable=True)


class KotakBroker:
    name = "kotak_neo"

    def __init__(self, settings: Settings, client_factory: Callable[..., Any] | None = None):
        self._settings = settings
        self._client_factory = client_factory
        self._client: Any | None = None
        self._auth = AuthStatus(state=AuthState.NOT_ATTEMPTED)
        self._call_lock = asyncio.Lock()
        self._login_lock = asyncio.Lock()
        self._last_call = 0.0

    @property
    def auth_status(self) -> AuthStatus:
        return self._auth

    def _secret(self, name: str) -> str:
        v = getattr(self._settings, name)
        if v is None or not v.get_secret_value().strip():
            raise BrokerError(f"{name.upper()} is not configured", code="config")
        return str(v.get_secret_value().strip())

    def _get_client(self) -> Any:
        if self._client is None:
            factory = self._client_factory
            if factory is None:
                from neo_api_client.neo_api import NeoAPI  # lazy: after logging setup

                factory = NeoAPI
            self._client = factory(
                consumer_key=self._secret("kotak_consumer_key"), environment="prod"
            )
        return self._client

    async def _call(self, fn_name: str, *args: Any, **kwargs: Any) -> Any:
        async with self._call_lock:
            wait = MIN_CALL_INTERVAL_S - (time.monotonic() - self._last_call)
            if wait > 0:
                await asyncio.sleep(wait)
            client = self._get_client()
            fn = getattr(client, fn_name)
            try:
                return await asyncio.to_thread(fn, *args, **kwargs)
            except BrokerError:
                raise
            except Exception as exc:  # SDK/network failure; never echo raw exception text
                log_event(
                    logger,
                    logging.WARNING,
                    "broker_call_exception",
                    call=fn_name,
                    exc_type=type(exc).__name__,
                )
                raise BrokerError(
                    f"broker call {fn_name} failed ({type(exc).__name__})",
                    code="transport",
                    retryable=True,
                ) from None
            finally:
                self._last_call = time.monotonic()

    @staticmethod
    def _totp_now(secret: str) -> str:
        import pyotp

        totp = pyotp.TOTP(secret.replace(" ", ""))
        # Avoid submitting a code that expires in transit.
        remaining = totp.interval - (int(time.time()) % totp.interval)
        if remaining < 3:
            time.sleep(remaining + 0.5)
        return str(totp.now())

    async def login(self) -> AuthStatus:
        """Sign in now (also used to re-sign-in after the session is rejected)."""
        async with self._login_lock:
            return await self._login_locked()

    async def ensure_login(self) -> AuthStatus:
        """Sign in only if not already signed in. Concurrent callers share one login."""
        async with self._login_lock:
            if self._auth.state is AuthState.AUTHENTICATED:
                return self._auth
            return await self._login_locked()

    async def _login_locked(self) -> AuthStatus:
        now = datetime.now(UTC)
        self._auth = AuthStatus(
            state=AuthState.AUTHENTICATING,
            last_attempt_at=now,
            last_success_at=self._auth.last_success_at,
        )
        try:
            try:
                code = await asyncio.to_thread(self._totp_now, self._secret("kotak_totp_secret"))
            except BrokerError:
                raise
            except Exception:
                raise BrokerError(
                    "KOTAK_TOTP_SECRET is not a valid base32 secret", code="config"
                ) from None
            r1 = await self._call(
                "totp_login",
                mobile_number=self._secret("kotak_mobile_number"),
                ucc=self._secret("kotak_ucc"),
                totp=code,
            )
            if err := extract_error(r1):
                raise _classify(*err)
            r2 = await self._call("totp_validate", mpin=self._secret("kotak_mpin"))
            if err := extract_error(r2):
                raise _classify(*err)
            data = r2.get("data") if isinstance(r2, Mapping) else None
            if not isinstance(data, Mapping) or not data.get("token"):
                raise BrokerError("login response did not contain a session", code="auth")
            self._auth = AuthStatus(
                state=AuthState.AUTHENTICATED,
                last_attempt_at=now,
                last_success_at=datetime.now(UTC),
            )
            log_event(logger, logging.INFO, "broker_login_ok")
        except BrokerError as e:
            self._auth = AuthStatus(
                state=AuthState.FAILED,
                last_attempt_at=now,
                last_success_at=self._auth.last_success_at,
                last_error=e.message,
            )
            log_event(logger, logging.WARNING, "broker_login_failed", code=e.code, reason=e.message)
        return self._auth

    async def get_expiries(self, underlying: str) -> list[Any]:
        resp = await self._call("expiries", exchange=EXCHANGE_FO, underlying=underlying)
        if err := extract_error(resp):
            raise _classify(*err)
        body = resp.get("data") if isinstance(resp.get("data"), Mapping) else resp
        values = body.get("expiries")
        if not isinstance(values, list):
            raise BrokerError("expiries response has no 'expiries' list", code="bad_response")
        return values

    async def get_option_chain(self, underlying: str, expiry: str, count: int) -> Mapping[str, Any]:
        resp = await self._call(
            "option_chain",
            exchange=EXCHANGE_FO,
            underlying=underlying,
            expiry=expiry,
            count=count,
        )
        if err := extract_error(resp):
            raise _classify(*err)
        if not isinstance(resp, Mapping):
            raise BrokerError("option_chain returned a non-object", code="bad_response")
        return resp

    async def scrip_master_rows(self, exchange_segment: str = "nse_cm") -> list[dict[str, str]]:
        """Rows of Kotak's scrip master for one segment (token and trading symbol per instrument).

        The SDK returns the location(s) of the CSV file(s); they are downloaded here. Not exercised
        against the live service yet: the first market-hours capture verifies it.
        """
        await self.ensure_login()
        resp = await self._call("scrip_master", exchange_segment=exchange_segment)
        found = _scrip_master_urls(resp)
        urls = [u for u in found if exchange_segment in u.lower()] or found[:1]
        if not urls:
            raise BrokerError("scrip master returned no file location", code="bad_response")
        return await asyncio.to_thread(_download_csv_rows, urls[0])

    async def create_feed(self) -> FeedSession:
        await self.ensure_login()
        if self._auth.state is not AuthState.AUTHENTICATED:
            raise BrokerError(self._auth.last_error or "not signed in to the broker", code="auth")
        from app.stream.feed import KotakFeed

        try:
            ws = self._get_client().create_websocket()
        except ValueError as exc:  # SDK: no edit_token/edit_sid on the session
            raise BrokerError("broker session is not ready for streaming", code="auth") from exc
        return KotakFeed(ws)

    async def close(self) -> None:
        self._client = None


def _scrip_master_urls(resp: Any) -> list[str]:
    """File locations from the SDK answer (a string, a list, or a mapping holding either)."""
    if isinstance(resp, str):
        return [resp] if resp.startswith("http") else []
    if isinstance(resp, Mapping):
        out: list[str] = []
        for key in ("filesPaths", "files", "data", "url", "path"):
            if key in resp:
                out += _scrip_master_urls(resp[key])
        return out
    if isinstance(resp, list):
        out = []
        for item in resp:
            out += _scrip_master_urls(item)
        return out
    return []


def _download_csv_rows(url: str) -> list[dict[str, str]]:
    import csv
    import io
    import urllib.request

    with urllib.request.urlopen(url, timeout=60) as r:  # noqa: S310 - location from the broker SDK
        text = r.read().decode("utf-8-sig", errors="replace")
    return [dict(row) for row in csv.DictReader(io.StringIO(text))]
