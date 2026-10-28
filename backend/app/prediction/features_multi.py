"""Horizon-specific point-in-time feature sets (``t1-v1`` overnight, ``t5-v1`` broad).

Rule for every outside series: for reference session ``t`` only bars dated on or before ``t`` are
used. All of them are complete by 08:30 IST on the next session (US cash close 01:30/02:30 IST,
commodity settlements, Europe 21:00-22:00 IST, Asia and Indian closes during day ``t``), which is
the forecast cutoff. ``tests`` check that altering any later bar changes nothing. NSE participant
files are used only for sessions on or before ``t`` (published after the close).
"""

from __future__ import annotations

import bisect
import math
from collections.abc import Callable
from datetime import date

from app.prediction.targets import Bar

T1_VERSION = "t1-v1"
T5_VERSION = "t5-v1"
SECTORS = ("NIFTYBANK", "NIFTYIT", "NIFTYAUTO", "NIFTYPHARMA", "NIFTYFMCG", "NIFTYMETAL", "NIFTYENERGY", "NIFTYREALTY")

T1_NAMES: tuple[str, ...] = (
    "nifty_ret_1d", "nifty_gap_today", "nifty_open_to_close", "nifty_close_position", "nifty_range", "nifty_vol_10d",
    "nifty_ret_5d", "nifty_dist_sma20", "indiavix_ln", "indiavix_chg_1d",
    "spx_ret", "ndx_ret", "dji_ret", "usvix_ln", "usvix_chg",
    "brent_ret", "gold_ret", "dxy_ret", "usdinr_ret", "ust10y_chg",
    "n225_ret", "hsi_ret", "ssec_ret", "dax_ret", "ftse_ret", "next_is_monday",
)  # fmt: skip
T1_CORE = ("spx_ret", "ndx_ret", "usvix_chg", "brent_ret", "dxy_ret", "usdinr_ret", "ust10y_chg", "nifty_ret_1d")

T5_NAMES: tuple[str, ...] = (
    "nifty_ret_1d", "nifty_ret_5d", "nifty_ret_20d", "nifty_gap_today", "nifty_open_to_close", "nifty_close_position",
    "nifty_range", "nifty_vol_10d", "nifty_vol_20d", "nifty_vol_ratio_10_60", "nifty_dist_sma20", "nifty_dist_sma50",
    "nifty_drawdown_60d", "indiavix_ln", "indiavix_chg_5d", "indiavix_vs_60d",
    *(f"rs20_{s.removeprefix('NIFTY').lower()}" for s in SECTORS), "sectors_above_sma20",
    "spx_ret_5d", "spx_ret_20d", "spx_dist_sma50", "usvix_ln", "ndx_ret_20d",
    "dxy_ret_20d", "usdinr_ret_5d", "usdinr_ret_20d", "brent_ret_5d", "brent_ret_20d",
    "ust10y_chg_5d", "ust10y_chg_20d", "gold_ret_20d", "n225_ret_5d", "hsi_ret_5d", "dax_ret_5d",
)  # fmt: skip
T5_CORE = ("nifty_ret_5d", "nifty_vol_ratio_10_60", "nifty_dist_sma50", "nifty_drawdown_60d", "indiavix_vs_60d", "sectors_above_sma20", "spx_ret_20d", "usdinr_ret_20d", "brent_ret_20d")
FLOW_NAMES: tuple[str, ...] = (
    "fii_net_fut_share", "fii_net_fut_share_chg_5d", "dii_net_fut_share", "pro_net_fut_share", "client_net_fut_share",
    "fii_net_call_share", "fii_net_put_share",
)  # fmt: skip


class Series:
    """Daily closes of one series with as-of lookups (never looks past the asked date)."""

    def __init__(self, bars: list[Bar]) -> None:
        self.dates = [b.session for b in sorted(bars, key=lambda b: b.session)]
        by = {b.session: b for b in bars}
        self.bars = [by[d] for d in self.dates]
        self.closes = [b.close for b in self.bars]

    def idx(self, t: date, max_stale_days: int = 5) -> int | None:
        i = bisect.bisect_right(self.dates, t) - 1
        if i < 0 or (t - self.dates[i]).days > max_stale_days:
            return None
        return i

    def ret(self, t: date, k: int = 1) -> float | None:
        i = self.idx(t)
        return None if i is None or i - k < 0 else self.closes[i] / self.closes[i - k] - 1

    def diff(self, t: date, k: int = 1) -> float | None:
        i = self.idx(t)
        return None if i is None or i - k < 0 else self.closes[i] - self.closes[i - k]

    def level(self, t: date) -> float | None:
        i = self.idx(t)
        return None if i is None else self.closes[i]

    def dist_sma(self, t: date, n: int) -> float | None:
        i = self.idx(t)
        return None if i is None or i - n + 1 < 0 else self.closes[i] / (sum(self.closes[i - n + 1 : i + 1]) / n) - 1

    def ratio_to_mean(self, t: date, n: int) -> float | None:
        return self.dist_sma(t, n)


def _ln(v: float | None) -> float | None:
    return None if v is None or v <= 0 else math.log(v)


def _std(xs: list[float]) -> float:
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def _nifty_block(nifty: list[Bar], i: int) -> dict[str, float]:
    b, closes = nifty[i], [x.close for x in nifty]
    c = b.close
    rets = [closes[j] / closes[j - 1] - 1 for j in range(max(1, i - 59), i + 1)]
    span = b.high - b.low
    out = {
        "nifty_ret_1d": rets[-1], "nifty_gap_today": b.open / closes[i - 1] - 1, "nifty_open_to_close": c / b.open - 1,
        "nifty_close_position": (c - b.low) / span if span > 0 else 0.5, "nifty_range": span / c,
        "nifty_ret_5d": c / closes[i - 5] - 1, "nifty_dist_sma20": c / (sum(closes[i - 19 : i + 1]) / 20) - 1,
    }  # fmt: skip
    if i >= 60:
        vol10, vol20, vol60 = _std(rets[-10:]), _std(rets[-20:]), _std(rets[-60:])
        out.update(
            nifty_vol_10d=vol10, nifty_vol_20d=vol20, nifty_vol_ratio_10_60=vol10 / vol60 if vol60 > 0 else 1.0,
            nifty_ret_20d=c / closes[i - 20] - 1, nifty_dist_sma50=c / (sum(closes[i - 49 : i + 1]) / 50) - 1,
            nifty_drawdown_60d=c / max(closes[i - 59 : i + 1]) - 1,
        )  # fmt: skip
    elif i >= 10:
        out["nifty_vol_10d"] = _std(rets[-10:])
    return out


def build_rows(
    nifty: list[Bar], others: dict[str, list[Bar]], horizon: str,
    flows: dict[date, dict[str, dict[str, int]]] | None = None, with_flows: bool = False,
) -> tuple[list[str], dict[date, list[float]]]:  # fmt: skip
    """Feature rows keyed by reference session. Rows with any missing feature are dropped, never filled."""
    S = {k: Series(v) for k, v in others.items() if v}
    names = list(T1_NAMES if horizon == "T1" else T5_NAMES) + (list(FLOW_NAMES) if with_flows else [])
    flow_days = sorted(flows or {})
    rows: dict[date, list[float]] = {}
    for i in range(61, len(nifty)):
        t = nifty[i].session
        f: dict[str, float | None] = dict(_nifty_block(nifty, i))

        def g(key: str, fn: Callable[[Series], float | None]) -> float | None:
            return fn(S[key]) if key in S else None

        if horizon == "T1":
            f.update(
                indiavix_ln=g("INDIAVIX", lambda s: _ln(s.level(t))), indiavix_chg_1d=g("INDIAVIX", lambda s: s.ret(t)),
                spx_ret=g("SPX", lambda s: s.ret(t)), ndx_ret=g("NDX_COMP", lambda s: s.ret(t)), dji_ret=g("DJI", lambda s: s.ret(t)),
                usvix_ln=g("VIX", lambda s: _ln(s.level(t))), usvix_chg=g("VIX", lambda s: s.ret(t)),
                brent_ret=g("BRENT", lambda s: s.ret(t)), gold_ret=g("GOLD", lambda s: s.ret(t)), dxy_ret=g("DXY", lambda s: s.ret(t)),
                usdinr_ret=g("USDINR", lambda s: s.ret(t)), ust10y_chg=g("UST10Y", lambda s: s.diff(t)),
                n225_ret=g("N225", lambda s: s.ret(t)), hsi_ret=g("HSI", lambda s: s.ret(t)), ssec_ret=g("SSEC", lambda s: s.ret(t)),
                dax_ret=g("DAX", lambda s: s.ret(t)), ftse_ret=g("FTSE", lambda s: s.ret(t)),
                next_is_monday=1.0 if t.weekday() == 4 else 0.0,
            )  # fmt: skip
        else:
            f.update(
                indiavix_ln=g("INDIAVIX", lambda s: _ln(s.level(t))), indiavix_chg_5d=g("INDIAVIX", lambda s: s.ret(t, 5)),
                indiavix_vs_60d=g("INDIAVIX", lambda s: s.ratio_to_mean(t, 60)),
                spx_ret_5d=g("SPX", lambda s: s.ret(t, 5)), spx_ret_20d=g("SPX", lambda s: s.ret(t, 20)),
                spx_dist_sma50=g("SPX", lambda s: s.dist_sma(t, 50)), usvix_ln=g("VIX", lambda s: _ln(s.level(t))),
                ndx_ret_20d=g("NDX_COMP", lambda s: s.ret(t, 20)), dxy_ret_20d=g("DXY", lambda s: s.ret(t, 20)),
                usdinr_ret_5d=g("USDINR", lambda s: s.ret(t, 5)), usdinr_ret_20d=g("USDINR", lambda s: s.ret(t, 20)),
                brent_ret_5d=g("BRENT", lambda s: s.ret(t, 5)), brent_ret_20d=g("BRENT", lambda s: s.ret(t, 20)),
                ust10y_chg_5d=g("UST10Y", lambda s: s.diff(t, 5)), ust10y_chg_20d=g("UST10Y", lambda s: s.diff(t, 20)),
                gold_ret_20d=g("GOLD", lambda s: s.ret(t, 20)), n225_ret_5d=g("N225", lambda s: s.ret(t, 5)),
                hsi_ret_5d=g("HSI", lambda s: s.ret(t, 5)), dax_ret_5d=g("DAX", lambda s: s.ret(t, 5)),
            )  # fmt: skip
            nifty20 = f.get("nifty_ret_20d")
            above = 0
            for sec in SECTORS:
                r20 = g(sec, lambda s: s.ret(t, 20))
                f[f"rs20_{sec.removeprefix('NIFTY').lower()}"] = None if r20 is None or nifty20 is None else r20 - nifty20
                d = g(sec, lambda s: s.dist_sma(t, 20))
                above += 1 if d is not None and d > 0 else 0
            f["sectors_above_sma20"] = float(above)
        if with_flows:
            f.update(_flow_features(flows or {}, flow_days, t))
        row = [f.get(n) for n in names]
        if all(v is not None and math.isfinite(v) for v in row):
            rows[t] = [float(v) for v in row if v is not None]
    return names, rows


def _share(m: dict[str, int], long: str, short: str, tot: int) -> float:
    return (m[long] - m[short]) / tot if tot else 0.0


def _flow_features(flows: dict[date, dict[str, dict[str, int]]], days: list[date], t: date) -> dict[str, float | None]:
    i = bisect.bisect_right(days, t) - 1
    if i < 5 or (t - days[i]).days > 4:  # need today's file and one from five sessions earlier
        return {n: None for n in FLOW_NAMES}
    d0, d5 = flows[days[i]], flows[days[i - 5]]
    tot = d0["TOTAL"]["Future Index Long"]
    tot5 = d5["TOTAL"]["Future Index Long"]
    fl, fs = "Future Index Long", "Future Index Short"
    ocl, ocs, opl, ops = "Option Index Call Long", "Option Index Call Short", "Option Index Put Long", "Option Index Put Short"
    ot = d0["TOTAL"][ocl] + d0["TOTAL"][opl]
    return {
        "fii_net_fut_share": _share(d0["FII"], fl, fs, tot),
        "fii_net_fut_share_chg_5d": _share(d0["FII"], fl, fs, tot) - _share(d5["FII"], fl, fs, tot5),
        "dii_net_fut_share": _share(d0["DII"], fl, fs, tot), "pro_net_fut_share": _share(d0["Pro"], fl, fs, tot),
        "client_net_fut_share": _share(d0["Client"], fl, fs, tot),
        "fii_net_call_share": _share(d0["FII"], ocl, ocs, ot), "fii_net_put_share": _share(d0["FII"], opl, ops, ot),
    }  # fmt: skip
