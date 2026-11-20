"""REST endpoints of the Greeks and What-If engine, under /api/risk. Read-only: every endpoint computes from stored chains and the live stream; none changes state or places an order.

Every response carries ``surface_version_id`` and ``as_of_ist`` (the surface the numbers came from), ``source`` ("live" when any quote came from the stream's bid and ask, "stored" otherwise), ``stale`` and
per-expiry ``data`` (snapshot id and time, age, number of quotes priced from a live book, lot size, expiry instant). A missing number is null, never zero. The live view is a poll (about once a second): the
surface is rebuilt only when due, so polling faster costs nothing.
"""

from __future__ import annotations

import asyncio
from datetime import date
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from app.broker.base import BrokerError
from app.risk.jsonify import to_json
from app.risk.service import RiskService, RiskUnavailable, SurfaceBundle
from app.risk.whatif import STICKY_RULES, Scenario

router = APIRouter(prefix="/api/risk", tags=["risk"])

Rule = Literal["moneyness", "strike", "delta"]
_CODES = {"config_error": 503, "no_surface": 503, "no_expiry": 400, "expiry_unavailable": 409, "no_fit": 409}


class LegIn(BaseModel):
    """A leg as the Strategy Builder holds it: a side, whole lots and an optional entry premium per unit. The lot size comes from the chain, not from the client."""

    expiry: date
    strike: float = Field(gt=0, lt=1_000_000)
    type: Literal["CE", "PE"]
    action: Literal["BUY", "SELL"]
    lots: int = Field(ge=1, le=1000)
    entry_price: float | None = Field(default=None, ge=0, lt=1_000_000)


class ScenarioIn(BaseModel):
    spot_shock: float = Field(default=0.0, ge=-20_000, le=20_000, description="index points")
    iv_shock: float = Field(default=0.0, ge=-100, le=100, description="volatility points")
    time_elapsed_hours: float = Field(default=0.0, ge=0, le=24 * 400)
    sticky_rule: Rule | None = None
    rate_shock: float = Field(default=0.0, ge=-0.1, le=0.1, description="absolute: 0.01 is one percentage point")


class ScenarioRequest(BaseModel):
    legs: list[LegIn] = Field(min_length=1)
    scenario: ScenarioIn = Field(default_factory=ScenarioIn)


class GridRequest(BaseModel):
    legs: list[LegIn] = Field(min_length=1)
    kind: Literal["spot_iv", "spot_time", "payoff"] = "spot_iv"
    sticky_rule: Rule | None = None
    spot_shocks: list[Annotated[float, Field(ge=-20_000, le=20_000)]] | None = Field(default=None, max_length=101)
    iv_shocks: list[Annotated[float, Field(ge=-100, le=100)]] | None = Field(default=None, max_length=101)
    hours: list[Annotated[float, Field(ge=0, le=24 * 400)]] | None = Field(default=None, max_length=101)
    fixed_hours: float = Field(default=0.0, ge=0, le=24 * 400, description="elapsed time for a spot_iv grid")
    fixed_iv_shock: float = Field(default=0.0, ge=-100, le=100, description="volatility shock for a spot_time grid")
    rate_shock: float = Field(default=0.0, ge=-0.1, le=0.1)


class PortfolioRequest(BaseModel):
    legs: list[LegIn] = Field(min_length=1)


def _service(request: Request) -> RiskService:
    svc: RiskService | None = getattr(request.app.state, "risk", None)
    if svc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, {"code": "disabled", "message": "the Greeks and What-If engine is turned off"})
    return svc


def _unavailable(e: RiskUnavailable) -> HTTPException:
    return HTTPException(_CODES.get(e.code, 503), {"code": e.code, "message": e.message})


async def _default_expiries(request: Request) -> list[str]:
    """The current weekly and monthly expiry; from the broker's cached lookup, or from the stored chains when that is unavailable."""
    svc = request.app.state.snapshot_service
    try:
        sel = await svc.expiries()
        out = [d.isoformat() for d in (sel.weekly, sel.monthly) if d is not None]
        if out:
            return list(dict.fromkeys(out))
    except BrokerError:
        pass
    today = date.today().isoformat()
    stored = request.app.state.store.list(underlying=svc.underlying, limit=200)
    return sorted({s.expiry.isoformat() for s in stored if s.expiry.isoformat() >= today})[:2]


def _stamp(bundle: SurfaceBundle) -> dict[str, Any]:
    return {
        "surface_version_id": bundle.surface.version_id,
        "as_of_ist": bundle.surface.as_of_ist,
        "source": bundle.source,
        "stale": any(d.stale for d in bundle.data if d.status == "ok"),
        "data": to_json(bundle.data),
    }


def _specs(legs: list[LegIn], max_legs: int) -> list[tuple[str, float, float, float, float | None]]:
    if len(legs) > max_legs:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "too_many_legs", "message": f"at most {max_legs} legs"})
    return [(lg.expiry.isoformat(), lg.strike, 1.0 if lg.type == "CE" else -1.0, float(lg.lots if lg.action == "BUY" else -lg.lots), lg.entry_price) for lg in legs]


async def _bundle(request: Request, svc: RiskService, expiries: list[str]) -> SurfaceBundle:
    try:
        return await asyncio.to_thread(svc.surface, expiries)
    except RiskUnavailable as e:
        raise _unavailable(e) from None


def _scenario(s: ScenarioIn, default: str) -> Scenario:
    return Scenario(s.spot_shock, s.iv_shock, s.time_elapsed_hours, s.sticky_rule or default, s.rate_shock)


@router.get("/status")
async def risk_status(request: Request) -> dict[str, Any]:
    """Settings and state of the engine: the surface version in use, rebuild counts, the cache. Needs no surface."""
    return to_json(_service(request).status())  # type: ignore[no-any-return]


@router.get("/surface")
async def risk_surface(request: Request, expiry: Annotated[list[date] | None, Query()] = None) -> dict[str, Any]:
    """The fitted implied-volatility surface: per expiry the SVI parameters, forward, fit quality, no-arbitrage checks and the degraded flag; per strike the market volatility, the fit, the residual in
    volatility points, and whether the quote was used, rejected (with the reason) or flagged as an arbitrage violation."""
    svc = _service(request)
    wanted = [e.isoformat() for e in expiry] if expiry else await _default_expiries(request)
    b = await _bundle(request, svc, wanted)
    keep = set(wanted)
    return {
        **_stamp(b),
        "config": to_json(b.surface.config),
        "slices": to_json([s for s in b.surface.slices if s.expiry in keep or not keep]),
        "strikes": to_json([x for x in b.surface.strikes if x.expiry in keep or not keep]),
    }


@router.get("/chain-greeks")
async def risk_chain_greeks(
    request: Request, expiry: date, strikes: Annotated[str, Query(pattern=r"^(all|\d{1,3})$")] = "10", third_order: bool = False
) -> dict[str, Any]:
    """Greeks of every listed strike of one expiry at the surface's volatility, per unit and in rupees for one long lot (third order is optional: it costs a few milliseconds more)."""
    svc = _service(request)
    b = await _bundle(request, svc, [expiry.isoformat()])
    if expiry.isoformat() not in b.lot_sizes:
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "expiry_unavailable", "message": f"no chain data for the expiry {expiry}"})
    try:
        body = await asyncio.to_thread(svc.chain_greeks, b, expiry.isoformat(), None if strikes == "all" else int(strikes), third_order)
    except RiskUnavailable as e:
        raise _unavailable(e) from None
    return {**_stamp(b), **to_json(body)}


@router.post("/scenario")
async def risk_scenario(request: Request, body: ScenarioRequest) -> dict[str, Any]:
    """One scenario on the position: spot shock, volatility shock, elapsed time, sticky rule and rate shock; the P&L in rupees in total and per leg."""
    svc = _service(request)
    specs = _specs(body.legs, svc.cfg.max_legs)
    b = await _bundle(request, svc, sorted({s[0] for s in specs}))
    try:
        legs = svc.legs(b, specs)
    except RiskUnavailable as e:
        raise _unavailable(e) from None
    res = await asyncio.to_thread(svc.whatif(b, legs).run, _scenario(body.scenario, svc.cfg.default_sticky))
    return {**_stamp(b), "result": to_json(res)}


@router.post("/grid")
async def risk_grid(request: Request, body: GridRequest) -> dict[str, Any]:
    """A scenario grid: spot by volatility (the risk matrix), spot by elapsed time, or the payoff at the nearest expiry. Default axes span two standard deviations and 10 volatility points."""
    svc = _service(request)
    specs = _specs(body.legs, svc.cfg.max_legs)
    b = await _bundle(request, svc, sorted({s[0] for s in specs}))
    try:
        legs = svc.legs(b, specs)
    except RiskUnavailable as e:
        raise _unavailable(e) from None
    eng = svc.whatif(b, legs)
    rule = body.sticky_rule or svc.cfg.default_sticky

    def compute() -> Any:
        if body.kind == "spot_iv":
            return eng.grid_spot_iv(body.spot_shocks, body.iv_shocks, rule, body.fixed_hours, body.rate_shock)
        if body.kind == "spot_time":
            return eng.grid_spot_time(body.spot_shocks, body.hours, rule, body.fixed_iv_shock, body.rate_shock)
        return eng.payoff_at_expiry(body.spot_shocks, rule)

    grid = await asyncio.to_thread(compute)
    atm = eng.nearest_atm()
    return {**_stamp(b), "grid": to_json(grid), "forward": None if atm is None else atm[0]}


@router.post("/portfolio")
async def risk_portfolio(request: Request, body: PortfolioRequest) -> dict[str, Any]:
    """Net Greeks of the position in raw and rupee terms, per leg and per expiry bucket, the beta-weighted delta, and the configured limits with their breach flags."""
    svc = _service(request)
    specs = _specs(body.legs, svc.cfg.max_legs)
    b = await _bundle(request, svc, sorted({s[0] for s in specs}))
    try:
        legs = svc.legs(b, specs)
    except RiskUnavailable as e:
        raise _unavailable(e) from None
    risk = await asyncio.to_thread(svc.portfolio.aggregate, b.surface, legs, b.instants, None, request.app.state.settings.underlying)
    return {**_stamp(b), "portfolio": to_json(risk)}


@router.post("/presets")
async def risk_presets(request: Request, body: PortfolioRequest) -> dict[str, Any]:
    """The standard scenarios (gap down 2 %, IV spike +5, the one and two standard deviation bands, expiry-day crush) sized from the position's nearest expiry, each with its P&L in rupees."""
    svc = _service(request)
    specs = _specs(body.legs, svc.cfg.max_legs)
    b = await _bundle(request, svc, sorted({s[0] for s in specs}))
    try:
        legs = svc.legs(b, specs)
    except RiskUnavailable as e:
        raise _unavailable(e) from None
    eng = svc.whatif(b, legs)

    def compute() -> dict[str, Any]:
        out: dict[str, Any] = {}
        for name, sc in eng.presets().items():
            r = eng.run(sc)
            out[name] = {"scenario": to_json(sc), "pnl": to_json(r.pnl), "partial_pnl": to_json(r.partial_pnl), "warnings": list(r.warnings)}
        return out

    return {**_stamp(b), "presets": await asyncio.to_thread(compute), "sticky_rules": list(STICKY_RULES)}
