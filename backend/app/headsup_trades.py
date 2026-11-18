"""Heads-up messages for the trades the app is managing.

Covers the Strategy builder's running strategy (stop, target, trailing stop, stop to cost, strategy rules, auto close) and the swing book (entry triggered and waiting for volume, entered,
the day-1 exits, the stop, the 1.8R and 2.5R levels).

Pure functions over what the server already stores; nothing is computed or guessed here. Each message has a stable ``key`` (so a page that closed it does not see it again) and only
today's events from the last ``KEEP_H`` hours are kept: the strip is for what just happened, the pages keep the history.
"""

from __future__ import annotations

import re
import zlib
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
KEEP_H = 6
MAX_ALERTS = 12

# (pattern in the lower-cased text, kind, level, title): the first match wins
_STRATEGY = [
    ("strategy stop loss", "strategy_stop", "bad", "Strategy stop loss hit"),
    ("strategy target", "strategy_target", "good", "Strategy target hit"),
    ("locked profit", "lock", "good", "Profit lock hit"),
    ("stop to cost skipped", "cost_skipped", "warn", "Stop to cost skipped"),
    ("stop moved to cost", "cost", "info", "Stop moved to cost"),
    ("trailing stop", "trail", "info", "Stop trailed"),
    ("auto close", "close", "info", "Auto close"),
    ("re-entry", "reentry", "info", "Re-entered"),
    ("re-entered", "reentry", "info", "Re-entered"),
    ("target:", "target", "good", "Target hit"),
    ("stop:", "stop", "bad", "Stop loss hit"),
]
_SWING_EXITS = {
    "STOP_CLOSE": ("stop", "bad", "Stop loss hit"),
    "D1_FAIL_CLOSE": ("day1_fail", "bad", "Day-1 exit: closed below the pivot"),
    "D1_REJECT_WICK": ("day1_wick", "bad", "Day-1 exit: rejection wick"),
}


def _clean(text: str) -> str:
    return re.sub(r"\s*\[server\]\s*$", "", text).strip()


def _recent(at: str | None, now: datetime) -> bool:
    if not at:
        return False
    try:
        t = datetime.fromisoformat(str(at).replace("Z", "+00:00"))
    except ValueError:
        return False
    if t.tzinfo is None:
        t = t.replace(tzinfo=UTC)
    same_day = t.astimezone(IST).date() == now.astimezone(IST).date()
    return same_day and timedelta(0) <= now - t <= timedelta(hours=KEEP_H)


def _round(v: Any) -> Any:
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return v


def strategy_alerts(doc: Mapping[str, Any] | None, now: datetime) -> list[dict[str, Any]]:
    """What the server did to the running strategy today (``serverEvents`` of its document), one message each."""
    out: list[dict[str, Any]] = []
    for e in (doc or {}).get("serverEvents") or []:
        at, text = e.get("at"), str(e.get("text") or "")
        if not _recent(at, now) or not text:
            continue
        low = text.lower()
        kind, level, title = next(((k, lv, ti) for pat, k, lv, ti in _STRATEGY if pat in low), ("event", "info", "Strategy update"))
        key = f"strategy:{at}:{zlib.crc32(text.encode('utf-8'))}"
        out.append({"key": key, "source": "strategy", "kind": kind, "level": level, "title": title, "text": _clean(text), "at": at, "link": "/strategy"})
    return out


def _alert(key: str, kind: str, level: str, title: str, text: str, at: Any) -> dict[str, Any]:
    return {"key": key, "source": "swing", "kind": kind, "level": level, "title": title, "text": text.strip(), "at": at, "link": "/swing"}


def swing_alerts(
    live_events: Sequence[Mapping[str, Any]],
    minute_events: Sequence[Mapping[str, Any]],
    positions: Sequence[Mapping[str, Any]],
    now: datetime,
    session: str,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for e in live_events:  # the price went through the entry trigger of a queued order
        if not _recent(e.get("at"), now):
            continue
        d, sym = e.get("detail") or {}, e.get("symbol")
        if e.get("kind") == "entry_trigger":
            text = f"Price {e.get('price')} is through the trigger {_round(d.get('trigger'))}. {d.get('note') or ''}"
            out.append(_alert(f"swing-live:{e.get('at')}:{sym}:trigger", "entry_trigger", "info", f"{sym}: entry triggered", text, e.get("at")))
        elif e.get("kind") == "entry_gap_skip":
            text = str(d.get("note") or "opened above the no-chase limit")
            out.append(_alert(f"swing-live:{e.get('at')}:{sym}:gap", "gap_skip", "warn", f"{sym}: entry skipped", text, e.get("at")))
    for e in minute_events:
        if not _recent(e.get("at"), now):
            continue
        d, sym, kind = e.get("detail") or {}, e.get("symbol"), e.get("kind")
        key, at, note = f"swing-min:{e.get('id')}", e.get("at"), str(d.get("note") or "")
        state = d.get("state")
        if kind == "entry_state" and state in ("volume_short", "volume_early"):  # price is through the trigger, volume is not there yet
            out.append(_alert(key, "waiting_volume", "warn", f"{sym}: triggered, waiting for volume", note, at))
        elif kind == "entry_state" and state == "signal":
            out.append(_alert(key, "signal", "info", f"{sym}: entry signal", f"{note} The entry is taken at the next candle's open.", at))
        elif kind == "entry_state" and state in ("above_cap", "gap_skip"):
            out.append(_alert(key, "not_chased", "warn", f"{sym}: not chased", note, at))
        elif kind == "entry_fill":
            text = f"{d.get('shares')} shares at {e.get('price')}, stop {_round(d.get('stop'))}"
            out.append(_alert(key, "entered", "good", f"{sym}: position entered", text, at))
        elif kind == "entry_cancelled":
            out.append(_alert(key, "cancelled", "warn", f"{sym}: entry cancelled", str(d.get("reason") or ""), at))
        elif kind == "exit":
            k, level, title = _SWING_EXITS.get(str(d.get("reason")), ("exit", "bad", "Exit"))
            text = f"Exit at {e.get('price')} ({d.get('basis') or 'next open'}). {'; '.join(d.get('notes') or [])}"
            out.append(_alert(key, k, level, f"{sym}: {title}", text, at))
        elif kind == "ratchet":
            out.append(_alert(key, "ratchet", "info", f"{sym}: stop raised", note, at))
    at_now = now.astimezone(UTC).isoformat(timespec="seconds")
    for p in positions:  # the official paper book's open positions, live
        sym = p.get("symbol")
        if p.get("state") == "stop_hit":
            text = f"Price {p.get('ltp')} is at or below the stop {_round(p.get('stop'))}. The paper book exits at the close."
            out.append(_alert(f"swing-pos:{session}:{sym}:stop", "stop", "bad", f"{sym}: stop in force reached", text, at_now))
        for flag, name, lvl in (("reached_2_5r", "2.5R", "level_2_5r"), ("reached_1_8r", "1.8R", "level_1_8r")):
            if p.get(flag):
                text = f"Price {p.get('ltp')} reached {name} ({_round(p.get(lvl))})."
                out.append(_alert(f"swing-pos:{session}:{sym}:{name}", "target", "good", f"{sym}: {name} level reached", text, at_now))
                break
    return out


def build(strategy: list[dict[str, Any]], swing: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Newest first, at most ``MAX_ALERTS``."""
    allr = sorted([*strategy, *swing], key=lambda a: str(a["at"]), reverse=True)
    return allr[:MAX_ALERTS]
