"""NSE public files: F&O participant-wise open interest / volume and FII/DII cash activity.

Small, polite, personal-research use: one request at a time, a pause between requests, an honest
User-Agent, and a hard stop (not a retry storm) if NSE answers 403/429. Raw bytes are kept by the
store so every parsed number can be re-checked against the file it came from. Nothing is guessed:
a file whose own "as on" date differs from the requested date is rejected.
"""

from __future__ import annotations

import csv
import io
import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime
from html.parser import HTMLParser
from typing import Any

USER_AGENT = "NSEUniverse-personal-research/1.0 (single user, low rate)"
ARCHIVE = "https://archives.nseindia.com/content/nsccl"
KINDS = {
    "fao_participant_oi": ("fao_participant_oi_{d}.csv", "Open Interest"),
    "fao_participant_vol": ("fao_participant_vol_{d}.csv", "Trading Volume"),  # NSE writes the singular
}
FII_DII_PAGE = "https://www.nseindia.com/"
FII_DII_API = "https://www.nseindia.com/api/fiidiiTradeReact"
PARTICIPANTS = ("Client", "DII", "FII", "Pro")


class NseParseError(ValueError):
    pass


@dataclass(frozen=True)
class Fetched:
    status: int  # HTTP status; 0 = network error
    body: bytes | None
    error: str | None = None


def file_url(kind: str, session: date) -> str:
    return f"{ARCHIVE}/{KINDS[kind][0].format(d=session.strftime('%d%m%Y'))}"


def fetch(url: str, *, timeout: float = 20.0, headers: dict[str, str] | None = None, opener: Any = None) -> Fetched:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*", **(headers or {})})  # noqa: S310
    try:
        with (opener.open(req, timeout=timeout) if opener else urllib.request.urlopen(req, timeout=timeout)) as r:  # noqa: S310
            return Fetched(r.status, r.read())
    except urllib.error.HTTPError as e:
        return Fetched(e.code, None, f"HTTP {e.code}")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return Fetched(0, None, f"{type(e).__name__}: {e}")


_AS_ON = re.compile(r"as on\s+([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})", re.I)


def _num(s: str) -> int:
    t = s.strip().replace(",", "")
    if not re.fullmatch(r"-?\d+(\.0+)?", t):
        raise NseParseError(f"not a whole number: {s!r}")
    return int(float(t))


def parse_participant(body: bytes, kind: str, session: date) -> dict[str, dict[str, int]]:
    """{participant: {column: value}} for Client, DII, FII, Pro (TOTAL is kept for cross-checking)."""
    text = body.decode("utf-8-sig", errors="replace")
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if len(lines) < 6:
        raise NseParseError("file too short")
    m = _AS_ON.search(lines[0])
    if not m:
        raise NseParseError("no 'as on <date>' in the title line")
    stated = datetime.strptime(f"{m.group(1)[:3].title()} {m.group(2)} {m.group(3)}", "%b %d %Y").date()
    if stated != session:
        raise NseParseError(f"file says {stated}, requested {session}")
    if KINDS[kind][1].lower() not in lines[0].lower():
        raise NseParseError(f"title does not look like {kind}: {lines[0][:80]!r}")
    rows = list(csv.reader(io.StringIO("\n".join(lines[1:]))))
    head = [c.strip() for c in rows[0]]
    if not head or head[0].lower() != "client type":
        raise NseParseError("header row not found")
    cols = [c for c in head[1:] if c]
    out: dict[str, dict[str, int]] = {}
    for r in rows[1:]:
        if not r or not r[0].strip():
            continue
        name = r[0].strip()
        key = "TOTAL" if name.upper() == "TOTAL" else name
        vals = [c for c in r[1:] if c.strip() != ""]
        if len(vals) != len(cols):
            raise NseParseError(f"{name}: {len(vals)} values for {len(cols)} columns")
        out[key] = {c: _num(v) for c, v in zip(cols, vals, strict=True)}
    if set(PARTICIPANTS) - set(out):
        raise NseParseError(f"missing participants: {sorted(set(PARTICIPANTS) - set(out))}")
    if "TOTAL" in out:  # integrity: the four groups must add up to the file's own total row
        for c in cols:
            # NSE's own TOTAL row is off by a contract or two on some days (seen in real files)
            tol = max(5, out["TOTAL"][c] // 100_000)
            if abs(sum(out[p][c] for p in PARTICIPANTS) - out["TOTAL"][c]) > tol:
                parts = {p: out[p][c] for p in PARTICIPANTS}
                raise NseParseError(f"column {c!r}: participants do not add up to TOTAL ({parts} vs {out['TOTAL'][c]})")
    return out


def parse_fii_dii(body: bytes) -> list[dict[str, Any]]:
    """Latest-day provisional cash activity: [{category, session, buy, sell, net}] in Rs crore."""
    try:
        rows = json.loads(body)
    except ValueError as e:
        raise NseParseError(f"not JSON: {e}") from e
    if not isinstance(rows, list) or not rows:
        raise NseParseError("empty or unexpected FII/DII response")
    out = []
    for r in rows:
        try:
            d = datetime.strptime(str(r["date"]), "%d-%b-%Y").date()
            buy, sell, net = (float(str(r[k]).replace(",", "")) for k in ("buyValue", "sellValue", "netValue"))
        except (KeyError, ValueError) as e:
            raise NseParseError(f"unexpected FII/DII row: {r!r}") from e
        if abs((buy - sell) - net) > 0.05 * max(1.0, abs(net)) + 1:
            raise NseParseError(f"{r.get('category')}: buy - sell does not equal net")
        out.append({"category": str(r["category"]).strip(), "session": d, "buy": buy, "sell": sell, "net": net})
    return out


_DATE_FORMATS = ("%d-%b-%Y", "%d-%m-%Y", "%d/%m/%Y", "%Y-%m-%d", "%d-%B-%Y")


def _parse_date(text: str) -> date:
    t = text.strip()
    for f in _DATE_FORMATS:
        try:
            return datetime.strptime(t, f).date()
        except ValueError:
            continue
    raise NseParseError(f"unreadable date {text!r}")


def _crore(text: str) -> float:
    t = text.strip().replace(",", "").replace("\u20b9", "").replace("Rs.", "").strip()
    try:
        return float(t)
    except ValueError as e:
        raise NseParseError(f"not a number: {text!r}") from e


def parse_cash_csv(text: str) -> list[dict[str, Any]]:
    """FII/DII cash-market activity from a CSV downloaded from NSE's FII/DII report (Rs crore).

    Needs columns for category, date, buy, sell and net (names matched loosely). Each row must satisfy
    buy - sell = net, otherwise the whole file is rejected; nothing is guessed or repaired.
    """
    rows = list(csv.reader(io.StringIO(text.lstrip("\ufeff"))))
    rows = [r for r in rows if any(c.strip() for c in r)]
    if len(rows) < 2:
        raise NseParseError("file too short")
    head = [c.strip().lower() for c in rows[0]]

    def col(*names: str) -> int:
        for i, h in enumerate(head):
            if any(n in h for n in names):
                return i
        raise NseParseError(f"no column like {names[0]!r} in header {rows[0]!r}")

    ic, idt, ib, isl, inet = col("category", "client"), col("date"), col("buy", "purchase"), col("sell", "sale"), col("net")
    out = []
    for r in rows[1:]:
        if len(r) <= max(ic, idt, ib, isl, inet):
            raise NseParseError(f"short row {r!r}")
        buy, sell, net = _crore(r[ib]), _crore(r[isl]), _crore(r[inet])
        if abs((buy - sell) - net) > 0.05 * max(1.0, abs(net)) + 1:
            raise NseParseError(f"{r[ic]} {r[idt]}: buy - sell does not equal net")
        out.append({"category": r[ic].strip().rstrip("*").strip(), "session": _parse_date(r[idt]), "buy": buy, "sell": sell, "net": net})
    return out


NSDL_URL = "https://www.fpi.nsdl.co.in/web/Reports/Latest.aspx"


class _Tables(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.tables: list[list[list[str]]] = []
        self._row: list[str] | None = None
        self._cell: list[str] | None = None
        self._depth = 0

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag == "table":
            self._depth += 1
            if self._depth == 1:
                self.tables.append([])
        elif tag == "tr" and self._depth >= 1:
            self._row = []
        elif tag in {"td", "th"} and self._row is not None:
            self._cell = []

    def handle_endtag(self, tag: str) -> None:
        if tag in {"td", "th"} and self._cell is not None and self._row is not None:
            self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._row and self.tables:
                self.tables[-1].append(self._row)
            self._row = None
        elif tag == "table":
            self._depth = max(0, self._depth - 1)

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)


def _paren(text: str) -> float:
    t = text.strip().replace(",", "")
    neg = t.startswith("(") and t.endswith(")")
    try:
        v = float(t.strip("()"))
    except ValueError as e:
        raise NseParseError(f"not a number: {text!r}") from e
    return -v if neg else v


def parse_nsdl_fpi(body: bytes) -> list[dict[str, Any]]:
    """Daily FPI equity activity from NSDL (Rs crore): the stock-exchange route and the equity sub-total.

    The first data row carries the reporting date; the equity sub-total follows the equity rows. Every
    row must satisfy purchases - sales = net, otherwise the page is rejected.
    """
    parser = _Tables()
    parser.feed(body.decode("utf-8", errors="replace"))
    rows = next((t for t in parser.tables if any("Reporting Date" in c for r in t for c in r)), None)
    if rows is None:
        raise NseParseError("FPI investment table not found")
    first = next((r for r in rows if r and re.fullmatch(r"\d{1,2}-[A-Za-z]{3}-\d{4}", r[0])), None)
    if first is None or len(first) < 6 or first[1].lower() != "equity":
        raise NseParseError("equity row not found")
    session = _parse_date(first[0])
    i = rows.index(first)
    exch: dict[str, Any] = {"category": "FPI equity (stock exchange)", "buy": _paren(first[3]), "sell": _paren(first[4]), "net": _paren(first[5])}
    sub = next((r for r in rows[i + 1 : i + 4] if r and r[0].lower().startswith("sub-total")), None)
    if sub is None or len(sub) < 4:
        raise NseParseError("equity sub-total not found")
    total: dict[str, Any] = {"category": "FPI equity (incl. primary market)", "buy": _paren(sub[1]), "sell": _paren(sub[2]), "net": _paren(sub[3])}
    out: list[dict[str, Any]] = []
    for r in (exch, total):
        buy, sell, net = float(r["buy"]), float(r["sell"]), float(r["net"])
        if abs((buy - sell) - net) > 0.05 * max(1.0, abs(net)) + 1:
            raise NseParseError(f"{r['category']}: purchases - sales does not equal net")
        out.append({**r, "session": session})
    return out
