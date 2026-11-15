"""GIFT Nifty from the NSE IX website's own data feed (the endpoint its public "derivatives watch" page loads).

The Kotak Neo API has no NSE IX segment (its segments are nse_cm, bse_cm, nse_fo, bse_fo, cde_fo and mcx_fo), and Yahoo has no GIFT Nifty ticker, so the quote comes from
the exchange's site. It is an unofficial use of that feed: read once a minute with an identified client, labelled as such. The quote is the near-month NIFTY index future;
its change is computed here against the exchange's previous close for that contract (the feed's own change column is not copied).
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from app.globalmkts.quotes import LIVE_MAX_AGE_S, Bar, Quote
from app.globalmkts.symbols import GSymbol, expected_open, session_key

IST = ZoneInfo("Asia/Kolkata")
DW_URL = "https://www.nseix.com/api/derivatives-watch?inst_type1=IDX&inst_type2=STK&type=live"
SOURCE_LABEL = "NSE IX website feed (unofficial endpoint)"


def _f(v: object) -> float | None:
    try:
        x = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return x if x > 0 else None


def gift_quote(data: bytes, now: datetime, spec: GSymbol) -> tuple[Quote, str] | None:
    """The near-month NIFTY index future as a quote, and its expiry label; None when the feed has no traded NIFTY future (missing stays missing)."""
    doc = json.loads(data)
    today: date = now.astimezone(IST).date()
    best: tuple[date, dict[str, object]] | None = None
    for r in doc.get("data", []) if isinstance(doc, dict) else []:
        if not isinstance(r, dict) or r.get("INSTRUMENTTYPE") != "FUTIDX" or str(r.get("SYMBOL", "")).upper() != "NIFTY" or _f(r.get("LASTPRICE")) is None:
            continue
        try:
            exp = datetime.strptime(str(r["EXPIRYDATE"]), "%d-%b-%Y").date()
            datetime.strptime(str(r["TIMESTMP"]), "%d-%b-%Y %H:%M:%S")
        except (KeyError, ValueError):
            continue
        if exp >= today and (best is None or exp < best[0]):
            best = (exp, r)
    if best is None:
        return None
    exp, r = best
    traded = datetime.strptime(str(r["TIMESTMP"]), "%d-%b-%Y %H:%M:%S").replace(tzinfo=IST).astimezone(UTC)
    price = float(r["LASTPRICE"])  # type: ignore[arg-type]
    ref = _f(r.get("CLOSE"))
    bar_ts = traded.replace(second=0, microsecond=0)
    age = max(0.0, (now - traded).total_seconds())
    status = "live" if age <= LIVE_MAX_AGE_S else ("stale" if expected_open(spec, now) else "closed")
    change = None if ref is None else price - ref
    pct = None if ref is None or change is None else change / ref * 100
    q = Quote(spec.key, price, bar_ts, traded, age, status, session_key(spec, traded), ref, None, change, pct, (Bar(bar_ts, price),))
    return q, exp.strftime("%d %b %Y")
