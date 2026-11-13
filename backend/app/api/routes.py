"""REST API (documented automatically at /docs)."""

from __future__ import annotations

import asyncio
import json
import os
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from app.analytics.oi import (
    BaselineKind,
    Heatmap,
    OiChange,
    OiSeries,
    PremiumDecay,
    Side,
    StrikeSeries,
    oi_change,
    oi_heatmap,
    oi_series,
    parse_time,
    premium_decay,
    strike_series,
)
from app.api.security import require_local_control
from app.broker.base import AuthStatus, BrokerError
from app.domain.models import (
    DataSource,
    ExpirySelection,
    OptionChainSnapshot,
    SnapshotSummary,
)
from app.domain.normalize import ChainFormatError
from app.intraday.features import IST
from app.services.history import HistoryResponse, build_history
from app.services.sampler import SamplerStatus
from app.services.snapshot_service import SnapshotService
from app.services.state import AppState, ErrorEvent, SnapshotActivity
from app.storage.observations import ObservationStore
from app.storage.store import SnapshotStore, StorageError
from app.storage.strategies import StrategyError, StrategyStore
from app.strategy.automation import RunningConflict, StrategyAutomation
from app.stream.models import StreamStatusModel

router = APIRouter(prefix="/api")
UNDERLYING_Q = Query(pattern=r"^[A-Za-z0-9]{1,20}$")


def _svc(request: Request) -> SnapshotService:
    svc: SnapshotService = request.app.state.snapshot_service
    return svc


def _obs(request: Request) -> ObservationStore:
    obs: ObservationStore = request.app.state.observations
    return obs


def _each_side(strikes: str) -> int | None:
    if strikes == "all":
        return None
    try:
        n = int(strikes)
    except ValueError:
        n = -1
    if not 0 <= n <= 200:
        raise HTTPException(
            422,
            {"code": "validation_error", "message": "strikes must be 0-200 or 'all'"},
        )
    return n


def _time(value: str | None, name: str) -> Any:
    try:
        return parse_time(value)
    except ValueError:
        raise HTTPException(
            422,
            {"code": "validation_error", "message": f"{name} must be an ISO timestamp"},
        ) from None


def _store(request: Request) -> SnapshotStore:
    store: SnapshotStore = request.app.state.store
    return store


def _broker_http_error(e: BrokerError) -> HTTPException:
    code = {
        "rate_limited": status.HTTP_429_TOO_MANY_REQUESTS,
        "bad_request": status.HTTP_400_BAD_REQUEST,
        "no_expiry": status.HTTP_409_CONFLICT,
        "config": status.HTTP_503_SERVICE_UNAVAILABLE,
        "auth": status.HTTP_502_BAD_GATEWAY,
    }.get(e.code, status.HTTP_502_BAD_GATEWAY)
    return HTTPException(code, {"code": e.code, "message": e.message})


def _check_underlying(svc: SnapshotService, underlying: str | None) -> None:
    if underlying is not None and underlying.upper() != svc.underlying:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            {
                "code": "unsupported_underlying",
                "message": f"only {svc.underlying} is supported in Phase 1",
            },
        )


class Health(BaseModel):
    status: str
    time: datetime
    #: the commit this server runs (its release folder's name); None from a source checkout
    release: str | None = None


def release_id() -> str | None:
    parts = Path(__file__).resolve().parts
    if "releases" not in parts:
        return None
    i = parts.index("releases") + 1
    return parts[i][:12] if i < len(parts) else None


class AppStatus(BaseModel):
    session_id: str
    started_at: datetime
    underlying: str
    broker: str
    auth: AuthStatus
    snapshots: SnapshotActivity
    stream: StreamStatusModel
    snapshot_stale_after_seconds: int
    server_time: datetime


class ConfigStatus(BaseModel):
    credentials_present: dict[str, bool]
    allowed_origins: list[str]
    host_is_loopback: bool
    underlying: str
    option_chain_strike_count: int


class ChainResponse(BaseModel):
    snapshot: OptionChainSnapshot
    age_seconds: float
    stale: bool
    display_source: DataSource


@router.get("/health", response_model=Health)
async def health() -> Health:
    return Health(status="ok", time=datetime.now(UTC), release=release_id())


@router.get("/ops/alerts")
async def ops_alerts(request: Request) -> dict[str, Any]:
    """What the server watchdog last found, plus the app's own consistency checks.

    ``available`` is false where no watchdog runs; the app's own checks are still listed.
    """
    state_dir = Path(os.environ.get("NSE_STATE_DIR", "/opt/nse-universe/state"))
    path = state_dir / "alerts.json"
    alerts: list[dict[str, Any]] = []
    checked_at: str | None = None
    available = False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        alerts = [a for a in data.get("alerts", []) if isinstance(a, dict)]
        checked_at = data.get("checked_at")
        available = True
    except (OSError, ValueError):
        pass
    # NSE revises the NIFTY lot size now and then; the cost model must follow the broker chain's lot
    try:
        cfg = request.app.state.settings
        stored = _obs(request).latest_lot_size(cfg.underlying)
        configured = cfg.cost_lot_size
        if stored is not None and stored != configured:
            alerts.append({
                "key": "lot-size",
                "level": "warning",
                "text": f"The stored chain reports a lot size of {stored} but the cost model uses "
                f"{configured}. Set COST_LOT_SIZE={stored} in the server settings.",
            })
    except Exception:  # noqa: BLE001, S110 - a failed check must not break the alert list
        pass
    return {
        "available": available,
        "checked_at": checked_at,
        "alerts": alerts,
        "release": release_id(),
    }


@router.get("/status", response_model=AppStatus)
async def app_status(request: Request) -> AppStatus:
    s = request.app.state
    svc = _svc(request)
    return AppStatus(
        session_id=s.app_state.session_id,
        started_at=s.app_state.started_at,
        underlying=svc.underlying,
        broker=svc.broker.name,
        auth=svc.broker.auth_status,
        snapshots=s.app_state.snapshots,
        stream=request.app.state.stream.status(),
        snapshot_stale_after_seconds=s.settings.snapshot_stale_after_seconds,
        server_time=datetime.now(UTC),
    )


@router.get("/config/status", response_model=ConfigStatus)
async def config_status(request: Request) -> ConfigStatus:
    st = request.app.state.settings
    return ConfigStatus(
        credentials_present=st.credential_presence(),
        allowed_origins=st.origins(),
        host_is_loopback=st.host_is_loopback(),
        underlying=st.underlying,
        option_chain_strike_count=st.option_chain_strike_count,
    )


@router.get("/errors", response_model=list[ErrorEvent])
async def recent_errors(request: Request) -> list[ErrorEvent]:
    app_state: AppState = request.app.state.app_state
    return list(app_state.errors)


@router.get("/expiries", response_model=ExpirySelection)
async def expiries(
    request: Request, underlying: Annotated[str | None, UNDERLYING_Q] = None, refresh: bool = False
) -> ExpirySelection:
    svc = _svc(request)
    _check_underlying(svc, underlying)
    try:
        sel = await svc.expiries(force=refresh)
    except BrokerError as e:
        raise _broker_http_error(e) from None
    last = await asyncio.to_thread(_obs(request).last_session_by_expiry, svc.underlying)
    return sel.model_copy(update={"last_session": last})


@router.get("/option-chain", response_model=ChainResponse)
async def option_chain(
    request: Request, expiry: date, underlying: Annotated[str | None, UNDERLYING_Q] = None
) -> ChainResponse:
    """Latest stored snapshot for the expiry. Capture a new one with POST /api/snapshots/capture."""
    svc = _svc(request)
    _check_underlying(svc, underlying)
    store = _store(request)

    def read() -> ChainResponse | None:  # off the event loop: the busiest endpoint
        snap = store.latest(svc.underlying, expiry.isoformat())
        return None if snap is None else _chain_response(request, snap, latest=True)

    out = await asyncio.to_thread(read)
    if out is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            {"code": "no_snapshot", "message": "no snapshot captured for expiry"},
        )
    return out


@router.get("/option-chain/on-demand", response_model=ChainResponse)
async def option_chain_on_demand(
    request: Request, expiry: date, underlying: Annotated[str | None, UNDERLYING_Q] = None
) -> ChainResponse:
    """Chain of any listed expiry, fetched now and not stored (Strategy builder, calendars)."""
    svc = _svc(request)
    _check_underlying(svc, underlying)
    try:
        snap = await svc.on_demand_chain(expiry)
    except BrokerError as e:
        raise _broker_http_error(e) from None
    except ChainFormatError as e:
        detail = {"code": "chain_format", "message": str(e)}
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail) from None
    out = _chain_response(request, snap, latest=False)
    return out.model_copy(update={"display_source": DataSource.SNAPSHOT})


def _chain_response(request: Request, snap: OptionChainSnapshot, *, latest: bool) -> ChainResponse:
    age = (datetime.now(UTC) - snap.retrieved_at).total_seconds()
    stale = age > request.app.state.settings.snapshot_stale_after_seconds
    if latest and snap.session_id == request.app.state.app_state.session_id:
        display = DataSource.SNAPSHOT
    else:
        display = DataSource.STORED
    return ChainResponse(
        snapshot=snap, age_seconds=round(age, 1), stale=stale, display_source=display
    )


@router.post(
    "/snapshots/capture",
    response_model=list[SnapshotSummary],
    dependencies=[Depends(require_local_control)],
)
async def capture(request: Request, expiry: date | None = None) -> list[SnapshotSummary]:
    try:
        return await _svc(request).capture(expiry=expiry)
    except BrokerError as e:
        raise _broker_http_error(e) from None
    except StorageError as e:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, {"code": "storage", "message": str(e)}
        ) from None


@router.post(
    "/auth/login", response_model=AuthStatus, dependencies=[Depends(require_local_control)]
)
async def login(request: Request) -> AuthStatus:
    return await _svc(request).broker.login()


@router.get("/snapshots", response_model=list[SnapshotSummary])
async def list_snapshots(
    request: Request, expiry: date | None = None, limit: Annotated[int, Query(ge=1, le=500)] = 50
) -> list[SnapshotSummary]:
    svc = _svc(request)
    return _store(request).list(
        underlying=svc.underlying, expiry=expiry.isoformat() if expiry else None, limit=limit
    )


@router.get("/snapshots/{snapshot_id}", response_model=ChainResponse)
async def get_snapshot(request: Request, snapshot_id: str) -> ChainResponse:
    if not snapshot_id.replace("_", "").isalnum():
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, {"code": "bad_id", "message": "invalid snapshot id"}
        )
    snap = _store(request).load(snapshot_id)
    if snap is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, {"code": "not_found", "message": "snapshot not found"}
        )
    return _chain_response(request, snap, latest=False)


@router.get("/snapshots/{snapshot_id}/csv", response_class=PlainTextResponse)
async def snapshot_csv(request: Request, snapshot_id: str) -> PlainTextResponse:
    resp = await get_snapshot(request, snapshot_id)
    return PlainTextResponse(
        SnapshotStore.to_csv(resp.snapshot),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{snapshot_id}.csv"'},
    )


@router.get("/sessions")
async def sessions(request: Request) -> list[dict[str, Any]]:
    return _store(request).list_sessions()


@router.get("/stream/status", response_model=StreamStatusModel)
async def stream_status(request: Request) -> StreamStatusModel:
    return request.app.state.stream.status()  # type: ignore[no-any-return]


@router.post(
    "/stream/start", response_model=StreamStatusModel, dependencies=[Depends(require_local_control)]
)
async def stream_start(request: Request) -> StreamStatusModel:
    """Start the single broker stream. Idempotent: calling it while running changes nothing."""
    return await request.app.state.stream.start()  # type: ignore[no-any-return]


@router.post(
    "/stream/stop", response_model=StreamStatusModel, dependencies=[Depends(require_local_control)]
)
async def stream_stop(request: Request) -> StreamStatusModel:
    return await request.app.state.stream.stop()  # type: ignore[no-any-return]


@router.get("/history/observations", response_model=HistoryResponse)
async def history_observations(
    request: Request,
    expiry: date,
    strikes: Annotated[int, Query(ge=1, le=100)] = 10,
    limit: Annotated[int, Query(ge=1, le=2000)] = 1000,
) -> HistoryResponse:
    """Observations from stored snapshots of one expiry, oldest first (real captures only)."""
    svc = _svc(request)
    return await asyncio.to_thread(
        build_history, _store(request), svc.underlying, expiry.isoformat(), strikes, limit
    )


@router.get("/sampler/status", response_model=SamplerStatus)
async def sampler_status(request: Request) -> SamplerStatus:
    """Scheduled snapshot sampling during market hours (what fills the time-series widgets)."""
    return request.app.state.sampler.status()  # type: ignore[no-any-return]


@router.get("/observations/status")
async def observations_status(request: Request) -> dict[str, Any]:
    """Size and coverage of the persistent observation store, plus recent connection events."""
    obs = _obs(request)
    return {
        **await asyncio.to_thread(obs.stats),
        "recent_events": await asyncio.to_thread(obs.events, 20),
    }


@router.get("/oi/change", response_model=OiChange)
async def oi_change_route(
    request: Request,
    expiry: date,
    baseline: BaselineKind = "previous",
    at: str | None = None,
    until: str | None = None,
    strikes: str = "10",
) -> OiChange:
    """OI now versus an explicitly chosen baseline, per strike, with neutral labels."""
    return await asyncio.to_thread(
        oi_change, _obs(request), _svc(request).underlying, expiry.isoformat(), baseline,
        at=_time(at, "at"), until=_time(until, "until"), each_side=_each_side(strikes),
    )  # fmt: skip


@router.get("/oi/heatmap", response_model=Heatmap)
async def oi_heatmap_route(
    request: Request,
    expiry: date,
    side: Side = "CE",
    baseline: Annotated[
        str, Query(pattern="^(session_open|prev_session|previous|broker_prev_day)$")
    ] = "session_open",
    since: str | None = None,
    until: str | None = None,
    strikes: str = "10",
    max_columns: Annotated[int, Query(ge=10, le=400)] = 120,
) -> Heatmap:
    """Strike-by-time grid of OI change against the chosen baseline."""
    return await asyncio.to_thread(
        oi_heatmap, _obs(request), _svc(request).underlying, expiry.isoformat(), side,
        baseline,  # type: ignore[arg-type]
        each_side=_each_side(strikes), since=_time(since, "since"), until=_time(until, "until"),
        max_columns=max_columns,
    )  # fmt: skip


@router.get("/history/premium-decay", response_model=PremiumDecay)
async def premium_decay_route(
    request: Request,
    expiry: date,
    since: str | None = None,
    until: str | None = None,
    strikes: str = "10",
    max_points: Annotated[int, Query(ge=20, le=1000)] = 400,
) -> PremiumDecay:
    """Premium change since the first sample in range, summed over a fixed set of strikes."""
    return await asyncio.to_thread(
        premium_decay, _obs(request), _svc(request).underlying, expiry.isoformat(),
        each_side=_each_side(strikes), since=_time(since, "since"), until=_time(until, "until"),
        max_points=max_points,
    )  # fmt: skip


@router.get("/history/oi-series", response_model=OiSeries)
async def oi_series_route(
    request: Request,
    expiry: date,
    since: str | None = None,
    until: str | None = None,
    strikes: str = "all",
    max_points: Annotated[int, Query(ge=20, le=1000)] = 400,
) -> OiSeries:
    """Total OI, OI change and PCR through time over a fixed set of strikes."""
    return await asyncio.to_thread(
        oi_series, _obs(request), _svc(request).underlying, expiry.isoformat(),
        each_side=_each_side(strikes), since=_time(since, "since"), until=_time(until, "until"),
        max_points=max_points,
    )  # fmt: skip


@router.get("/history/strike-series", response_model=StrikeSeries)
async def strike_series_route(
    request: Request,
    expiry: date,
    since: str | None = None,
    until: str | None = None,
    strikes: str = "atm",
    max_points: Annotated[int, Query(ge=20, le=1000)] = 400,
) -> StrikeSeries:
    """Price, OI and OI change of chosen strikes ("atm" = the newest sample's ATM strike)."""
    try:
        parts = [x for x in strikes.split(",") if x.strip()][:45]
        picked = None if strikes == "atm" else [float(x) for x in parts]
    except ValueError as e:
        detail = "strikes must be 'atm' or comma-separated numbers"
        raise HTTPException(status_code=422, detail=detail) from e
    return await asyncio.to_thread(
        strike_series, _obs(request), _svc(request).underlying, expiry.isoformat(),
        strikes=picked, since=_time(since, "since"), until=_time(until, "until"),
        max_points=max_points,
    )  # fmt: skip


@router.get("/market/summary")
async def market_summary(request: Request) -> dict[str, Any]:
    """Stock breadth, heavyweight contribution, relative volume, move quality and sectors."""
    mk = request.app.state.market
    if not mk.enabled:
        raise HTTPException(
            status_code=404, detail={"code": "disabled", "message": "stock breadth is turned off"}
        )
    return await asyncio.to_thread(mk.summary)


@router.get("/market/index-bars")
async def market_index_bars(request: Request) -> dict[str, Any]:
    """One-minute NIFTY 50 bars of the newest stored day, from the live index feed."""
    mk = request.app.state.market
    if not mk.enabled:
        raise HTTPException(
            status_code=404, detail={"code": "disabled", "message": "stock breadth is turned off"}
        )
    return await asyncio.to_thread(mk.index_bars)


@router.get("/market/status")
async def market_status(request: Request) -> dict[str, Any]:
    """Sources, counts and the live subscription of the breadth analysis."""
    mk, stream = request.app.state.market, request.app.state.stream
    out: dict[str, Any] = await asyncio.to_thread(mk.public_status)
    out["stream"] = {
        "note": stream.market_note,
        "subscribed": stream.market_subscribed,
        "messages": stream.market_message_count,
        "handler_errors": stream.on_internal_errors,
        # wiring check: who receives the internal ticks, and how many keys are internal
        "handler_set": stream.on_internal is not None,
        "handler_is_this_service": getattr(stream.on_internal, "__self__", None) is mk,
        "internal_keys": len(stream.book.internal_keys),
        "service_ticks_seen": mk.diag["ticks"],
    }
    return out


@router.get("/market/coverage")
async def market_coverage(request: Request) -> dict[str, Any]:
    """Per index: how many stocks have a token, a tick, a price, a previous close and volume."""
    return await asyncio.to_thread(request.app.state.market.coverage_report)


@router.post("/market/refresh", dependencies=[Depends(require_local_control)])
async def market_refresh(request: Request) -> dict[str, Any]:
    """Run the due downloads now (constituent lists, tokens, bhavcopy, weights)."""
    mk = request.app.state.market
    mk._last_try.clear()  # noqa: SLF001 - an explicit request overrides the retry pause
    return await mk.run_due()  # type: ignore[no-any-return]


class WeightsImport(BaseModel):
    csv: str
    as_of: date
    source: str


@router.post("/market/weights/import", dependencies=[Depends(require_local_control)])
async def market_weights_import(request: Request, body: WeightsImport) -> dict[str, Any]:
    """Official NIFTY 50 weights supplied as CSV (columns symbol, weight in percent)."""
    from app.market.sources import SourceError

    try:
        mk = request.app.state.market
        return await asyncio.to_thread(mk.import_weights, body.csv, body.as_of, body.source)
    except SourceError as e:
        raise HTTPException(
            status_code=422, detail={"code": "bad_weights", "message": str(e)}
        ) from None


@router.get("/storage/status")
async def storage_status(request: Request) -> dict[str, Any]:
    """Storage sizes, growth and runway, backups, end-of-day status and the pruning dry run."""
    from app.lifecycle import storage as st

    eod = request.app.state.eod
    s = request.app.state.settings

    def build() -> dict[str, Any]:
        today = datetime.now(UTC).astimezone(IST).date()
        return {
            **st.report(s.data_dir, s.log_dir, today, archived_days=eod.archived_days()),
            "end_of_day": eod.status(),
            "daily_models": {
                "when": "retrained on each new final daily bar, after 18:30 IST, off market hours",
                "intraday_model": "not trained: needs 60 complete sessions",
            },
        }

    return await asyncio.to_thread(build)


class CleanupRequest(BaseModel):
    items: list[str]
    confirm: bool = False


def _cleanup_args(request: Request) -> dict[str, Any]:
    s = request.app.state.settings
    return {
        "data_dir": s.data_dir,
        "today": datetime.now(UTC).astimezone(IST).date(),
        "obs": request.app.state.observations,
        "eod": request.app.state.eod,
        "raw_keep": s.snapshot_raw_keep_days,
        "norm_keep": s.snapshot_normalized_keep_days,
        "obs_keep": s.observation_keep_sessions,
        "now": __import__("time").time(),
    }


@router.get("/storage/cleanup")
async def storage_cleanup_overview(request: Request) -> dict[str, Any]:
    """What is stored, what today holds and exactly what could be removed (changes nothing)."""
    from app.lifecycle import cleanup

    s = request.app.state.settings
    a = _cleanup_args(request)
    return await asyncio.to_thread(
        lambda: cleanup.overview(
            data_dir=a["data_dir"],
            log_dir=s.log_dir,
            today=a["today"],
            obs=a["obs"],
            intraday=request.app.state.intraday_store,
            eod=a["eod"],
            raw_keep=a["raw_keep"],
            norm_keep=a["norm_keep"],
            obs_keep=a["obs_keep"],
            underlying=s.underlying,
            now=a["now"],
        )
    )


@router.post("/storage/cleanup", dependencies=[Depends(require_local_control)])
async def storage_cleanup_run(body: CleanupRequest, request: Request) -> dict[str, Any]:
    """Remove the named categories (needs ``confirm: true``); archived or regenerable data only."""
    from app.lifecycle import cleanup

    if not body.confirm:
        raise HTTPException(
            422, {"code": "confirmation_required", "message": "send confirm: true to remove data"}
        )
    a = _cleanup_args(request)
    try:
        res = await asyncio.to_thread(
            lambda: cleanup.run(
                body.items,
                data_dir=a["data_dir"],
                today=a["today"],
                obs=a["obs"],
                eod=a["eod"],
                raw_keep=a["raw_keep"],
                norm_keep=a["norm_keep"],
                obs_keep=a["obs_keep"],
                now=a["now"],
            )
        )
    except ValueError as e:
        raise HTTPException(422, {"code": "validation_error", "message": str(e)}) from e
    a["obs"].record_event("cleanup", f"manual clean-up of {', '.join(body.items)}"[:300])
    sm = getattr(request.app.state, "servermgmt", None)
    if sm is not None:  # the Server Management Centre audits it and re-measures storage afterwards
        sm.store.audit(
            "operator", "data_cleanup", ", ".join(body.items)[:300], "execute", "ok",
            "existing Data clean-up rules", "storage snapshot queued",
        )
        task = asyncio.create_task(asyncio.to_thread(sm.snapshot, "post_cleanup"))
        request.app.state.post_cleanup_task = task  # keep a reference until it finishes
    return {"ok": True, "result": res}


@router.get("/swing/report")
async def swing_report(request: Request) -> dict[str, Any]:
    """Swing research report: backtest, robustness runs and caveats.

    Read from data/swing/report.json (built on the research PC by scripts/swing-refresh.ps1);
    nothing is computed here.
    """
    from app.services.swing_report import SwingReportError, load_report

    try:
        return await asyncio.to_thread(load_report, request.app.state.settings.data_dir)
    except SwingReportError as e:
        raise HTTPException(e.status, {"code": e.code, "message": e.message}) from e


@router.get("/swing/paper")
async def swing_paper(request: Request) -> dict[str, Any]:
    """Swing paper book: equity, open positions, next-session orders, decisions and closed trades.

    Simulated on daily bars after the close (paper only). Read from data/swing_paper.sqlite3.
    """
    return await asyncio.to_thread(request.app.state.swing_paper.view)


@router.get("/swing/live")
async def swing_live(request: Request) -> dict[str, Any]:
    """Live prices, volume pace, stop and target distances for the stocks the swing book watches.

    Shadow mode: shows what the rules would do now; the paper book itself is not changed by it.
    """
    return await asyncio.to_thread(request.app.state.swing_live.view)


@router.get("/intelligence/summary")
async def intelligence_summary(request: Request, expiry: date | None = None) -> dict[str, Any]:
    """The NIFTY 50 market-intelligence dashboard: fused sentiment, engines, regime, scenarios."""
    svc = getattr(request.app.state, "intelligence", None)
    if svc is None or not svc.enabled:
        msg = "the market-intelligence dashboard is turned off"
        raise HTTPException(status_code=404, detail={"code": "disabled", "message": msg})
    return await asyncio.to_thread(svc.summary, None if expiry is None else expiry.isoformat())


@router.get("/intelligence/timeline")
async def intelligence_timeline(request: Request, session: date | None = None) -> dict[str, Any]:
    """The per-minute fused readings that were recorded for a session (nothing is back-filled)."""
    svc = getattr(request.app.state, "intelligence", None)
    if svc is None or not svc.enabled:
        msg = "the market-intelligence dashboard is turned off"
        raise HTTPException(status_code=404, detail={"code": "disabled", "message": msg})
    return await asyncio.to_thread(svc.timeline, None if session is None else session.isoformat())


@router.get("/intelligence/validation")
async def intelligence_validation(request: Request, sessions: int = 30) -> dict[str, Any]:
    """Walk-forward validation of stored sentiment snapshots (read-only; not an accuracy claim)."""
    svc = getattr(request.app.state, "intelligence", None)
    if svc is None or not svc.enabled:
        msg = "the market-intelligence dashboard is turned off"
        raise HTTPException(status_code=404, detail={"code": "disabled", "message": msg})
    return await asyncio.to_thread(svc.validation, max(1, min(sessions, 120)))


def _straddle(request: Request) -> Any:
    svc = getattr(request.app.state, "straddle", None)
    if svc is None or not svc.enabled:
        msg = "straddle decay is turned off"
        raise HTTPException(status_code=404, detail={"code": "disabled", "message": msg})
    return svc


@router.get("/intelligence/straddle")
async def intelligence_straddle(
    request: Request, expiry: date | None = None, session: date | None = None
) -> dict[str, Any]:
    """Straddle decay intelligence of one stored session (separate from the sentiment score)."""
    svc = _straddle(request)
    ex, day = (None if x is None else x.isoformat() for x in (expiry, session))
    return await asyncio.to_thread(svc.summary, ex, day)


@router.get("/intelligence/straddle/alerts")
async def intelligence_straddle_alerts(
    request: Request, session: date | None = None
) -> dict[str, Any]:
    """Alerts raised by the straddle engine for a session, with their thresholds."""
    svc = _straddle(request)
    return await asyncio.to_thread(svc.alerts, None if session is None else session.isoformat())


@router.get("/intelligence/straddle/validation")
async def intelligence_straddle_validation(request: Request, sessions: int = 20) -> dict[str, Any]:
    """Predicted theta decay vs actual premium change over stored sessions (read-only)."""
    svc = _straddle(request)
    return await asyncio.to_thread(svc.validation, max(1, min(sessions, 60)))


@router.get("/swing/minute")
async def swing_minute(request: Request) -> dict[str, Any]:
    """The 1-minute shadow book: live-style swing rules, beside the official book. Shadow only."""
    svc = getattr(request.app.state, "swing_minute", None)
    if svc is None:
        msg = "the 1-minute shadow book is not running"
        raise HTTPException(status_code=503, detail={"code": "minute_unavailable", "message": msg})
    from app.swing.live_rules import session_state

    now = datetime.now(UTC)
    return await asyncio.to_thread(svc.view, now, session_state(now) == "open")


@router.get("/swing/live-fills")
async def swing_live_fills(request: Request) -> dict[str, Any]:
    """The live paper ledger: provisional intraday fills, apart from the official paper book."""
    ledger = getattr(request.app.state, "swing_ledger", None)
    if ledger is None:
        msg = "the live paper ledger is not running"
        raise HTTPException(status_code=503, detail={"code": "ledger_unavailable", "message": msg})
    snap = await asyncio.to_thread(ledger.snapshot)
    live = getattr(request.app.state, "swing_live", None)
    on = bool(live is not None and live.view().get("live_fills_enabled"))
    return {**snap, "enabled": on, "official_book": "separate and unchanged"}


@router.post("/swing/paper/run", dependencies=[Depends(require_local_control)])
async def swing_paper_run(request: Request) -> dict[str, Any]:
    """Run the swing scan now: the same pass the schedule runs after 17:00 IST.

    Returns at once. It takes about 9 minutes the first time; progress shows in GET /swing/paper.
    """
    svc = request.app.state.swing_paper
    started = svc.trigger()
    return {"started": started, "status": svc.status()}


@router.post("/storage/eod/run", dependencies=[Depends(require_local_control)])
async def storage_eod_run(request: Request) -> dict[str, Any]:
    """Run the end-of-day pipeline now for every finished day that has no manifest (idempotent)."""
    return await asyncio.to_thread(request.app.state.eod.run)


@router.get("/broker/daily-login")
async def daily_login_status(request: Request) -> dict[str, Any]:
    """Morning broker sign-in schedule and the result of today's attempt."""
    return request.app.state.daily_login.status()  # type: ignore[no-any-return]


@router.get("/intraday/summary")
async def intraday_summary(request: Request, expiry: date) -> dict[str, Any]:
    """Market Sentiment Command Center: rules-based intraday assessment from stored observations."""
    return await asyncio.to_thread(request.app.state.intraday.summary, expiry.isoformat())


@router.get("/intraday/hv")
async def intraday_hv(request: Request) -> dict[str, Any]:
    """Historical volatility of NIFTY 50 from stored daily closes."""
    return await asyncio.to_thread(request.app.state.intraday.hv)


@router.get("/intraday/iv-chart")
async def intraday_iv_chart(request: Request, hv: int = 21) -> dict[str, Any]:
    """Daily India VIX, NIFTY close and rolling HV (IV / HV / IV percentile chart)."""
    if hv not in (10, 20, 21, 30, 60, 63):
        detail = {"code": "bad_window", "message": "hv must be 10, 20, 21, 30, 60 or 63"}
        raise HTTPException(status_code=422, detail=detail)
    return await asyncio.to_thread(request.app.state.intraday.iv_chart, hv)


@router.get("/intraday/iv-series")
async def intraday_iv_series(
    request: Request, expiry: date, session: date | None = None, tf: int = 1, max_points: int = 90
) -> dict[str, Any]:
    """ATM implied volatility through a stored session (the latest unless `session` is given)."""
    if tf not in (1, 3, 5, 15) or not 10 <= max_points <= 400:
        msg = "tf must be 1, 3, 5 or 15 and max_points 10 to 400"
        raise HTTPException(status_code=422, detail={"code": "bad_range", "message": msg})
    svc = request.app.state.intraday
    iso = None if session is None else session.isoformat()
    return await asyncio.to_thread(svc.iv_series, expiry.isoformat(), max_points, iso, tf)


@router.get("/intraday/iv-momentum")
async def intraday_iv_momentum(
    request: Request, expiry: date, session: date | None = None, tf: int = 1
) -> dict[str, Any]:
    """Call-versus-put IV momentum (ATM, 25 and 10 delta) through a stored session."""
    if tf not in (1, 3, 5, 15):
        msg = "tf must be 1, 3, 5 or 15"
        raise HTTPException(status_code=422, detail={"code": "bad_range", "message": msg})
    svc = request.app.state.intraday
    iso = None if session is None else session.isoformat()
    return await asyncio.to_thread(svc.iv_momentum, expiry.isoformat(), iso, tf)


@router.get("/intraday/strike-positioning")
async def intraday_strike_positioning(
    request: Request, expiry: date, window: str = "15", session: date | None = None
) -> dict[str, Any]:
    """Strike-by-strike premium, OI, volume, IV and delta changes against an earlier snapshot."""
    if window not in ("5", "15", "30", "60", "open", "prev"):
        msg = "window must be 5, 15, 30, 60, open or prev"
        raise HTTPException(status_code=422, detail={"code": "bad_range", "message": msg})
    svc = request.app.state.intraday
    iso = None if session is None else session.isoformat()
    return await asyncio.to_thread(svc.strike_positioning, expiry.isoformat(), window, iso)


_UNIVERSES = ("fixed", "dynamic", "full")


@router.get("/intraday/backtest")
async def intraday_backtest(
    request: Request, expiry: date, sessions: int = 15, cost_bps: float = 5.0,
    universe: str = "dynamic",
) -> dict[str, Any]:
    """Out-of-sample test of options and GEX signals against NIFTY's next 30 minutes."""
    if not 3 <= sessions <= 60 or not 0 <= cost_bps <= 100 or universe not in _UNIVERSES:
        msg = "sessions must be 3 to 60, cost_bps 0 to 100, universe fixed, dynamic or full"
        raise HTTPException(status_code=422, detail={"code": "bad_range", "message": msg})
    svc = request.app.state.intraday
    return await asyncio.to_thread(svc.backtest, expiry.isoformat(), sessions, cost_bps, universe)


@router.get("/intraday/gex-history")
async def intraday_gex_history(
    request: Request, expiry: date, session: date | None = None, universe: str = "dynamic"
) -> dict[str, Any]:
    """GEX and gamma flip rebuilt at each 5-minute stored snapshot of a session."""
    if universe not in _UNIVERSES:
        msg = "universe must be fixed, dynamic or full"
        raise HTTPException(status_code=422, detail={"code": "bad_range", "message": msg})
    svc = request.app.state.intraday
    iso = None if session is None else session.isoformat()
    return await asyncio.to_thread(svc.gex_history, expiry.isoformat(), iso, universe)


@router.get("/intraday/premium-baskets")
async def intraday_premium_baskets(
    request: Request, expiry: date, session: date | None = None, window: str = "10",
    kind: str = "fixed",
) -> dict[str, Any]:
    """Aggregate CE and PE premium of a fixed or recentred ATM basket through a session."""
    if window not in ("5", "10", "20", "all") or kind not in ("fixed", "dynamic"):
        msg = "window must be 5, 10, 20 or all and kind fixed or dynamic"
        raise HTTPException(status_code=422, detail={"code": "bad_range", "message": msg})
    svc = request.app.state.intraday
    iso = None if session is None else session.isoformat()
    n = None if window == "all" else int(window)
    return await asyncio.to_thread(svc.premium_baskets, expiry.isoformat(), iso, n, kind)


@router.get("/intraday/iv-sessions")
async def intraday_iv_sessions(request: Request) -> dict[str, Any]:
    """IST dates that have stored option-chain samples."""
    return {"sessions": await asyncio.to_thread(request.app.state.intraday.iv_sessions)}


@router.get("/intraday/iv-skew")
async def intraday_iv_skew(
    request: Request, expiry: date, session: date | None = None
) -> dict[str, Any]:
    """Smile, skew measures and term view of the newest stored chain, or of a session."""
    iso = None if session is None else session.isoformat()
    svc = request.app.state.intraday
    return await asyncio.to_thread(svc.iv_skew, expiry.isoformat(), 15, iso)


@router.get("/intraday/forward")
async def intraday_forward(request: Request, expiry: date) -> dict[str, Any]:
    """Stored rules-based sentiment scores against what NIFTY did next (read-only)."""
    return await asyncio.to_thread(request.app.state.intraday.forward_check, expiry.isoformat())


@router.get("/intraday/replay")
async def intraday_replay(
    request: Request, session: date | None = None, expiry: date | None = None, at: str | None = None
) -> dict[str, Any]:
    """Past sessions, or the dashboard as it stood at ``at`` (HH:MM IST). Read-only."""
    svc = request.app.state.intraday
    if session is None:
        return await asyncio.to_thread(svc.replay_sessions)
    if (
        expiry is None
        or at is None
        or len(at) != 5
        or at[2] != ":"
        or not (at[:2] + at[3:]).isdigit()
        or not (0 <= int(at[:2]) < 24 and 0 <= int(at[3:]) < 60)
    ):
        raise HTTPException(status_code=422, detail="expiry and at (HH:MM) are required")
    return await asyncio.to_thread(svc.replay, session.isoformat(), expiry.isoformat(), at)


@router.get("/intraday/paper")
async def intraday_paper(request: Request) -> dict[str, Any]:
    """Cost-aware paper trading of the rule-based setups on stored sessions."""
    return await asyncio.to_thread(request.app.state.intraday.paper)


@router.get("/intraday/scores")
async def intraday_scores(
    request: Request, expiry: date, session: date | None = None
) -> dict[str, Any]:
    """Stored score snapshots for one session (append-only ledger), oldest first."""
    svc = request.app.state.intraday
    day = (session or datetime.now(UTC).astimezone(IST).date()).isoformat()
    rows = await asyncio.to_thread(svc.store.session_rows, day, expiry.isoformat())
    return {"session": day, "expiry": expiry.isoformat(), "rows": rows}


@router.get("/prediction/history/status")
async def history_status(request: Request) -> dict[str, Any]:
    """Coverage of the downloaded daily price history ."""
    return await asyncio.to_thread(request.app.state.history.status)


@router.post("/prediction/history/refresh", dependencies=[Depends(require_local_control)])
async def history_refresh(request: Request) -> dict[str, Any]:
    """Download new daily bars now (also runs by itself once a day after the close)."""
    started = request.app.state.history.trigger()
    status = await asyncio.to_thread(request.app.state.history.status)
    return {"started": started, **status}


@router.get("/prediction/flows/status")
async def flows_status(request: Request) -> dict[str, Any]:
    """NSE participant-wise F&O and FII/DII cash collection: coverage, progress, blocked or not."""
    return await asyncio.to_thread(request.app.state.flows.status)


@router.post("/prediction/flows/refresh", dependencies=[Depends(require_local_control)])
async def flows_refresh(request: Request) -> dict[str, Any]:
    started = request.app.state.flows.trigger(manual=True)
    return {"started": started, **await asyncio.to_thread(request.app.state.flows.status)}


@router.get("/prediction/flows/latest")
async def flows_latest(
    request: Request, limit: Annotated[int, Query(ge=1, le=60)] = 15
) -> dict[str, Any]:
    """Most recent stored participant-wise F&O rows (values as published by NSE)."""
    st = request.app.state.flows.store
    oi = await asyncio.to_thread(st.latest_participants, "fao_participant_oi", limit)
    vol = await asyncio.to_thread(st.latest_participants, "fao_participant_vol", limit)
    return {"open_interest": oi, "volume": vol}


class CashImport(BaseModel):
    csv: str


@router.post("/prediction/flows/cash/import", dependencies=[Depends(require_local_control)])
async def flows_cash_import(request: Request, body: CashImport) -> dict[str, Any]:
    """Import FII/DII cash activity from an NSE CSV; only the newest 7 sessions are kept."""
    from app.prediction.sources.nse import NseParseError

    if len(body.csv) > 200_000:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            {"code": "too_large", "message": "file too large"},
        )
    try:
        return await asyncio.to_thread(request.app.state.flows.import_cash_csv, body.csv)
    except NseParseError as e:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "invalid_file", "message": str(e)}
        ) from e


@router.get("/prediction/flows/cash")
async def flows_cash(request: Request) -> dict[str, Any]:
    rows = await asyncio.to_thread(request.app.state.flows.store.cash_rows)
    return {"rows": rows, "window_sessions": 7}


# ----------------------------------------------------------------- saved and closed strategies
class StrategyDoc(BaseModel):
    doc: dict[str, Any]


class StrategyImport(BaseModel):
    saved: dict[str, dict[str, Any]] = {}
    closed: dict[str, dict[str, Any]] = {}


def _strategies(request: Request) -> StrategyStore:
    store: StrategyStore = request.app.state.strategies
    return store


def _bad_strategy(e: StrategyError) -> HTTPException:
    return HTTPException(422, {"code": "validation_error", "message": str(e)})


@router.get("/strategies")
async def strategies_list(request: Request) -> dict[str, Any]:
    """Every saved and closed strategy that has not been deleted, newest change first."""
    st = _strategies(request)
    return {
        "saved": await asyncio.to_thread(st.list, "saved"),
        "closed": await asyncio.to_thread(st.list, "closed"),
    }


class StrategyPut(BaseModel):
    key: str
    doc: dict[str, Any]


class RunningPut(BaseModel):
    doc: dict[str, Any]
    base_rev: int | None = None


def _automation(request: Request) -> StrategyAutomation:
    a: StrategyAutomation = request.app.state.strategy_automation
    return a


@router.get("/strategies/running")
async def running_get(request: Request) -> dict[str, Any]:
    """The strategy the builder is managing, as the server holds it (including exits the server made), and whether the server is checking it."""  # noqa: E501
    a = _automation(request)
    doc = await asyncio.to_thread(a.get)
    return {
        "doc": doc,
        "checking": {
            "live": a.is_live(),
            "last_check_at": a.last_check_at.isoformat() if a.last_check_at else None,
            "error": a.last_error,
        },
    }


@router.put("/strategies/running")
async def running_put(body: RunningPut, request: Request) -> dict[str, Any]:
    """Store the builder's current strategy. Refused (409) when the server changed it since `base_rev` (a stop or target it executed)."""  # noqa: E501
    a = _automation(request)
    try:
        doc = await asyncio.to_thread(a.put, body.doc, body.base_rev)
    except RunningConflict as e:
        raise HTTPException(409, {"code": "conflict", "message": "the server changed this strategy (a stop or target was executed)", "current": e.current}) from e  # noqa: E501
    except StrategyError as e:
        raise _bad_strategy(e) from e
    return {"ok": True, "rev": doc["rev"]}


# The strategy's name travels in the body or the query string, never in the path: names such as
# "straddle 30/10/2026" contain slashes, which a proxy decodes and the router then cannot match.
@router.put("/strategies/{kind}")
async def strategies_put(kind: str, body: StrategyPut, request: Request) -> dict[str, Any]:
    if kind == "running":
        raise HTTPException(422, {"code": "validation_error", "message": "use PUT /strategies/running"})  # noqa: E501
    try:
        await asyncio.to_thread(_strategies(request).put, kind, body.key, body.doc)
    except StrategyError as e:
        raise _bad_strategy(e) from e
    return {"ok": True}


@router.delete("/strategies/{kind}")
async def strategies_delete(kind: str, key: str, request: Request) -> dict[str, Any]:
    """Marks the strategy deleted (it is no longer listed); its history is kept."""
    if kind == "running":
        raise HTTPException(422, {"code": "validation_error", "message": "the running strategy is replaced, not deleted"})  # noqa: E501
    try:
        done = await asyncio.to_thread(_strategies(request).delete, kind, key)
    except StrategyError as e:
        raise _bad_strategy(e) from e
    return {"ok": True, "deleted": done}


@router.post("/strategies/import")
async def strategies_import(body: StrategyImport, request: Request) -> dict[str, Any]:
    """One-time move of a browser's own saved/closed strategies to the server. Existing keys are untouched."""  # noqa: E501
    st = _strategies(request)

    def run() -> dict[str, int]:
        added = 0
        for kind, items in (("saved", body.saved), ("closed", body.closed)):
            for key, doc in items.items():
                added += st.put_if_absent(kind, key, doc)
        return {"added": added}

    try:
        return await asyncio.to_thread(run)
    except StrategyError as e:
        raise _bad_strategy(e) from e


# --------------------------------------------------- the regular session (open, close, holidays)
@router.get("/market/session")
async def market_session(request: Request) -> dict[str, Any]:
    """The session the dashboards use: open, the close in force, where it came from, and holidays.

    The close follows the exchange feed: 15:40 with the auction alignment, 15:30 if NSE ends it.
    Holidays are from the verified NSE circular list; the browser never counts one as a session."""
    from app.domain.session import SESSION_OPEN, session_close, session_label, session_source
    from app.prediction.calendar import TradingCalendar

    tracker = request.app.state.close_tracker
    cal = TradingCalendar.load()
    return {
        "open": f"{SESSION_OPEN:%H:%M}",
        "close": f"{session_close():%H:%M}",
        "label": session_label(),
        "source": session_source(),
        "configured": tracker.info.get("configured", "auto"),
        "observed": tracker.info.get("observed", []),
        "pending_change": tracker.info.get("pending"),
        "holidays": sorted(d.isoformat() for d in cal.holidays),
        "holiday_coverage": [cal.coverage[0].isoformat(), cal.coverage[1].isoformat()],
    }


class HolidayEntry(BaseModel):
    date: str
    name: str


class HolidaysUpdate(BaseModel):
    coverage_to: str
    source: str
    holidays: list[HolidayEntry] = []
    special_sessions: list[HolidayEntry] = []
    confirm_complete: bool = False


def _holiday_view() -> dict[str, Any]:
    from app.prediction.calendar import REFERENCE, TradingCalendar, read_user_file

    cal = TradingCalendar.load()
    ref = TradingCalendar._parse(REFERENCE)
    user = read_user_file() or {}
    return {
        "reference": {
            "coverage": [ref.coverage[0].isoformat(), ref.coverage[1].isoformat()],
            "holidays": [
                {"date": d.isoformat(), "name": n} for d, n in sorted(ref.holidays.items())
            ],
            "special_sessions": [
                {"date": d.isoformat(), "name": n} for d, n in sorted(ref.special_sessions.items())
            ],
        },
        "user": {
            "coverage_to": user.get("coverage_to"),
            "source": user.get("source"),
            "updated_at": user.get("updated_at"),
            "holidays": user.get("holidays", []),
            "special_sessions": user.get("special_sessions", []),
        },
        "effective_coverage": [cal.coverage[0].isoformat(), cal.coverage[1].isoformat()],
    }


@router.get("/market/holidays")
async def market_holidays() -> dict[str, Any]:
    """The NSE circular holiday list (read-only) and the holidays added in Settings."""
    return _holiday_view()


@router.put("/market/holidays", dependencies=[Depends(require_local_control)])
async def update_market_holidays(body: HolidaysUpdate) -> dict[str, Any]:
    """Replace the user's additions to the holiday list (the NSE circular list is never changed)."""
    from app.prediction.calendar import save_user_holidays, validate_user_holidays

    clean, errors = validate_user_holidays(body.model_dump())
    if clean is None:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_holidays", "message": " ".join(errors), "errors": errors},
        )
    save_user_holidays(clean)
    return _holiday_view()


# ------------------------------------------------------- NIFTY future: basis, open interest, volume
@router.get("/futures/series")
async def futures_series_route(
    request: Request, day: date | None = None, since: str | None = None
) -> dict[str, Any]:
    """The NIFTY current-month future through a session (definitions: market/futures_series.py)."""
    from app.analytics.oi import parse_time
    from app.market.futures_series import futures_series

    market = request.app.state.market
    s = request.app.state.settings
    return await asyncio.to_thread(
        futures_series, market.store, _obs(request), s.underlying,
        rate=s.risk_free_rate, day=day, since=parse_time(since),
    )
