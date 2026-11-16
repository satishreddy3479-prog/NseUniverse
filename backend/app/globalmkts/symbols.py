"""The instruments of the global markets board, and when each one is expected to trade.

Futures symbols are continuous front-month contracts from Yahoo; cash indices trade in their exchange's regular hours. Expected hours are rules (weekday and
time of day in the exchange's time zone); exchange holidays are not known here, so the board decides "live" from how fresh the last bar is and uses the rules
only to tell "closed" from "should be trading but is not updating".
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta
from urllib.parse import quote
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")


@dataclass(frozen=True)
class GSymbol:
    key: str  # our stable name
    yahoo: str  # Yahoo ticker
    name: str
    group: str
    kind: str  # "futures" (CME-style 23-hour session) or "cash" (regular hours)
    tz: str  # exchange time zone
    unit: str = ""  # shown after the value ("$", "%", "")
    decimals: int = 2
    core: bool = False  # polled every minute in the NSE window
    yield_pct: bool = False  # a yield in percent: the change is also shown in basis points
    hours: tuple[time, time] | None = None  # cash: regular open and close in tz
    breaks: tuple[tuple[time, time], ...] = ()  # cash: lunch breaks
    delay_min: int = 0  # how far behind real time Yahoo's feed of this symbol normally is (measured: CME and ICE futures about 10 minutes, Asian indices 14-19)
    source: str = "yahoo"  # "yahoo" (one-minute bars) or "nseix" (the NSE IX website feed: GIFT Nifty)
    view_url: str = ""  # the full chart page at the original source; Yahoo's chart page of the ticker when empty
    ref_close: time | None = None  # futures: the change is measured from the last bar before this local time of the previous session (the 16:00 US cash close)


GROUPS: list[tuple[str, str]] = [
    ("india", "India pre-market"),
    ("us_futures", "US index futures"),
    ("us_cash", "US cash indices"),
    ("rates_fx", "Rates and the dollar"),
    ("commodities", "Gold, silver and oil"),
    ("asia", "Asian markets"),
]

_US = (time(9, 30), time(16, 0))
SYMBOLS: list[GSymbol] = [
    GSymbol("GIFT", "", "GIFT Nifty futures", "india", "gift", "Asia/Kolkata", core=True, source="nseix", view_url="https://www.nseix.com/get-quotes"),
    GSymbol("ES", "ES=F", "S&P 500 futures", "us_futures", "futures", "America/New_York", core=True, ref_close=time(16, 0), delay_min=10),
    GSymbol("NQ", "NQ=F", "Nasdaq 100 futures", "us_futures", "futures", "America/New_York", core=True, ref_close=time(16, 0), delay_min=10),
    GSymbol("YM", "YM=F", "Dow futures", "us_futures", "futures", "America/New_York", core=True, ref_close=time(16, 0), delay_min=10),
    GSymbol("RTY", "RTY=F", "Russell 2000 futures", "us_futures", "futures", "America/New_York", ref_close=time(16, 0), delay_min=10),
    GSymbol("SPX", "^GSPC", "S&P 500", "us_cash", "cash", "America/New_York", hours=_US),
    GSymbol("COMP", "^IXIC", "Nasdaq Composite", "us_cash", "cash", "America/New_York", hours=_US),
    GSymbol("DJI", "^DJI", "Dow Jones", "us_cash", "cash", "America/New_York", hours=_US),
    GSymbol("VIX", "^VIX", "US VIX", "us_cash", "cash", "America/New_York", hours=(time(9, 30), time(16, 15))),
    GSymbol("ZN", "ZN=F", "US 10-year note futures", "rates_fx", "futures", "America/New_York", decimals=3, core=True, delay_min=10),
    GSymbol("US10Y", "^TNX", "US 10-year yield", "rates_fx", "cash", "America/New_York", unit="%", decimals=3, yield_pct=True, hours=(time(8, 0), time(17, 0))),
    GSymbol("DXY", "DX-Y.NYB", "US dollar index", "rates_fx", "futures", "America/New_York", decimals=3, delay_min=10),
    GSymbol("USDINR", "INR=X", "USD/INR", "rates_fx", "futures", "America/New_York", decimals=3),
    GSymbol("GOLD", "GC=F", "Gold futures", "commodities", "futures", "America/New_York", unit="$", core=True, delay_min=10),
    GSymbol("SILVER", "SI=F", "Silver futures", "commodities", "futures", "America/New_York", unit="$", decimals=3, delay_min=10),
    GSymbol("BRENT", "BZ=F", "Brent crude futures", "commodities", "futures", "America/New_York", unit="$", core=True, delay_min=10),
    GSymbol("N225", "^N225", "Nikkei 225", "asia", "cash", "Asia/Tokyo", hours=(time(9, 0), time(15, 30)), breaks=((time(11, 30), time(12, 30)),), delay_min=15),
    GSymbol("HSI", "^HSI", "Hang Seng", "asia", "cash", "Asia/Hong_Kong", hours=(time(9, 30), time(16, 0)), breaks=((time(12, 0), time(13, 0)),), delay_min=15),
    GSymbol("KOSPI", "^KS11", "KOSPI", "asia", "cash", "Asia/Seoul", hours=(time(9, 0), time(15, 30)), delay_min=20),
    GSymbol("SSEC", "000001.SS", "Shanghai Composite", "asia", "cash", "Asia/Shanghai", hours=(time(9, 30), time(15, 0)), breaks=((time(11, 30), time(13, 0)),), delay_min=15),
]
BY_KEY = {s.key: s for s in SYMBOLS}
BY_YAHOO = {s.yahoo: s for s in SYMBOLS if s.yahoo}


def chart_url(spec: GSymbol) -> str:
    """The symbol's page at its original source (Yahoo's quote page with its chart; its separate full-screen chart page is heavy and often fails to load on a phone)."""
    return spec.view_url or f"https://finance.yahoo.com/quote/{quote(spec.yahoo, safe='')}/"


def session_key(spec: GSymbol, ts: datetime) -> str:
    """The trading session a bar belongs to (a date). A futures session runs from 18:00 New York time the evening before to 17:00, so 6 hours are added;
    a cash session is the exchange's calendar day."""
    local = ts.astimezone(ZoneInfo(spec.tz))
    d = (local + timedelta(hours=6)).date() if spec.kind == "futures" else (local - timedelta(hours=3)).date() if spec.kind == "gift" else local.date()
    return d.isoformat()


def expected_open(spec: GSymbol, now: datetime) -> bool:
    """Whether the market should be trading now by the usual hours (exchange holidays are not known here)."""
    t = now.astimezone(ZoneInfo(spec.tz))
    wd, hm = t.weekday(), t.time()
    if spec.kind == "gift":  # NSE IX: 06:30-15:40 and 16:35-02:45 the next morning, on the days the exchange trades (Monday to Friday; its holidays are not known here)
        if hm < time(2, 45):
            return (wd - 1) % 7 < 5
        return wd < 5 and (time(6, 30) <= hm < time(15, 40) or hm >= time(16, 35))
    if spec.kind == "futures":
        if wd == 5:  # Saturday
            return False
        if wd == 4 and hm >= time(17, 0):  # Friday after the close
            return False
        if wd == 6 and hm < time(18, 0):  # Sunday before the reopen
            return False
        return not (time(17, 0) <= hm < time(18, 0))  # the daily break
    if wd >= 5 or spec.hours is None:
        return False
    o, c = spec.hours
    if not (o <= hm < c):
        return False
    return not any(a <= hm < b for a, b in spec.breaks)
