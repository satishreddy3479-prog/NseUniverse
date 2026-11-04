"""Chartink universe extraction (spec chapter 3).

Fetches the screener page, reads the CSRF token, posts the scan clause to
/screener/process and stores the result with provenance (fetch time, clause).
The result is *today's* list: Chartink offers no point-in-time fundamentals.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path

import httpx

SCREENER_URL = "https://chartink.com/screener"
PROCESS_URL = "https://chartink.com/screener/process"

SCAN_CLAUSE = (
    "( {cash} ( market cap >= 300 and daily sma( daily volume * daily close , 50 ) >= 10000000 "
    "and yearly return on capital employed percentage >= 10 "
    "and yearly return on net worth percentage >= 10 "
    "and yearly debt equity ratio <= 1.5 "
    "and quarterly eps after extraordinary items basic > 0 "
    "and quarterly net profit/reported profit after tax > 0 and daily close > 75 ) )"
)

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"


def fetch_universe(clause: str = SCAN_CLAUSE) -> list[dict]:
    with httpx.Client(headers={"User-Agent": _UA}, timeout=60, follow_redirects=True) as client:
        page = client.get(SCREENER_URL)
        page.raise_for_status()
        match = re.search(r'name="csrf-token"\s+content="([^"]+)"', page.text) or re.search(
            r'content="([^"]+)"\s+name="csrf-token"', page.text
        )
        if not match:
            raise RuntimeError("Chartink CSRF token not found on the screener page")
        resp = client.post(
            PROCESS_URL,
            data={"scan_clause": clause},
            headers={"X-CSRF-TOKEN": match.group(1), "Referer": SCREENER_URL},
        )
        resp.raise_for_status()
        rows = resp.json().get("data", [])
    return rows


def save_universe(rows: list[dict], path: Path, clause: str = SCAN_CLAUSE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "source": "chartink.com/screener/process",
        "fetched_at_utc": datetime.now(UTC).isoformat(),
        "scan_clause": clause,
        "count": len(rows),
        "rows": rows,
    }
    path.write_text(json.dumps(payload, indent=1), encoding="utf-8")


def load_universe(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))
