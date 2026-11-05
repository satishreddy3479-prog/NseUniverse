"""Network side of the swing scanner (standard library only): the Chartink list and Yahoo daily bars.

Read-only public data, no credentials. Everything is behind the ``Fetcher`` protocol so the service
and tests never need the network. Bars with any missing price or volume are dropped and counted, and
today's bar is dropped while the session may still be running (a partial bar is never a final one).
"""

from __future__ import annotations

import http.cookiejar
import json
import logging
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime
from typing import Any, Protocol
from zoneinfo import ZoneInfo

from app.logging_setup import log_event

IST = ZoneInfo("Asia/Kolkata")
logger = logging.getLogger(__name__)

SCREENER_URL = "https://chartink.com/screener"
PROCESS_URL = "https://chartink.com/screener/process"
YAHOO_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range={range}&interval=1d"
# Yahoo answers 429 to long browser strings and to curl's agent but accepts this one (checked 2026-11-05).
# If it ever changes the job fails safe: no data, no trades, and the page shows the book as stale.
UA = "Mozilla/5.0"

SCAN_CLAUSE = (
    "( {cash} ( market cap >= 300 and daily sma( daily volume * daily close , 50 ) >= 10000000 "
    "and yearly return on capital employed percentage >= 10 "
    "and yearly return on net worth percentage >= 10 "
    "and yearly debt equity ratio <= 1.5 "
    "and quarterly eps after extraordinary items basic > 0 "
    "and quarterly net profit/reported profit after tax > 0 and daily close > 75 ) )"
)

RawBar = tuple[str, float, float, float, float, float]  # date, open, high, low, close, volume


class FetchError(RuntimeError):
    pass


class Fetcher(Protocol):
    def universe(self) -> list[dict[str, Any]]: ...
    def daily(self, ticker: str) -> list[RawBar]: ...
    # optional: every equity's bar for one finished session from the exchange's own file (a second source for
    # days Yahoo sends without prices); a fetcher without it simply has no second source
    # def nse_day(self, session: str) -> dict[str, RawBar]: ...


def parse_universe(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = payload.get("data")
    if not isinstance(rows, list):
        raise FetchError("Chartink response has no data list")
    return [r for r in rows if isinstance(r, dict) and r.get("nsecode")]


def parse_chart(payload: dict[str, Any], now: datetime | None = None) -> list[RawBar]:
    """Yahoo chart JSON to complete daily bars, oldest first (dates are IST calendar dates)."""
    result = ((payload.get("chart") or {}).get("result") or [None])[0]
    if not result or not result.get("timestamp"):
        raise FetchError("no price data in the chart response")
    q = result["indicators"]["quote"][0]
    now = (now or datetime.now(IST)).astimezone(IST)
    bars: list[RawBar] = []
    for k, ts in enumerate(result["timestamp"]):
        vals = [q[f][k] for f in ("open", "high", "low", "close", "volume")]
        if any(v is None for v in vals) or min(vals[:4]) <= 0:
            continue
        d = datetime.fromtimestamp(ts, IST).date()
        bars.append((d.isoformat(), *(float(v) for v in vals)))  # type: ignore[arg-type]
    bars.sort(key=lambda b: b[0])
    if bars and date.fromisoformat(bars[-1][0]) == now.date() and (now.hour, now.minute) < (16, 0):
        bars.pop()
    return bars


class HttpFetcher:
    def __init__(self, range_: str = "3y", pause_s: float = 0.15, retries: int = 3, timeout_s: float = 30.0) -> None:
        self.range, self.pause_s, self.retries, self.timeout_s = range_, pause_s, retries, timeout_s

    def _get(self, opener: urllib.request.OpenerDirector, req: urllib.request.Request) -> bytes:
        last: Exception | None = None
        if not req.full_url.startswith("https://"):  # only fixed https endpoints are ever requested
            raise FetchError("refusing a non-https URL")
        for attempt in range(self.retries):
            try:
                with opener.open(req, timeout=self.timeout_s) as r:  # noqa: S310 - https checked above
                    return r.read()  # type: ignore[no-any-return]
            except urllib.error.HTTPError as e:
                last = e
                if e.code not in (429, 500, 502, 503, 504):
                    break
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                last = e
            time.sleep(1.5 * (attempt + 1))
        raise FetchError(f"{req.full_url.split('?')[0]}: {type(last).__name__}")

    def universe(self) -> list[dict[str, Any]]:
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        page = self._get(opener, urllib.request.Request(SCREENER_URL, headers={"User-Agent": UA})).decode("utf-8", "replace")
        m = re.search(r'name="csrf-token"\s+content="([^"]+)"', page) or re.search(r'content="([^"]+)"\s+name="csrf-token"', page)
        if not m:
            raise FetchError("Chartink CSRF token not found")
        body = urllib.parse.urlencode({"scan_clause": SCAN_CLAUSE}).encode()
        req = urllib.request.Request(PROCESS_URL, data=body, headers={
            "User-Agent": UA, "X-CSRF-TOKEN": m.group(1), "Referer": SCREENER_URL,
            "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded"})
        try:
            return parse_universe(json.loads(self._get(opener, req)))
        except ValueError as e:
            raise FetchError("Chartink returned something that is not JSON") from e

    def nse_day(self, session: str) -> dict[str, RawBar]:
        """All equities' bars of one session from NSE's full bhavcopy (same unadjusted day values as Yahoo's;
        checked 2026-11-05 on ANANDRATHI and KRISHANA). Empty when the file is not published yet."""
        from app.market.sources import BHAV_URL, SourceError, fetch_text, parse_bhavcopy

        d = date.fromisoformat(session)
        res, text = fetch_text(BHAV_URL.format(d=d))
        if text is None:
            log_event(logger, logging.WARNING, "swing_nse_day_unavailable", session=session, error=str(res.error or res.status))
            return {}
        try:
            rows = parse_bhavcopy(text)
        except SourceError:
            return {}
        out: dict[str, RawBar] = {}
        for r in rows:
            if r.session != d or r.open is None or r.high is None or r.low is None or r.close is None or r.volume is None:
                continue
            if min(r.open, r.high, r.low, r.close) <= 0:
                continue
            out[r.symbol] = (session, r.open, r.high, r.low, r.close, float(r.volume))
        return out

    def daily(self, ticker: str) -> list[RawBar]:
        url = YAHOO_URL.format(symbol=urllib.parse.quote(ticker, safe=""), range=self.range)
        opener = urllib.request.build_opener()
        time.sleep(self.pause_s)  # gentle on a public endpoint and on a 1 vCPU box
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})  # noqa: S310 - fixed https endpoint
            return parse_chart(json.loads(self._get(opener, req)))
        except (ValueError, KeyError, IndexError, TypeError) as e:
            log_event(logger, logging.WARNING, "swing_chart_unreadable", ticker=ticker, error=type(e).__name__)
            raise FetchError(f"{ticker}: unreadable chart response") from e
