"""Intraday backtest of a multi-leg option strategy on the option chains NSE Universe has stored.

What the data allows (and what it does not):
* The only option prices are the last traded prices stored about once a minute in market hours, from the day
  collection started. There is no bid/ask and no history before that. A result therefore describes only the
  stored sessions, and the report says how many there are.
* Fills use the stored last traded price of the first sample at or after the entry time (and at or after the exit
  time), plus the configured slippage and costs. Nothing is filled at a price that was not stored.
* Stop-loss and target are checked on every stored sample, stop-loss first. A move between two samples is not seen;
  the exit happens at the first sample that shows the breach, at that sample's price (gap-through is kept).
* A sample where any leg has no price is skipped and counted. If the entry or the exit cannot be priced within the
  allowed wait, the day is reported as skipped or unpriced, never filled with a made-up price.
Every result carries the configuration, the data window and a fingerprint of the stored data it read, so the same
configuration on the same data gives the same numbers.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field, field_validator

from app.domain.session import SESSION_CLOSE, SESSION_OPEN
from app.storage.observations import CALL, PUT, Contract, ObservationStore, Sample
from app.strategy.costs import CostModel, execution_cost

IST = ZoneInfo("Asia/Kolkata")
MIN_SAMPLES_PER_SESSION = 30
MIN_TRADES_FOR_CONCLUSION = 30
Mode = Literal["rupees", "pct_of_premium"]


class LegSpec(BaseModel):
    type: Literal["CE", "PE"]
    action: Literal["BUY", "SELL"]
    lots: int = Field(ge=1, le=1000)
    #: strike chosen at entry: this many listed strikes above (+) or below (-) the strike nearest the spot
    offset_steps: int = Field(ge=-50, le=50)


class Exit(BaseModel):
    mode: Mode = "rupees"
    value: float = Field(gt=0)


class BacktestConfig(BaseModel):
    underlying: Literal["NIFTY"] = "NIFTY"
    legs: list[LegSpec] = Field(min_length=1, max_length=8)
    #: which stored expiry to trade each session: the nearest one still to come, or the one after it
    expiry: Literal["nearest", "next"] = "nearest"
    entry_time: str = "09:20"
    exit_time: str = "15:15"
    max_wait_minutes: int = Field(default=5, ge=0, le=60)
    stop_loss: Exit | None = None
    target: Exit | None = None
    lot_size: int | None = Field(default=None, ge=1)
    costs: CostModel = CostModel()
    start: date | None = None
    end: date | None = None

    @field_validator("entry_time", "exit_time")
    @classmethod
    def _hhmm(cls, v: str) -> str:
        try:
            h, m = v.split(":")
            time(int(h), int(m))
        except Exception as e:  # noqa: BLE001
            raise ValueError("time must be HH:MM") from e
        return v


def _t(s: str) -> time:
    h, m = s.split(":")
    return time(int(h), int(m))


def _ltp(c: dict[tuple[float, int], Contract], strike: float, side: int) -> float | None:
    q = c.get((strike, side))
    return q.ltp if q is not None and q.ltp is not None and q.ltp > 0 else None


def _config_hash(cfg: BacktestConfig) -> str:
    return hashlib.sha256(cfg.model_dump_json().encode()).hexdigest()[:16]


class Trade(BaseModel):
    session: date
    expiry: str
    entry_at: datetime
    exit_at: datetime
    entry_spot: float | None
    exit_spot: float | None
    legs: list[dict[str, Any]]
    gross: float
    costs: float
    net: float
    exit_reason: Literal["stop_loss", "target", "time"]
    minutes_held: float
    samples_skipped_missing_price: int


def _limit(mode: Mode, value: float, premium_abs: float) -> float:
    return value if mode == "rupees" else premium_abs * value / 100


def backtest(obs: ObservationStore, cfg: BacktestConfig) -> dict[str, Any]:
    u = cfg.underlying
    counts = obs.session_sample_counts(u)
    days = sorted(d for d, n in counts.items() if n >= MIN_SAMPLES_PER_SESSION)
    thin = sorted(d for d, n in counts.items() if n < MIN_SAMPLES_PER_SESSION)
    if cfg.start:
        days = [d for d in days if d >= str(cfg.start)]
    if cfg.end:
        days = [d for d in days if d <= str(cfg.end)]
    entry_t, exit_t = _t(cfg.entry_time), _t(cfg.exit_time)
    problems: list[str] = []
    if not (SESSION_OPEN <= entry_t < exit_t <= SESSION_CLOSE):
        problems.append(f"entry and exit must satisfy {SESSION_OPEN:%H:%M} <= entry < exit <= {SESSION_CLOSE:%H:%M}")
    trades: list[Trade] = []
    skipped: list[dict[str, str]] = [{"session": d, "reason": f"only {counts[d]} stored samples (needs {MIN_SAMPLES_PER_SESSION})"} for d in thin]
    unpriced: list[dict[str, str]] = []
    lot = cfg.lot_size
    for d in ([] if problems else days):
        day = date.fromisoformat(d)
        lo = datetime.combine(day, time(0, 0), IST).astimezone(UTC)
        hi = lo + timedelta(days=1)
        expiries = sorted(e for e, _ in obs.day_counts(u, int(lo.timestamp() * 1000), int(hi.timestamp() * 1000)) if e >= d)
        if not expiries or (cfg.expiry == "next" and len(expiries) < 2):
            skipped.append({"session": d, "reason": f"no stored {cfg.expiry} expiry on or after this date"})
            continue
        expiry = expiries[0] if cfg.expiry == "nearest" else expiries[1]
        samples = [s for s in obs.samples(u, expiry, since=lo, until=hi) if SESSION_OPEN <= s.received_at.astimezone(IST).time() <= SESSION_CLOSE]
        cache: dict[int, dict[tuple[float, int], Contract]] = {}

        def chain(s: Sample, cache: dict[int, dict[tuple[float, int], Contract]] = cache) -> dict[tuple[float, int], Contract]:
            if s.values_from not in cache:
                cache[s.values_from] = obs.contracts(s.values_from)
            return cache[s.values_from]

        wait = timedelta(minutes=cfg.max_wait_minutes)
        entry_candidates = [s for s in samples if entry_t <= s.received_at.astimezone(IST).time() and s.received_at.astimezone(IST) <= datetime.combine(day, entry_t, IST) + wait]
        entry = None
        picked: list[tuple[LegSpec, float, float]] = []
        for s in entry_candidates:
            c = chain(s)
            if s.spot is None:
                continue
            strikes = sorted({k for k, _ in c})
            if not strikes:
                continue
            spot_now = s.spot
            atm_i = strikes.index(min(strikes, key=lambda k: abs(k - spot_now)))
            legs_try: list[tuple[LegSpec, float, float]] = []
            ok = True
            for lg in cfg.legs:
                j = atm_i + lg.offset_steps
                if j < 0 or j >= len(strikes):
                    ok = False
                    break
                k = strikes[j]
                p_in = _ltp(c, k, CALL if lg.type == "CE" else PUT)
                if p_in is None:
                    ok = False
                    break
                legs_try.append((lg, k, p_in))
            if ok:
                entry, picked = s, legs_try
                break
        if entry is None:
            skipped.append({"session": d, "reason": f"no sample within {cfg.max_wait_minutes} min of {cfg.entry_time} with a price for every leg"})
            continue
        size = lot or _lot_size(obs, entry)
        if size is None:
            skipped.append({"session": d, "reason": "no lot size stored for this session and none given"})
            continue
        premium_abs = sum(p_in * lg.lots * size for lg, _, p_in in picked)
        sl = _limit(cfg.stop_loss.mode, cfg.stop_loss.value, premium_abs) if cfg.stop_loss else None
        tp = _limit(cfg.target.mode, cfg.target.value, premium_abs) if cfg.target else None
        exit_s: Sample | None = None
        reason = "time"
        exit_px: dict[tuple[float, str], float] = {}
        miss = 0
        exit_deadline = datetime.combine(day, exit_t, IST)
        for s in samples:
            if s.received_at <= entry.received_at:
                continue
            at = s.received_at.astimezone(IST)
            c = chain(s)
            raw = {(k, lg.type): _ltp(c, k, CALL if lg.type == "CE" else PUT) for lg, k, _ in picked}
            px: dict[tuple[float, str], float] = {key: v for key, v in raw.items() if v is not None}
            if len(px) != len(raw):
                if at <= exit_deadline:
                    miss += 1
                continue
            mtm = sum((1 if lg.action == "BUY" else -1) * (px[(k, lg.type)] - p0) * lg.lots * size for lg, k, p0 in picked)
            if at < exit_deadline:
                if sl is not None and mtm <= -sl:
                    exit_s, reason, exit_px = s, "stop_loss", px
                    break
                if tp is not None and mtm >= tp:
                    exit_s, reason, exit_px = s, "target", px
                    break
            elif exit_s is None:
                exit_s, reason, exit_px = s, "time", px
                break
        if exit_s is None:
            unpriced.append({"session": d, "reason": f"no priced sample at or after {cfg.exit_time}: the trade could not be closed on stored data"})
            continue
        legs_out: list[dict[str, Any]] = []
        gross = costs = 0.0
        for lg, k, p0 in picked:
            p1 = exit_px[(k, lg.type)]
            units = lg.lots * size
            sgn = 1 if lg.action == "BUY" else -1
            gross += sgn * (p1 - p0) * units
            costs += execution_cost(lg.action, p0, units, cfg.costs) + execution_cost("SELL" if lg.action == "BUY" else "BUY", p1, units, cfg.costs)
            legs_out.append({"type": lg.type, "action": lg.action, "strike": k, "lots": lg.lots, "entry": p0, "exit": p1})
        trades.append(Trade(
            session=day, expiry=expiry, entry_at=entry.received_at, exit_at=exit_s.received_at, entry_spot=entry.spot, exit_spot=exit_s.spot,
            legs=legs_out, gross=round(gross, 2), costs=round(costs, 2), net=round(gross - costs, 2), exit_reason=reason,  # type: ignore[arg-type]
            minutes_held=round((exit_s.received_at - entry.received_at).total_seconds() / 60, 1), samples_skipped_missing_price=miss,
        ))
    return _report(obs, cfg, trades, skipped, unpriced, days, counts, problems)


def _lot_size(obs: ObservationStore, s: Sample) -> int | None:
    return obs.lot_size(s.sample_id)


def _metrics(net: list[float], gross: list[float]) -> dict[str, Any]:
    wins = [x for x in net if x > 0]
    losses = [x for x in net if x < 0]
    eq, peak, dd = 0.0, 0.0, 0.0
    for x in net:
        eq += x
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
    return {
        "trades": len(net), "wins": len(wins), "losses": len(losses),
        "win_rate": round(len(wins) / len(net) * 100, 1) if net else None,
        "gross_pnl": round(sum(gross), 2), "net_pnl": round(sum(net), 2),
        "avg_win": round(sum(wins) / len(wins), 2) if wins else None,
        "avg_loss": round(sum(losses) / len(losses), 2) if losses else None,
        "avg_trade": round(sum(net) / len(net), 2) if net else None,
        "profit_factor": round(sum(wins) / -sum(losses), 2) if losses else None,
        "max_drawdown": round(dd, 2),
        "largest_win": max(wins) if wins else None, "largest_loss": min(losses) if losses else None,
    }


def _report(obs: ObservationStore, cfg: BacktestConfig, trades: list[Trade], skipped: list[dict[str, str]], unpriced: list[dict[str, str]],
            days: list[str], counts: dict[str, int], problems: list[str]) -> dict[str, Any]:
    net = [t.net for t in trades]
    gross = [t.gross for t in trades]
    m = _metrics(net, gross)
    m["avg_minutes_held"] = round(sum(t.minutes_held for t in trades) / len(trades), 1) if trades else None
    m["sharpe_note"] = (
        f"not computed: {len(trades)} trades; a ratio needs at least {MIN_TRADES_FOR_CONCLUSION} to mean anything" if len(trades) < MIN_TRADES_FOR_CONCLUSION else None
    )
    eq = 0.0
    curve = []
    for t in trades:
        eq += t.net
        curve.append({"at": t.exit_at.isoformat(), "session": str(t.session), "equity": round(eq, 2)})
    by_month: dict[str, float] = {}
    for t in trades:
        k = f"{t.session:%Y-%m}"
        by_month[k] = round(by_month.get(k, 0.0) + t.net, 2)
    by_year: dict[str, float] = {}
    for t in trades:
        by_year[str(t.session.year)] = round(by_year.get(str(t.session.year), 0.0) + t.net, 2)

    def bucket(name: str, key: Any) -> dict[str, Any]:
        groups: dict[str, list[Trade]] = {}
        for t in trades:
            groups.setdefault(key(t), []).append(t)
        return {k: {"n": len(v), "net_pnl": round(sum(x.net for x in v), 2), "win_rate": round(sum(1 for x in v if x.net > 0) / len(v) * 100, 1),
                    "enough_data": len(v) >= MIN_TRADES_FOR_CONCLUSION} for k, v in sorted(groups.items())}

    def direction(t: Trade) -> str:
        if t.entry_spot is None or t.exit_spot is None:
            return "unknown"
        return "NIFTY rose" if t.exit_spot > t.entry_spot else "NIFTY fell" if t.exit_spot < t.entry_spot else "flat"

    first = days[0] if days else None
    last = days[-1] if days else None
    sess_n = len({t.session for t in trades})
    warnings = list(problems)
    if len(trades) < MIN_TRADES_FOR_CONCLUSION:
        warnings.append(f"{len(trades)} trades over {sess_n} stored session(s): this shows the mechanics, not a durable edge. At least {MIN_TRADES_FOR_CONCLUSION} trades are needed before any conclusion.")
    warnings.append("Prices are stored last-traded prices, about one per minute; there is no bid/ask, so fills carry no spread except the slippage you set. A move between two samples is not seen.")
    data_fp = hashlib.sha256(json.dumps([sorted(counts.items()), obs.last_sample_id()]).encode()).hexdigest()[:16]
    return {
        "config": cfg.model_dump(mode="json"), "config_hash": _config_hash(cfg), "data_fingerprint": data_fp,
        "data": {"sessions_with_enough_samples": days, "first": first, "last": last, "samples_per_session": counts, "min_samples_per_session": MIN_SAMPLES_PER_SESSION,
                 "price_source": "stored last traded prices (Kotak option chain, ~1 per minute in market hours)", "history_starts": min(counts) if counts else None},
        "metrics": m, "trades": [t.model_dump(mode="json") for t in trades], "equity_curve": curve,
        "monthly_net": by_month, "yearly_net": by_year,
        "by_expiry_day": bucket("expiry_day", lambda t: "expiry day" if str(t.session) == t.expiry else "before expiry"),
        "by_day_direction": bucket("direction", direction),
        "regime_note": "The day-direction split describes the day after the fact; it is not a signal known at entry.",
        "skipped_sessions": skipped, "unpriced_sessions": unpriced, "warnings": warnings,
    }
