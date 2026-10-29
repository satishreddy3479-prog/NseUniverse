"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, timedelta

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.api.ws import router as ws_router
from app.broker.base import MarketDataBroker
from app.config import Settings, get_settings
from app.intraday.service import IntradayService
from app.intraday.store import IntradayStore
from app.logging_setup import log_event, setup_logging
from app.prediction.flows_service import FlowsService
from app.prediction.flows_store import FlowsStore
from app.prediction.history_service import HistoryService
from app.prediction.history_store import HistoryStore
from app.prediction.ledger import ForecastLedger
from app.prediction.news_service import NewsService
from app.prediction.news_store import NewsStore
from app.prediction.research import PredictionResearch
from app.services.backfill import backfill_observations
from app.services.sampler import SnapshotSampler
from app.services.snapshot_service import SnapshotService
from app.services.state import AppState
from app.services.universe import build_universe
from app.storage.observations import ObservationStore
from app.storage.store import SnapshotStore
from app.stream.hub import Hub
from app.stream.manager import StreamConfig, StreamManager

logger = logging.getLogger(__name__)


def build_broker(settings: Settings) -> MarketDataBroker:
    from app.broker.kotak import KotakBroker

    return KotakBroker(settings)


def create_app(settings: Settings | None = None, broker: MarketDataBroker | None = None) -> FastAPI:
    settings = settings or get_settings()
    setup_logging(settings.log_level, settings.log_dir, settings.secret_values())

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        session_id = f"{datetime.now(UTC):%Y%m%dT%H%M%SZ}_{uuid.uuid4().hex[:6]}"
        store = SnapshotStore(settings.data_dir)
        store.start_session(session_id, "live")
        app_state = AppState(session_id)
        observations = ObservationStore(settings.data_dir)
        app.state.observations = observations
        await asyncio.to_thread(backfill_observations, store, observations, settings.underlying)
        observations.record_event("app_started", "backend started", session_id)
        b = broker or build_broker(settings)
        app.state.settings = settings
        app.state.store = store
        app.state.app_state = app_state
        snapshot_service = SnapshotService(
            b,
            store,
            app_state,
            settings.underlying,
            settings.option_chain_strike_count,
            settings.snapshot_stale_after_seconds,
            observations,
        )
        app.state.snapshot_service = snapshot_service
        stream = StreamManager(
            feed_factory=b.create_feed,
            universe_provider=lambda: build_universe(snapshot_service),
            config=StreamConfig(
                stale_after_seconds=settings.stream_stale_after_seconds,
                broadcast_interval_ms=settings.stream_broadcast_interval_ms,
                max_reconnect_attempts=settings.stream_max_reconnect_attempts,
                backoff_base_s=settings.stream_backoff_base_seconds,
                backoff_cap_s=settings.stream_backoff_cap_seconds,
                test_timeout_s=settings.stream_test_timeout_seconds,
            ),
            hub=Hub(max_clients=settings.ws_max_clients),
            relogin=b.login,
            on_event=lambda kind, detail: observations.record_event(kind, detail, session_id),
        )
        app.state.stream = stream
        history_store = HistoryStore(settings.data_dir)
        history = HistoryService(
            history_store, enabled=settings.history_autofetch, start=settings.history_start
        )
        app.state.history = history
        ledger = ForecastLedger(settings.data_dir)
        history.start()
        flows_store = FlowsStore(settings.data_dir)
        news_store = NewsStore(settings.data_dir)
        news = NewsService(news_store, enabled=settings.news_autofetch)
        app.state.news = news
        news.start()
        research = PredictionResearch(
            history_store, ledger, cache_dir=settings.data_dir, flows=flows_store
        )
        app.state.research = research
        research.start()
        flows = FlowsService(
            flows_store,
            lambda: [
                b.session
                for b in history_store.bars("NIFTY50")
                if b.session >= date.today() - timedelta(days=settings.flows_history_days)
            ],
            enabled=settings.flows_autofetch,
        )
        app.state.flows = flows
        flows.start()
        intraday_store = IntradayStore(settings.data_dir)
        intraday = IntradayService(
            observations, history_store, flows_store, intraday_store, settings.underlying
        )
        app.state.intraday = intraday
        if settings.intraday_autoscore:
            intraday.start()
        sampler = SnapshotSampler(
            snapshot_service,
            interval_s=settings.sampler_interval_seconds,
            enabled=settings.sampler_enabled,
            market=lambda: stream.market,
            min_free_gb=settings.sampler_min_free_gb,
            data_dir=settings.data_dir,
        )
        app.state.sampler = sampler
        sampler.start()
        stream.start_background()
        if settings.stream_autostart:
            await stream.start()
        log_event(
            logger,
            logging.INFO,
            "app_started",
            session_id=session_id,
        )
        login_task = asyncio.create_task(b.ensure_login())
        try:
            yield
        finally:
            if not login_task.done():
                login_task.cancel()
            await intraday.stop()
            intraday_store.close()
            await history.stop()
            await research.stop()
            await news.stop()
            news_store.close()
            await flows.stop()
            flows_store.close()
            history_store.close()
            ledger.close()
            await sampler.stop()
            await stream.shutdown()
            await b.close()
            observations.record_event("app_stopped", "backend stopping", session_id)
            observations.close()
            store.end_session(session_id)
            store.close()
            log_event(logger, logging.INFO, "app_stopped", session_id=session_id)

    app = FastAPI(
        title="NSE Universe API",
        version="0.1.0",
        lifespan=lifespan,
        description="Phase 1 market-data backend. Read-only; no order placement.",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.origins(),
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        fields = [".".join(str(p) for p in e.get("loc", [])) for e in exc.errors()]
        return JSONResponse(
            status_code=422,
            content={
                "detail": {
                    "code": "validation_error",
                    "message": "invalid request parameters",
                    "fields": fields,
                }
            },
        )

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        log_event(logger, logging.ERROR, "unhandled_exception", exc_type=type(exc).__name__)
        return JSONResponse(
            status_code=500,
            content={"detail": {"code": "internal_error", "message": "internal server error"}},
        )

    app.include_router(router)
    app.include_router(ws_router)
    return app
