"""News headlines from public RSS feeds that their publishers distribute for this use: Economic Times (India and international), BBC and CNBC.

Only the headline, the short summary the feed itself carries, the link and the time are kept; the article text stays on the publisher's site and the page links
to it. Moneycontrol is not read: it answers an honest client with 403 and sends a server's address to a login page, and bot protection is not worked around.
"""

from __future__ import annotations

import hashlib
import html
import re
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET  # noqa: S405 - feeds of fixed, named publishers; no entity expansion is enabled in the standard parser
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any

USER_AGENT = "NSEUniverse/1.0 (personal research dashboard)"
SUMMARY_MAX = 260


@dataclass(frozen=True)
class Feed:
    source: str
    section: str
    region: str  # "India" or "Global"
    url: str


ET_BASE = "https://economictimes.indiatimes.com"
FEEDS: list[Feed] = [
    Feed("Economic Times", "Top stories", "India", f"{ET_BASE}/rssfeedstopstories.cms"),
    Feed("Economic Times", "Markets", "India", f"{ET_BASE}/markets/rssfeeds/1977021501.cms"),
    Feed("Economic Times", "Stocks", "India", f"{ET_BASE}/markets/stocks/rssfeeds/2146842.cms"),
    Feed("Economic Times", "Economy", "India", f"{ET_BASE}/news/economy/rssfeeds/1373380680.cms"),
    Feed("Economic Times", "Commodities", "India", f"{ET_BASE}/markets/commodities/rssfeeds/1808152121.cms"),
    Feed("Economic Times", "International", "Global", f"{ET_BASE}/news/international/rssfeeds/858478126.cms"),
    Feed("BBC News", "Business", "Global", "https://feeds.bbci.co.uk/news/business/rss.xml"),
    Feed("CNBC", "Finance", "Global", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664"),
    Feed("CNBC", "World", "Global", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100727362"),
]


def http_get(url: str, timeout: float = 20.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/xml,application/json,text/xml,*/*"})  # noqa: S310 - https URLs from the list above
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
        return bytes(r.read())


class NotModified(Exception):
    """The publisher answered 304: the feed is unchanged since the validators we sent."""


Validators = dict[str, str]


def http_get_cond(url: str, validators: Validators | None = None, timeout: float = 20.0) -> tuple[bytes | None, Validators]:
    """Like ``http_get`` but sends the feed's last ETag / Last-Modified so an unchanged feed costs one tiny response. Returns (None, validators) when unchanged."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/xml,application/json,text/xml,*/*"}
    if validators and validators.get("etag"):
        headers["If-None-Match"] = validators["etag"]
    if validators and validators.get("modified"):
        headers["If-Modified-Since"] = validators["modified"]
    req = urllib.request.Request(url, headers=headers)  # noqa: S310 - https URLs from the list above
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
            new: Validators = {}
            if r.headers.get("ETag"):
                new["etag"] = r.headers["ETag"]
            if r.headers.get("Last-Modified"):
                new["modified"] = r.headers["Last-Modified"]
            return bytes(r.read()), new
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return None, validators or {}
        raise


# What a headline is about, from words in its title and summary (shown as chips; "market-moving" means at least one of these).
TOPICS: list[tuple[str, re.Pattern[str]]] = [
    ("NIFTY", re.compile(r"\b(nifty|sensex|bank nifty|dalal street)\b", re.I)),
    ("RBI", re.compile(r"\b(rbi|reserve bank of india|repo rate|mpc)\b", re.I)),
    ("Fed", re.compile(r"\b(fed|federal reserve|fomc|powell|warsh)\b", re.I)),
    ("Crude", re.compile(r"\b(crude|brent|opec|oil prices?)\b", re.I)),
    ("Gold", re.compile(r"\b(gold|silver)\b", re.I)),
    ("Rupee", re.compile(r"\b(rupee|usd/inr|dollar index)\b", re.I)),
    ("Inflation", re.compile(r"\b(inflation|cpi|wpi|gdp)\b", re.I)),
    ("Earnings", re.compile(r"\b(q[1-4] (results|earnings)|quarterly results|earnings)\b", re.I)),
    ("FII", re.compile(r"\b(fii|fpi|dii|foreign (institutional|portfolio))\b", re.I)),
]


def topics(title: str, summary: str = "") -> list[str]:
    text = f"{title} {summary}"
    return [name for name, rx in TOPICS if rx.search(text)]


_TAG = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"\s+")


def clean(text: str | None) -> str:
    """Plain text of an RSS field: tags dropped, entities decoded, spaces collapsed."""
    return _SPACE.sub(" ", html.unescape(_TAG.sub(" ", text or ""))).strip()


def _short(text: str) -> str:
    return text if len(text) <= SUMMARY_MAX else text[: SUMMARY_MAX - 1].rsplit(" ", 1)[0] + "…"


MAX_FEED_BYTES = 4_000_000


def guard_xml(data: bytes) -> bytes:
    """Refuse a feed that could expand into something huge when parsed (the standard XML parser follows entity declarations: the "billion laughs" attack).

    A news feed has no use for a DOCTYPE or entity declarations, so any document that declares one, or that is far bigger than a feed is, is refused as malformed
    (the feed's error is shown and the headlines already stored stay).
    """
    if len(data) > MAX_FEED_BYTES:
        raise ValueError(f"feed is {len(data)} bytes: larger than {MAX_FEED_BYTES}, refused")
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise ValueError("feed declares a DOCTYPE or entities: refused")
    return data


def parse_rss(data: bytes, feed: Feed) -> tuple[list[dict[str, Any]], int]:
    """The items of one RSS document and how many were skipped (no title, link or usable date). Never raises on a malformed item."""
    root = ET.fromstring(guard_xml(data))  # noqa: S314 - refused above when it declares entities
    items: list[dict[str, Any]] = []
    skipped = 0
    for it in root.iter("item"):
        title = clean(it.findtext("title"))
        link = (it.findtext("link") or "").strip()
        raw_date = (it.findtext("pubDate") or "").strip()
        when: datetime | None = None
        try:
            when = parsedate_to_datetime(raw_date) if raw_date else None
        except (TypeError, ValueError):
            when = None
        if not title or not link.startswith("http") or when is None:
            skipped += 1
            continue
        if when.tzinfo is None:
            when = when.replace(tzinfo=UTC)
        summary = _short(clean(it.findtext("description")))
        if summary.lower().startswith(title.lower()[:40]) and len(summary) <= len(title) + 5:
            summary = ""  # a feed that repeats the headline as its summary
        items.append({
            "id": hashlib.sha1(link.encode(), usedforsecurity=False).hexdigest()[:20],  # noqa: S324 - an identifier, not security
            "source": feed.source, "region": feed.region, "section": feed.section, "title": title, "link": link, "summary": summary,
            "published": int(when.astimezone(UTC).timestamp() * 1000),
        })  # fmt: skip
    return items, skipped
