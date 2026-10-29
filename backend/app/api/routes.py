"""REST API (documented automatically at /docs)."""

from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from app.analytics.oi import (
    BaselineKind,
    Heatmap,
    OiChange,
    Side,
    oi_change,
    oi_heatmap,
    parse_time,
)
from app.api.security import require_local_control
from app.broker.base import AuthStatus, BrokerError
from app.domain.models import (
    DataSource,
    ExpirySelection,
    OptionChainSnapshot,
    SnapshotSummary,
)
from app.services.history import HistoryResponse, build_history
from app.services.sampler import SamplerStatus
from app.services.snapshot_service import SnapshotService
from app.services.state import AppState, ErrorEvent, SnapshotActivity
from app.storage.observations import ObservationStore
from app.storage.store import SnapshotStore, StorageError
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
    return Health(status="ok", time=datetime.now(UTC))


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
        return await svc.expiries(force=refresh)
    except BrokerError as e:
        raise _broker_http_error(e) from None


@router.get("/option-chain", response_model=ChainResponse)
async def option_chain(
    request: Request, expiry: date, underlying: Annotated[str | None, UNDERLYING_Q] = None
) -> ChainResponse:
    """Latest stored snapshot for the expiry. Capture a new one with POST /api/snapshots/capture."""
    svc = _svc(request)
    _check_underlying(svc, underlying)
    snap = _store(request).latest(svc.underlying, expiry.isoformat())
    if snap is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            {"code": "no_snapshot", "message": "no snapshot captured for expiry"},
        )
    return _chain_response(request, snap, latest=True)


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


@router.get("/prediction/history/status")
async def history_status(request: Request) -> dict[str, Any]:
    """Coverage of the downloaded daily price history (Prediction Intelligence)."""
    return await asyncio.to_thread(request.app.state.history.status)


@router.post("/prediction/history/refresh", dependencies=[Depends(require_local_control)])
async def history_refresh(request: Request) -> dict[str, Any]:
    """Download new daily bars now (also runs by itself once a day after the close)."""
    started = request.app.state.history.trigger()
    status = await asyncio.to_thread(request.app.state.history.status)
    return {"started": started, **status}


@router.get("/prediction/summary")
async def prediction_summary(request: Request) -> dict[str, Any]:
    """T+1 / T+5 model performance and the next-session forecast (computed from stored history)."""
    try:
        return await asyncio.to_thread(request.app.state.research.summary)
    except RuntimeError as e:  # e.g. numpy missing on this machine
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from e


@router.post("/prediction/summary/recompute", dependencies=[Depends(require_local_control)])
async def prediction_recompute(request: Request) -> dict[str, Any]:
    return await asyncio.to_thread(request.app.state.research.summary, True)


@router.get("/prediction/flows/status")
async def flows_status(request: Request) -> dict[str, Any]:
    """NSE participant-wise F&O and FII/DII cash collection: coverage, progress, blocked or not."""
    return await asyncio.to_thread(request.app.state.flows.status)


@router.post("/prediction/flows/refresh", dependencies=[Depends(require_local_control)])
async def flows_refresh(request: Request) -> dict[str, Any]:
    started = request.app.state.flows.trigger()
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


@router.get("/prediction/events")
async def prediction_events(days: Annotated[int, Query(ge=1, le=120)] = 30) -> dict[str, Any]:
    """Scheduled macro events from official calendars (dates known in advance)."""
    from app.prediction.events import EventCalendar

    cal = await asyncio.to_thread(EventCalendar.load)
    return {"events": [e.public() for e in cal.upcoming(datetime.now(UTC), days)]}


@router.get("/prediction/news/status")
async def news_status(request: Request) -> dict[str, Any]:
    return await asyncio.to_thread(request.app.state.news.status)


@router.post("/prediction/news/refresh", dependencies=[Depends(require_local_control)])
async def news_refresh(request: Request) -> dict[str, Any]:
    started = request.app.state.news.trigger()
    return {"started": started, **await asyncio.to_thread(request.app.state.news.status)}
