"""Builds the streaming subscription universe from the latest usable snapshots."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.broker.base import BrokerError
from app.domain.models import OptionChainSnapshot, OptionQuote
from app.domain.session import session_close
from app.services.snapshot_service import SnapshotService
from app.stream.manager import Universe
from app.stream.models import FeedToken

INDEX_NAMES = {"NIFTY": "Nifty 50"}
IST = ZoneInfo("Asia/Kolkata")


def _token(q: OptionQuote | None) -> FeedToken | None:
    if q is None or not q.exchange_segment or not q.instrument_token:
        return None
    return FeedToken(exchange_segment=q.exchange_segment, instrument_token=q.instrument_token)


def _atm_row_tokens(snap: OptionChainSnapshot) -> list[FeedToken]:
    rows = snap.rows
    if not rows:
        return []
    row = None
    if snap.spot_note is None:  # a frozen broker quote makes its ATM label wrong
        atm = {"ATM"}
        row = next(
            (r for r in rows if atm & {r.call and r.call.moneyness, r.put and r.put.moneyness}),
            None,
        )
    if row is None and snap.underlying_ltp is not None:
        row = min(rows, key=lambda r: abs(r.strike - snap.underlying_ltp))  # type: ignore[operator]
    if row is None:
        row = rows[len(rows) // 2]
    return [t for t in (_token(row.call), _token(row.put)) if t is not None]


def tokens_from_snapshots(snaps: list[OptionChainSnapshot], underlying: str) -> Universe:
    seen: dict[str, FeedToken] = {}
    index = INDEX_NAMES.get(underlying)
    idx_tok = (
        FeedToken(
            exchange_segment="nse_cm",
            instrument_token=index,
            kind="index",
        )
        if index
        else None
    )
    if idx_tok:
        seen[idx_tok.key] = idx_tok
    for snap in snaps:
        for r in snap.rows:
            for t in (_token(r.call), _token(r.put)):
                if t is not None:
                    seen.setdefault(t.key, t)
    test = ([idx_tok] if idx_tok else []) + (_atm_row_tokens(snaps[0]) if snaps else [])
    return Universe(
        tokens=list(seen.values()), test_tokens=test, expiries=[s.expiry.isoformat() for s in snaps]
    )


def market_hours(now: datetime) -> bool:
    """Weekday 09:00 to five minutes after the session close IST (15:45; 15:50 from 7 Dec 2026).

    When a fresh option chain is worth fetching before streaming.

    Outside it the exchange is closed, so the latest stored chain is as good as a new one.
    """
    t_ = now.astimezone(IST)
    limit = (datetime.combine(t_.date(), session_close()) + timedelta(minutes=5)).time()
    return t_.weekday() < 5 and time(9, 0) <= t_.time() < limit


def stored_targets(svc: SnapshotService, today: date) -> list[date]:
    """Expiries to stream when the broker cannot be asked.

    The newest usable stored chain of each kind (weekly, monthly) that has not expired yet.
    """
    picked: dict[str, date] = {}
    for item in svc.store.list(underlying=svc.underlying, limit=200):  # newest first
        if item.completeness.value == "empty" or item.expiry < today:
            continue
        for kind in item.expiry_kinds or []:
            picked.setdefault(str(kind), item.expiry)
    return sorted(set(picked.values()))


async def build_universe(
    svc: SnapshotService,
    market_tokens: Callable[[], list[FeedToken]] | None = None,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> Universe:
    closed = not market_hours(now())
    targets: list[date] = []
    try:
        sel = await svc.expiries()
        for d in (sel.weekly, sel.monthly):
            if d is not None and d not in targets:
                targets.append(d)
    except BrokerError:
        if not closed:
            raise
        # Exchange closed and the broker will not answer (typical right after a restart at night):
        # carry on from what is stored instead of failing every retry.
        targets = stored_targets(svc, now().astimezone(IST).date())
        if not targets:
            raise
    if not targets:
        raise BrokerError("no verified expiry available to stream", code="no_expiry")
    snaps: list[OptionChainSnapshot] = []
    for exp in targets:
        # the stored chain is a compressed file read and parsed: in a thread, so a feed reconnect
        # does not hold the event loop (this runs at every reconnect, when live prices wait)
        snap = await asyncio.to_thread(
            svc.store.latest, svc.underlying, exp.isoformat(), prefer_non_empty=True
        )
        too_old = (
            not closed
            and snap is not None
            and (datetime.now(UTC) - snap.retrieved_at).total_seconds() > svc.max_age_s
        )
        if snap is None or snap.completeness.value == "empty" or too_old:
            # The snapshot is the base the stream updates, so make sure the base is current.
            await svc.capture(expiry=exp)
            snap = await asyncio.to_thread(
                svc.store.latest, svc.underlying, exp.isoformat(), prefer_non_empty=True
            )
        if snap is None or snap.completeness.value == "empty":
            raise BrokerError(f"no usable option chain for {exp}", code="no_snapshot")
        snaps.append(snap)
    uni = await asyncio.to_thread(tokens_from_snapshots, snaps, svc.underlying)
    if market_tokens is not None:
        try:
            have = {x.key for x in uni.tokens}
            extra = await asyncio.to_thread(market_tokens)
            uni.market_tokens = [t for t in extra if t.key not in have]
        except Exception:  # noqa: BLE001 - the breadth inputs must never block the option stream
            uni.market_tokens = []
    return uni
