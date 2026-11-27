"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import logging
import sys
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.library_routes import router as library_router
from app.api.readcache import ReadCache
from app.api.risk_routes import router as risk_router
from app.api.routes import router
from app.api.ws import router as ws_router
from app.broker.base import MarketDataBroker
from app.config import Settings, get_settings
from app.domain.models import OptionChainSnapshot
from app.edge.service import EdgeService
from app.edge.store import EdgeStore
from app.forward.service import ForwardService
from app.forward.store import ForwardStore
from app.globalmkts.service import GlobalService
from app.globalmkts.store import GlobalStore
from app.intelligence.straddle_service import StraddleDecay
from app.intelligence.straddle_store import StraddleStore
from app.intelligence.wiring import create as create_intelligence
from app.intraday.costs import CostModel
from app.intraday.service import IntradayService
from app.intraday.setups import RiskConfig
from app.intraday.store import IntradayStore
from app.library.service import LibraryService
from app.lifecycle.eod import EodService
from app.lifecycle.session_close import SessionCloseTracker
from app.logging_setup import log_event, setup_logging
from app.market.service import INDEX_KEY, MarketService
from app.market.store import MarketStore
from app.prediction.flows_service import FlowsService
from app.prediction.flows_store import FlowsStore
from app.prediction.history_service import HistoryService
from app.prediction.history_store import HistoryStore
from app.servermgmt.api import router as servermgmt_router
from app.servermgmt.scan import Area
from app.servermgmt.service import ServerMgmt
from app.servermgmt.store import MgmtStore
from app.services.backfill import backfill_observations
from app.services.daily_login import DailyLogin
from app.services.sampler import SnapshotSampler
from app.services.shadow import ShadowStore, compare
from app.services.snapshot_service import SnapshotService
from app.services.state import AppState
from app.services.universe import build_universe
from app.storage.observations import ObservationStore, event_writer
from app.storage.preferences import PreferenceStore
from app.storage.store import SnapshotStore
from app.storage.strategies import StrategyStore
from app.strategy.automation import StrategyAutomation
from app.stream.heavy import stop_heavy
from app.stream.hub import Hub
from app.stream.index_close import IndexClose
from app.stream.loopwatch import LoopWatch
from app.stream.manager import StreamConfig, StreamManager
from app.stream.runtime_metrics import MetricsStore, RuntimeMetrics
from app.swing.engine import Config as SwingConfig
from app.swing.fetch import HttpFetcher
from app.swing.live import SwingLive, previous_session
from app.swing.live_ledger import LiveLedger
from app.swing.minute_shadow import MinuteShadow
from app.swing.minute_store import MinuteStore
from app.swing.service import SwingPaperService
from app.swing.store import PaperStore

logger = logging.getLogger(__name__)


def build_broker(settings: Settings) -> MarketDataBroker:
    from app.broker.kotak import KotakBroker

    return KotakBroker(settings)


def build_servermgmt(settings: Settings) -> ServerMgmt:
    """Server Management Centre: three approved areas, its own database in the data dir."""
    import os

    env_root = os.environ.get("NSE_ROOT")
    default = Path("/opt/nse-universe")
    repo_root = Path(__file__).resolve().parents[2]
    root = Path(env_root) if env_root else default if default.is_dir() else repo_root
    areas = [
        Area("project", root, "Project root"),
        Area("data", settings.data_dir.resolve(), "Data directory"),
        Area("logs", settings.log_dir.resolve(), "Log directory"),
    ]
    return ServerMgmt(MgmtStore(settings.data_dir), areas, disk_path=settings.data_dir)


def _trading_calendar() -> Any:
    """The verified NSE calendar, or None if it cannot load (clock schedules then run alone)."""
    try:
        from app.prediction.calendar import TradingCalendar

        return TradingCalendar.load()
    except Exception:  # noqa: BLE001
        return None


def _use_user_holidays(settings: Settings) -> None:
    """Holidays entered in Settings live in the data folder; they are merged over the NSE list."""
    from app.prediction.calendar import USER_FILE_NAME, set_user_file

    set_user_file(settings.data_dir / USER_FILE_NAME)


def create_risk(settings: Settings, store: SnapshotStore, stream: StreamManager) -> Any:
    """The Greeks and What-If service.

    A bad limits configuration does not stop the application: the engine answers 503 with the
    reason until it is fixed (a typo must never switch a limit off silently).
    """
    import json

    from app.risk.portfolio import PortfolioConfig
    from app.risk.service import RiskService, RiskSettings

    error: str | None = None
    portfolio = PortfolioConfig()
    if settings.greeks_limits_json.strip():
        try:
            portfolio = PortfolioConfig.from_mapping(json.loads(settings.greeks_limits_json))
        except (ValueError, TypeError) as e:
            error = f"GREEKS_LIMITS_JSON is not valid: {e}"
    cfg = RiskSettings(
        rate=settings.risk_free_rate,
        spread_threshold_pct=settings.greeks_spread_threshold_pct,
        allow_ltp_fallback=settings.greeks_allow_ltp_fallback,
        rebuild_interval_s=settings.greeks_rebuild_interval_s,
        rebuild_min_changed=settings.greeks_rebuild_min_changed,
        default_sticky=settings.greeks_default_sticky,
        max_legs=settings.greeks_max_legs,
        stale_after_s=float(settings.snapshot_stale_after_seconds),
        live_max_age_s=float(settings.stream_stale_after_seconds),
        portfolio=portfolio,
        config_error=error,
    )

    def live_book() -> Any:
        # With the market closed the feed still repeats the last quotes and each repeat renews a
        # tick's receive time, so a tick can look fresh for hours: no live book is used then, and
        # the surface says it is built from the stored chain.
        return None if stream.market.state == "closed" else stream.book

    return RiskService(store, settings.underlying, live_book, cfg)


def create_app(settings: Settings | None = None, broker: MarketDataBroker | None = None) -> FastAPI:
    settings = settings or get_settings()
    _use_user_holidays(settings)
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
            spot_check=settings.chain_spot_check,
        )
        app.state.snapshot_service = snapshot_service
        market_ref: dict[str, MarketService] = {}
        live_ref: dict[str, SwingLive] = {}
        stream = StreamManager(
            feed_factory=b.create_feed,
            universe_provider=lambda: build_universe(
                snapshot_service,
                lambda: list(
                    {
                        t.key: t
                        for t in (market_ref["m"].stream_tokens() if "m" in market_ref else [])
                        + (live_ref["l"].feed_tokens() if "l" in live_ref else [])
                    }.values()
                ),
            ),
            config=StreamConfig(
                stale_after_seconds=settings.stream_stale_after_seconds,
                broadcast_interval_ms=settings.stream_broadcast_interval_ms,
                max_reconnect_attempts=settings.stream_max_reconnect_attempts,
                backoff_base_s=settings.stream_backoff_base_seconds,
                backoff_cap_s=settings.stream_backoff_cap_seconds,
                failed_retry_s=settings.stream_failed_retry_seconds,
                test_timeout_s=settings.stream_test_timeout_seconds,
            ),
            hub=Hub(max_clients=settings.ws_max_clients),
            relogin=b.login,
            on_event=event_writer(observations, session_id),
        )
        stream.index_close = IndexClose(settings.data_dir)
        app.state.stream = stream
        shadow_store = ShadowStore(settings.data_dir)
        app.state.shadow_store = shadow_store

        def shadow_compare(snap: OptionChainSnapshot) -> None:
            row = compare(snap, stream.book.get, snap.retrieved_at)
            if row["with_tick"]:  # no ticks at all means the stream is off: nothing to compare
                shadow_store.add(row)

        snapshot_service.shadow = shadow_compare
        history_store = HistoryStore(settings.data_dir)
        history = HistoryService(
            history_store,
            enabled=settings.history_autofetch,
            start=settings.history_start,
            calendar=_trading_calendar(),
        )
        app.state.history = history
        history.start()
        flows_store = FlowsStore(settings.data_dir)
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
        app.state.strategies = StrategyStore(settings.data_dir)
        app.state.preferences = PreferenceStore(settings.data_dir)

        def _live_price(key: str) -> float | None:
            t = stream.book.get(key)
            if t is not None:
                return t.ltp
            # a NIFTY future is a server-side contract (not in the browser feed); fresh ticks only
            f = stream.book.get_internal(key)
            if f is None or f.received_at is None or not f.ltp or f.ltp <= 0:
                return None
            fresh = (datetime.now(UTC) - f.received_at).total_seconds() <= 180
            return f.ltp if fresh else None

        strategy_automation = StrategyAutomation(
            app.state.strategies,
            _live_price,
            lambda: stream.status().effective_state == "streaming",
            trading_day=lambda d: app.state.intraday.trading_day(d),
        )
        app.state.strategy_automation = strategy_automation
        strategy_automation.start()
        flows.start()
        globalmkts = GlobalService(
            GlobalStore(settings.data_dir), enabled=settings.globalmkts_enabled
        )
        app.state.globalmkts = globalmkts
        globalmkts.start()
        intraday_store = IntradayStore(settings.data_dir)
        intraday = IntradayService(
            observations, history_store, flows_store, intraday_store, settings.underlying
        )
        app.state.intraday = intraday
        if settings.intraday_autoscore:
            intraday.start()
        market_store = MarketStore(settings.data_dir)
        scrip = getattr(b, "scrip_master_rows", None)
        market = MarketService(
            market_store,
            ticks=stream.book.internal_ticks,
            scrip_master=scrip,
            monthly_expiry=snapshot_service.cached_monthly_expiry,
            trading_day=lambda d: intraday.trading_day(d),
            enabled=settings.breadth_enabled,
            index_tick=lambda: stream.book.get(INDEX_KEY),
            add_tokens=stream.add_internal_tokens,
        )
        app.state.market = market
        stream.on_internal = market.on_tick
        stream.public_internal = market.is_nifty_future_key
        intraday.market = market
        intraday.risk_free_rate = settings.risk_free_rate
        hh, mm = (int(x) for x in settings.risk_cutoff.split(":"))
        intraday.risk = RiskConfig(
            max_loss_per_trade_rs=settings.risk_max_loss_per_trade_rs,
            max_daily_loss_rs=settings.risk_max_daily_loss_rs,
            max_trades_per_day=settings.risk_max_trades_per_day,
            max_consecutive_losses=settings.risk_max_consecutive_losses,
            min_reward_risk=settings.risk_min_reward_risk,
            max_spread_pts=settings.risk_max_spread_pts,
            max_lots=settings.risk_max_lots,
            cutoff=time(hh, mm),
        )
        intraday.costs = CostModel(
            lot_size=settings.cost_lot_size,
            brokerage_per_order=settings.cost_brokerage_per_order,
            stt_sell_pct=settings.cost_stt_futures_sell_pct,
            exchange_pct=settings.cost_exchange_pct,
            slippage_pts=settings.cost_slippage_pts,
        )
        if settings.breadth_enabled:
            market_ref["m"] = market
            market.start()
        eod = EodService(
            observations,
            intraday_store,
            history_store,
            settings.data_dir,
            settings.underlying,
            log_dir=settings.log_dir,
            enabled=settings.eod_enabled,
            # the server's nightly timer (deploy/backup.sh) already backs up every database
            backups=settings.eod_backups and not Path("/var/backups/nse-universe").is_dir(),
            market=market_store,
            risk_free_rate=settings.risk_free_rate,
            raw_keep_days=settings.snapshot_raw_keep_days,
            normalized_keep_days=settings.snapshot_normalized_keep_days,
            observation_keep_sessions=settings.observation_keep_sessions,
            observation_prune_dry_run=settings.observation_prune_dry_run,
            keep_daily_backups=settings.backup_keep_daily,
            keep_monthly_backups=settings.backup_keep_monthly,
        )
        app.state.eod = eod
        library = LibraryService(
            settings.data_dir, observations, settings.underlying, block_days=settings.library_block_days, restore_ttl_hours=settings.library_restore_ttl_hours,  # noqa: E501
            restore_max_bytes=settings.library_restore_max_mb * 10**6, min_free_bytes=int(settings.library_min_free_gb * 1e9), enabled=settings.library_enabled,  # noqa: E501
        )  # fmt: skip
        library.cleanup_restores()  # a restore that expired while the backend was down
        app.state.library = library
        eod.library = library
        store.restore_on_demand = library.ensure_day  # an old snapshot opened on the Data page is restored from its bundle by itself  # noqa: E501
        store.fallback_roots = library.fallback_roots  # a snapshot file missing from the data directory is read from an active restore  # noqa: E501
        app.state.intraday_store = intraday_store
        eod.start()
        close_tracker = SessionCloseTracker(observations, settings.market_close)
        app.state.close_tracker = close_tracker
        close_tracker.start()
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

        async def _restart_stream() -> None:
            # the feed holds the old session: restart it only if it was running
            if stream.status().state.value != "stopped":
                await stream.stop()
                await stream.start()

        hh, mm = (int(x) for x in settings.broker_login_time.split(":"))
        daily_login = DailyLogin(
            b.login, _restart_stream, at=time(hh, mm), enabled=settings.broker_daily_login
        )
        app.state.daily_login = daily_login
        daily_login.start()
        sh, sm = (int(x) for x in settings.swing_paper_run_after.split(":"))
        intelligence = create_intelligence(settings, observations, intraday, market, market_store)
        app.state.intelligence = intelligence
        intelligence.start()
        app.state.straddle = StraddleDecay(
            observations=observations, underlying=settings.underlying,
            gex=lambda e: intraday.gex_history(e, None, "dynamic"),
            rate=settings.risk_free_rate, enabled=settings.intelligence_enabled,
            store=StraddleStore(settings.data_dir), mi=intelligence.summary,
        )
        app.state.straddle.start()
        if settings.greeks_enabled:
            app.state.risk = create_risk(settings, store, stream)
        async def forward_expiries() -> tuple[str | None, str | None]:
            sel = await snapshot_service.expiries()
            weekly = None if sel.weekly is None else sel.weekly.isoformat()
            return weekly, (None if sel.monthly is None else sel.monthly.isoformat())

        forward = ForwardService(
            observations=observations,
            straddle=app.state.straddle,
            store=ForwardStore(settings.data_dir),
            underlying=settings.underlying,
            expiries=forward_expiries,
            lot=settings.cost_lot_size,
            enabled=settings.forward_enabled and settings.intelligence_enabled,
        )
        app.state.forward = forward
        forward.start()
        edge = EdgeService(
            EdgeStore(settings.data_dir),
            sessions=lambda: sorted(
                {*intelligence.store.sessions(400), *intraday_store.all_score_sessions()}),
            intel_rows=lambda s: intelligence.store.rows(s, 1000),
            rules_rows=intraday_store.session_scores,
            straddle_rows=lambda s: app.state.straddle.store.rows(s, 1000),
            enabled=settings.edge_enabled and settings.intelligence_enabled,
        )
        app.state.edge = edge
        edge.start()
        swing_paper = SwingPaperService(
            PaperStore(settings.data_dir), HttpFetcher(), enabled=settings.swing_paper_enabled,
            run_after=time(sh, sm),
            cfg=SwingConfig(capital=settings.swing_paper_capital,
                            cost_per_side=settings.swing_paper_cost_per_side))
        app.state.swing_paper = swing_paper
        swing_paper.start()
        ledger_path = settings.data_dir / "swing_live_fills.sqlite3"
        swing_ledger = LiveLedger(ledger_path, swing_paper.cfg)
        swing_minute = MinuteShadow(
            MinuteStore(settings.data_dir / "swing_minute.sqlite3"), swing_paper.cfg,
            prev_session=previous_session, enabled=settings.swing_live_enabled,
            profile=lambda: (market.baselines(datetime.now(UTC)) or {}).get("stock_profile"),
        )
        app.state.swing_minute = swing_minute
        # the evening scan hands the same candidates to both books; the live book keeps its own copy
        swing_paper.on_candidates = lambda s, o: swing_minute.store.save_queue(s, list(o))

        def _settled(s: str, decisions: Any, trades: Any) -> Any:
            out = swing_ledger.settled(s, decisions, trades)  # reconcile the live ledger
            try:
                swing_minute.settled(s, decisions, trades)  # compare the 1-minute shadow book
            except Exception as e:  # noqa: BLE001 - must never disturb the evening run
                err = type(e).__name__
                log_event(logger, logging.ERROR, "swing_minute_compare_failed", error=err)
            return out

        swing_paper.on_session = _settled
        app.state.swing_ledger = swing_ledger
        swing_live = SwingLive(
            swing_paper.store, swing_paper.cfg, ticks=stream.book.internal_ticks,
            ledger=swing_ledger, live_fills=lambda: settings.swing_live_fills_enabled,
            minute=swing_minute,
            scrip_master=scrip,
            add_tokens=stream.add_internal_tokens, feed_state=lambda: stream.state.value,
            enabled=settings.swing_live_enabled,
        )
        live_ref["l"] = swing_live
        app.state.swing_live = swing_live
        swing_live.start()
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
        servermgmt = build_servermgmt(settings)
        app.state.servermgmt = servermgmt
        servermgmt.start()
        # Threads and the event loop share one interpreter lock; a 1 ms slice (default 5 ms) keeps
        # the live feed's turns close together even while a thread is busy.
        sys.setswitchinterval(0.001)
        loopwatch = LoopWatch()
        loopwatch.start()
        app.state.loopwatch = loopwatch
        runtime_metrics = RuntimeMetrics(MetricsStore(settings.data_dir), loopwatch, stream)
        runtime_metrics.start()  # one row a minute (GET /api/runtime/metrics)
        app.state.runtime_metrics = runtime_metrics
        # heavy reads: one computation for everyone asking at the same moment
        app.state.readcache = ReadCache(ttl_scale=settings.read_cache_scale)
        try:
            yield
        finally:
            # The broker connection first (it must end cleanly). 27 Nov, 13:01 IST: the stops below
            # ran past systemd's 20 s, the process was killed with the feed open, and the next
            # session's subscription was half-acknowledged and then silent.
            await stream.shutdown()
            stop_heavy()  # queued heavy jobs would hold the exit
            await runtime_metrics.stop()
            await loopwatch.stop()
            await servermgmt.stop()
            if not login_task.done():
                login_task.cancel()
            await market.stop()
            market_store.close()
            await close_tracker.stop()
            await strategy_automation.stop()
            await eod.stop()
            await swing_live.stop()
            await app.state.straddle.stop()
            await intelligence.stop()
            await swing_paper.stop()
            await daily_login.stop()
            await intraday.stop()
            intraday_store.close()
            await history.stop()
            await flows.stop()
            await globalmkts.stop()
            await forward.stop()
            await edge.stop()
            flows_store.close()
            app.state.strategies.close()
            app.state.preferences.close()
            history_store.close()
            await sampler.stop()
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
    app.include_router(risk_router)
    app.include_router(library_router)
    app.include_router(servermgmt_router)
    app.include_router(ws_router)
    return app
