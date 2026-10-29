"""Builds the streaming subscription universe from the latest usable snapshots."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, date, datetime

from app.broker.base import BrokerError
from app.domain.models import OptionChainSnapshot, OptionQuote
from app.services.snapshot_service import SnapshotService
from app.stream.manager import Universe
from app.stream.models import FeedToken

INDEX_NAMES = {"NIFTY": "Nifty 50"}


def _token(q: OptionQuote | None) -> FeedToken | None:
    if q is None or not q.exchange_segment or not q.instrument_token:
        return None
    return FeedToken(exchange_segment=q.exchange_segment, instrument_token=q.instrument_token)


def _atm_row_tokens(snap: OptionChainSnapshot) -> list[FeedToken]:
    rows = snap.rows
    if not rows:
        return []
    row = next(
        (
            r
            for r in rows
            if "ATM" in {r.call.moneyness if r.call else None, r.put.moneyness if r.put else None}
        ),
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


async def build_universe(
    svc: SnapshotService, market_tokens: Callable[[], list[FeedToken]] | None = None
) -> Universe:
    sel = await svc.expiries()
    targets: list[date] = []
    for d in (sel.weekly, sel.monthly):
        if d is not None and d not in targets:
            targets.append(d)
    if not targets:
        raise BrokerError("no verified expiry available to stream", code="no_expiry")
    snaps: list[OptionChainSnapshot] = []
    for exp in targets:
        snap = svc.store.latest(svc.underlying, exp.isoformat(), prefer_non_empty=True)
        too_old = snap is not None and (
            (datetime.now(UTC) - snap.retrieved_at).total_seconds() > svc.max_age_s
        )
        if snap is None or snap.completeness.value == "empty" or too_old:
            # The snapshot is the base the stream updates, so make sure the base is current.
            await svc.capture(expiry=exp)
            snap = svc.store.latest(svc.underlying, exp.isoformat(), prefer_non_empty=True)
        if snap is None or snap.completeness.value == "empty":
            raise BrokerError(f"no usable option chain for {exp}", code="no_snapshot")
        snaps.append(snap)
    uni = tokens_from_snapshots(snaps, svc.underlying)
    if market_tokens is not None:
        try:
            have = {x.key for x in uni.tokens}
            uni.market_tokens = [t for t in market_tokens() if t.key not in have]
        except Exception:  # noqa: BLE001 - the breadth inputs must never block the option stream
            uni.market_tokens = []
    return uni
