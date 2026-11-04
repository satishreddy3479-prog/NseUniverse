"""Swing paper-trading rules as pure functions (no I/O, no clock, no pandas).

Mirrors research/swing/backtest.py. One call to ``settle_session`` takes one finished session's bars
and the orders queued at the previous close, and returns what happened. Nothing here places a real
order: fills are simulated on the daily bar (stop assumed first when both levels trade in one bar).
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from app.swing.indicators import Setup

RULE_VERSION = "swing-v1"
MIN_DIST, MAX_DIST = -4.0, 0.8


@dataclass(frozen=True)
class Config:
    capital: float = 1_000_000.0
    slots: int = 5
    risk_pct: float = 0.02
    min_score: float = 65.0
    trigger_buf: float = 1.003
    vol_mult: float = 1.25
    max_open_gap: float = 1.025
    atr_sl_mult: float = 1.5
    max_risk_frac: float = 0.945
    be_r: float = 1.8
    trail_r: float = 2.5
    be_buf: float = 1.002
    chand_mult: float = 2.5
    cooldown: int = 3
    cost_per_side: float = 0.0015


@dataclass(frozen=True)
class Bar:
    date: str
    o: float
    h: float
    low: float
    c: float
    v: float


@dataclass(frozen=True)
class Order:
    """Queued at the close of `session`; judged on the next session's bar."""

    session: str
    symbol: str
    sector: str
    archetype: str
    score: float
    pillars: tuple[int, int, int, int]
    close: float
    dist_pct: float
    pivot: float
    trigger: float
    max_open: float
    initial_sl: float
    risk_pct: float
    atr14: float
    min_volume: float
    rank: int = 0
    id: int = 0


@dataclass
class Position:
    symbol: str
    sector: str
    archetype: str
    score: float
    pivot: float
    entry_session: str
    entry_no: int
    fill: float
    shares: int
    initial_sl: float
    tsl: float
    hh: float
    last_close: float
    order_id: int = 0

    @property
    def r(self) -> float:
        return self.fill - self.initial_sl


@dataclass(frozen=True)
class Decision:
    order: Order
    outcome: str   # filled | skipped
    reason: str
    fill: float | None = None
    shares: int | None = None


@dataclass(frozen=True)
class Trade:
    symbol: str
    sector: str
    archetype: str
    score: float
    entry_session: str
    entry: float
    pivot: float
    initial_sl: float
    shares: int
    exit_session: str
    exit: float
    reason: str
    gross_pnl: float
    costs: float
    pnl: float
    r_mult: float | None
    hold_sessions: int
    exit_no: int


@dataclass
class Book:
    cash: float
    equity: float
    positions: dict[str, Position] = field(default_factory=dict)
    last_exit_no: dict[str, int] = field(default_factory=dict)


@dataclass
class Settlement:
    decisions: list[Decision]
    trades: list[Trade]
    equity: float
    cash: float
    invested: float


def make_orders(session: str, setups: dict[str, Setup], sectors: dict[str, str],
                gate_open: dict[str, bool], cfg: Config) -> tuple[list[Order], int]:
    """Orders for the next session from the setups at `session`'s close, best first.
    Returns the orders and how many passed every rule except the market/sector gate."""
    found: list[Order] = []
    blocked = 0
    for sym, s in setups.items():
        if s.pivot is None or s.dist_pct is None or s.atr14 is None or s.vol_sma20 is None:
            continue
        if not (s.score >= cfg.min_score and MIN_DIST <= s.dist_pct <= MAX_DIST):
            continue
        if not gate_open.get(sym, False):
            blocked += 1
            continue
        trigger = s.pivot * cfg.trigger_buf
        stop = max(s.pivot - cfg.atr_sl_mult * s.atr14, s.close * cfg.max_risk_frac)
        found.append(Order(
            session, sym, sectors.get(sym, ""), s.archetype, s.score, s.pillars, s.close, s.dist_pct,
            s.pivot, trigger, s.pivot * cfg.max_open_gap, stop, (trigger - stop) / trigger * 100,
            s.atr14, cfg.vol_mult * s.vol_sma20,
        ))
    found.sort(key=lambda o: (-o.score, o.symbol))
    return [replace(o, rank=i + 1) for i, o in enumerate(found)], blocked


def _update_stop(p: Position, high: float, atr: float | None, ema10: float | None, cfg: Config) -> None:
    p.hh = max(p.hh, high)
    gain_r = (p.hh - p.fill) / p.r
    if gain_r >= cfg.trail_r:
        cands = [p.tsl, p.fill * cfg.be_buf]
        if atr is not None:
            cands.append(p.hh - cfg.chand_mult * atr)
        if ema10 is not None:
            cands.append(ema10)
        p.tsl = max(cands)
    elif gain_r >= cfg.be_r:
        p.tsl = max(p.tsl, p.fill * cfg.be_buf)


def _close(book: Book, p: Position, session: str, no: int, px: float, reason: str, cfg: Config) -> Trade:
    book.positions.pop(p.symbol)
    c = cfg.cost_per_side
    book.cash += p.shares * px * (1 - c)
    book.last_exit_no[p.symbol] = no
    gross = p.shares * (px - p.fill)
    costs = p.shares * (px * c + p.fill * c)
    risk = p.r
    return Trade(p.symbol, p.sector, p.archetype, p.score, p.entry_session, p.fill, p.pivot, p.initial_sl,
                 p.shares, session, px, reason, gross, costs, gross - costs,
                 (px - p.fill) / risk if risk > 0 else None, no - p.entry_no, no)


def settle_session(book: Book, session: str, no: int, bars: dict[str, Bar], setups: dict[str, Setup],
                   orders: list[Order], cfg: Config) -> Settlement:
    """Apply one finished session. `no` is this session's ordinal (cooldowns count sessions)."""
    trades: list[Trade] = []
    decisions: list[Decision] = []

    # 1. open positions: the stop set at the previous close is tested first
    for p in list(book.positions.values()):
        bar = bars.get(p.symbol)
        if bar is None:
            continue
        if bar.o <= p.tsl:
            trades.append(_close(book, p, session, no, bar.o, "STOP_GAP", cfg))
        elif bar.low <= p.tsl:
            trades.append(_close(book, p, session, no, p.tsl, "STOP", cfg))
        else:
            s = setups.get(p.symbol)
            _update_stop(p, bar.h, s.atr14 if s else None, s.ema10 if s else None, cfg)
            p.last_close = bar.c

    # 2. queued orders, best score first (ties: alphabetical, the original engine's order)
    for o in sorted(orders, key=lambda x: (-x.score, x.symbol)):
        if o.symbol in book.positions:
            decisions.append(Decision(o, "skipped", "already holding this stock"))
            continue
        if len(book.positions) >= cfg.slots:
            decisions.append(Decision(o, "skipped", f"all {cfg.slots} slots in use"))
            continue
        if no - book.last_exit_no.get(o.symbol, -99) < cfg.cooldown:
            decisions.append(Decision(o, "skipped", f"{cfg.cooldown}-session cooldown after the last exit"))
            continue
        bar = bars.get(o.symbol)
        if bar is None:
            decisions.append(Decision(o, "skipped", "no price bar for the session"))
            continue
        if bar.o > o.max_open:
            decisions.append(Decision(o, "skipped", f"opened {bar.o:.2f}, above the no-chase limit {o.max_open:.2f}"))
            continue
        if bar.h < o.trigger:
            decisions.append(Decision(o, "skipped", f"never traded through the trigger {o.trigger:.2f} (high {bar.h:.2f})"))
            continue
        if bar.v < o.min_volume:
            decisions.append(Decision(o, "skipped", f"volume {bar.v:,.0f} below the minimum {o.min_volume:,.0f}"))
            continue
        fill = max(bar.o, o.trigger)
        risk = fill - o.initial_sl
        if risk <= 0:
            decisions.append(Decision(o, "skipped", "stop is not below the fill price"))
            continue
        shares = int(min(book.equity * cfg.risk_pct / risk, book.equity / cfg.slots / fill))
        shares = min(shares, int(book.cash / (fill * (1 + cfg.cost_per_side))))
        if shares < 1:
            decisions.append(Decision(o, "skipped", "not enough cash for one share"))
            continue
        book.cash -= shares * fill * (1 + cfg.cost_per_side)
        pos = Position(o.symbol, o.sector, o.archetype, o.score, o.pivot, session, no, fill, shares,
                       o.initial_sl, o.initial_sl, bar.h, bar.c, o.id)
        book.positions[o.symbol] = pos
        decisions.append(Decision(o, "filled", "", fill, shares))
        # day-1 rules (the stop can trigger before any later rule)
        if bar.low <= o.initial_sl:
            trades.append(_close(book, pos, session, no, o.initial_sl, "D1_STOP", cfg))
        elif bar.c < o.pivot:
            trades.append(_close(book, pos, session, no, bar.c, "D1_FAIL_CLOSE", cfg))
        elif bar.h > bar.low and (bar.c - bar.low) / (bar.h - bar.low) < 0.35:
            trades.append(_close(book, pos, session, no, bar.c, "D1_REJECT_WICK", cfg))
        else:
            s = setups.get(o.symbol)
            _update_stop(pos, bar.h, s.atr14 if s else None, s.ema10 if s else None, cfg)

    invested = sum(p.shares * p.last_close for p in book.positions.values())
    book.equity = book.cash + invested
    return Settlement(decisions, trades, book.equity, book.cash, invested)
