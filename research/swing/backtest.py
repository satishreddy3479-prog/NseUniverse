"""Event-driven daily backtest of the Institutional Swing engine (spec chapters 7-11).

Timeline per bar i: (1) manage open positions (stop / Day-1 rules), (2) enter from signals
computed at the close of bar i-1, (3) mark to market. Nothing computed on bar i is used
before bar i.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd


@dataclass
class Params:
    capital: float = 1_000_000.0
    slots: int = 5
    risk_pct: float = 0.02
    min_score: float = 65.0
    dist_min: float = -4.0   # signal window: distance of close to pivot (%)
    dist_max: float = 0.8
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
    cost_per_side: float = 0.0  # fraction of traded value, each side
    day1_cuts: bool = True      # diagnostic switch; the spec rules are on
    require_volume: bool = True  # diagnostic switch; the spec rules are on
    tie_break: str = "alpha"  # equal-score order: alpha (symbol order), dist, mrs, random; t1_volume/t1_return use NEXT-day data (probes only)
    tie_seed: int = 0
    sl_anchor: str = "signal_close"  # 5.5 % floor vs the signal bar's close (original engine); "fill" = vs the fill
    day1_stop: bool = True      # diagnostic switch; the spec rule is on
    same_bar_trail: bool = False  # diagnostic ONLY: trail with today's high before testing today's low (look-ahead)


@dataclass
class Trade:
    symbol: str
    sector: str
    archetype: str
    score: float
    signal_date: pd.Timestamp
    entry_date: pd.Timestamp
    entry: float
    pivot: float
    initial_sl: float
    shares: int
    exit_date: pd.Timestamp | None = None
    exit: float = np.nan
    reason: str = ""
    pnl: float = 0.0
    r_mult: float = np.nan
    hold_days: int = 0
    extra: dict = field(default_factory=dict)


def run(
    frames: dict[str, pd.DataFrame],
    eligible: dict[str, pd.Series],
    sector_of: dict[str, str],
    calendar: pd.DatetimeIndex,
    p: Params,
) -> tuple[list[Trade], pd.Series]:
    """frames: indicator frames; eligible: bool Series per symbol (gates passed at close of t)."""
    syms = list(frames)
    n = len(calendar)
    a = {k: np.full((len(syms), n), np.nan) for k in
         ("Open", "High", "Low", "Close", "Volume", "atr14", "ema10", "vol_sma20", "pivot", "score", "mrs")}
    elig = np.zeros((len(syms), n), dtype=bool)
    arche = np.full((len(syms), n), "", dtype=object)
    for si, s in enumerate(syms):
        f = frames[s].reindex(calendar)
        for k in a:
            if k in f:  # `mrs` is only needed for the mrs tie-break
                a[k][si] = f[k].to_numpy(dtype=float)
        sc = f["score"].to_numpy()
        d = f["dist"].to_numpy()
        e = eligible[s].reindex(calendar).fillna(False).to_numpy(dtype=bool)
        elig[si] = e & (sc >= p.min_score) & (d >= p.dist_min) & (d <= p.dist_max)
        arche[si] = f["archetype"].to_numpy(dtype=object)

    tie_rng = np.random.default_rng(p.tie_seed)
    cash = p.capital
    open_pos: dict[int, dict] = {}
    last_exit: dict[int, int] = {}
    closed: list[Trade] = []
    equity = np.full(n, np.nan)
    equity[0] = p.capital
    cost = p.cost_per_side

    def close_pos(si: int, i: int, px: float, reason: str) -> None:
        nonlocal cash
        pos = open_pos.pop(si)
        t: Trade = pos["trade"]
        cash += t.shares * px * (1 - cost)
        t.exit_date, t.exit, t.reason = calendar[i], px, reason
        t.pnl = t.shares * (px * (1 - cost) - t.entry * (1 + cost))
        risk = t.entry - t.initial_sl
        t.r_mult = (px - t.entry) / risk if risk > 0 else np.nan
        t.hold_days = i - pos["entry_i"]
        closed.append(t)
        last_exit[si] = i

    def mtm(i: int) -> float:
        val = cash
        for si, pos in open_pos.items():
            px = a["Close"][si, i]
            if np.isnan(px):  # carry last known close, only for valuation
                px = pos["last_close"]
            val += pos["trade"].shares * px
        return val

    for i in range(1, n):
        # (1) existing positions: stop check against the stop set at the prior close
        for si in list(open_pos):
            pos = open_pos[si]
            if pos["entry_i"] == i:
                continue
            o, h, low, c = (a[k][si, i] for k in ("Open", "High", "Low", "Close"))
            if np.isnan(c):
                continue
            if p.same_bar_trail:
                _update_stop(pos, h, a["atr14"][si, i], a["ema10"][si, i], p)
            tsl = pos["tsl"]
            if o <= tsl:
                close_pos(si, i, o, "STOP_GAP")
                continue
            if low <= tsl:
                close_pos(si, i, tsl, "STOP")
                continue
            _update_stop(pos, h, a["atr14"][si, i], a["ema10"][si, i], p)
            pos["last_close"] = c

        # (2) entries from yesterday's signals, best score first
        if len(open_pos) < p.slots:
            cand = [si for si in np.flatnonzero(elig[:, i - 1]) if si not in open_pos
                    and i - last_exit.get(si, -99) >= p.cooldown]
            cand.sort(key=lambda si: (-a["score"][si, i - 1], _secondary(a, si, i, p, tie_rng)))
            eq_prev = equity[i - 1]
            for si in cand:
                if len(open_pos) >= p.slots:
                    break
                o, h, low, c, v = (a[k][si, i] for k in ("Open", "High", "Low", "Close", "Volume"))
                if np.isnan(o) or np.isnan(c):
                    continue
                pv = a["pivot"][si, i - 1]
                trig = pv * p.trigger_buf
                if o > pv * p.max_open_gap or h < trig:
                    continue
                if p.require_volume and not v >= p.vol_mult * a["vol_sma20"][si, i - 1]:
                    continue
                fill = max(o, trig)
                base = a["Close"][si, i - 1] if p.sl_anchor == "signal_close" else fill
                sl = max(pv - p.atr_sl_mult * a["atr14"][si, i - 1], base * p.max_risk_frac)
                risk = fill - sl
                if risk <= 0:
                    continue
                shares = int(min(eq_prev * p.risk_pct / risk, eq_prev / p.slots / fill))
                shares = min(shares, int(cash / (fill * (1 + cost))))
                if shares < 1:
                    continue
                cash -= shares * fill * (1 + cost)
                tr = Trade(syms[si], sector_of.get(syms[si], ""), str(arche[si, i - 1]),
                           float(a["score"][si, i - 1]), calendar[i - 1], calendar[i], fill, pv,
                           sl, shares)
                open_pos[si] = {"trade": tr, "entry_i": i, "tsl": sl, "hh": h, "fill": fill,
                                "r": risk, "last_close": c}
                # Day-1 cut rules (chapter 8)
                if p.day1_stop and low <= sl:
                    close_pos(si, i, sl, "D1_STOP")
                elif p.day1_cuts and c < pv:
                    close_pos(si, i, c, "D1_FAIL_CLOSE")
                elif p.day1_cuts and h > low and (c - low) / (h - low) < 0.35:
                    close_pos(si, i, c, "D1_REJECT_WICK")
                else:
                    _update_stop(open_pos[si], h, a["atr14"][si, i], a["ema10"][si, i], p)

        equity[i] = mtm(i)

    last = n - 1
    for si in list(open_pos):  # still open on the last bar: marked at the last close
        px = a["Close"][si, last]
        close_pos(si, last, open_pos[si]["last_close"] if np.isnan(px) else px, "OPEN_AT_END")
    equity[0] = p.capital
    return closed, pd.Series(equity, index=calendar).ffill()


def _secondary(a: dict, si: int, i: int, p: Params, rng: np.random.Generator) -> float:
    if p.tie_break == "dist":
        return -a["Close"][si, i - 1] / a["pivot"][si, i - 1]
    if p.tie_break == "mrs":
        return -a["mrs"][si, i - 1]
    if p.tie_break == "random":
        return float(rng.random())
    if p.tie_break == "t1_volume":  # look-ahead probe
        return -a["Volume"][si, i] / a["vol_sma20"][si, i - 1]
    if p.tie_break == "t1_return":  # look-ahead probe
        return -a["Close"][si, i] / a["Close"][si, i - 1]
    return 0.0


def _update_stop(pos: dict, high: float, atr: float, ema10: float, p: Params) -> None:
    pos["hh"] = max(pos["hh"], high)
    gain_r = (pos["hh"] - pos["fill"]) / pos["r"]
    if gain_r >= p.trail_r:
        cands = [pos["tsl"], pos["hh"] - p.chand_mult * atr, ema10, pos["fill"] * p.be_buf]
        pos["tsl"] = max(x for x in cands if not np.isnan(x))
    elif gain_r >= p.be_r:
        pos["tsl"] = max(pos["tsl"], pos["fill"] * p.be_buf)


def metrics(trades: list[Trade], equity: pd.Series, capital: float, bench: pd.Series) -> dict:
    eq = equity.dropna()
    years = (eq.index[-1] - eq.index[0]).days / 365.25
    final = float(eq.iloc[-1])
    cagr = (final / capital) ** (1 / years) - 1
    dd = (eq / eq.cummax() - 1).min()
    ret = eq.pct_change().dropna()
    sharpe = ret.mean() / ret.std() * np.sqrt(252) if ret.std() > 0 else np.nan
    pnl = np.array([t.pnl for t in trades])
    wins, losses = pnl[pnl > 0], pnl[pnl <= 0]
    holds = lambda sel: float(np.mean([t.hold_days for t, x in zip(trades, pnl, strict=True)
                                       if sel(x)])) if len(pnl) else np.nan
    b = bench.reindex(eq.index).ffill().dropna()
    return {
        "bars": len(eq), "years": round(years, 2), "final_equity": round(final, 2),
        "net_profit": round(final - capital, 2), "return_pct": round((final / capital - 1) * 100, 2),
        "cagr_pct": round(cagr * 100, 2), "max_drawdown_pct": round(-dd * 100, 2),
        "calmar": round(cagr / -dd, 2) if dd < 0 else np.nan, "sharpe_rf0": round(float(sharpe), 2),
        "trades": len(trades), "wins": int((pnl > 0).sum()),
        "win_rate_pct": round(float((pnl > 0).mean() * 100), 1) if len(pnl) else np.nan,
        "avg_win_over_avg_loss": round(float(wins.mean() / -losses.mean()), 2)
        if len(wins) and len(losses) else np.nan,
        "profit_factor": round(float(wins.sum() / -losses.sum()), 2) if losses.sum() else np.nan,
        "avg_r": round(float(np.nanmean([t.r_mult for t in trades])), 2) if trades else np.nan,
        "avg_hold_win": round(holds(lambda x: x > 0), 1), "avg_hold_loss": round(holds(lambda x: x <= 0), 1),
        "nifty_return_pct": round(float((b.iloc[-1] / b.iloc[0] - 1) * 100), 2),
        "nifty_cagr_pct": round(float(((b.iloc[-1] / b.iloc[0]) ** (1 / years) - 1) * 100), 2),
    }


def trades_frame(trades: list[Trade]) -> pd.DataFrame:
    rows = [{k: v for k, v in asdict(t).items() if k != "extra"} for t in trades]
    return pd.DataFrame(rows)
