"""Master aggregation service of the NIFTY 50 market-intelligence dashboard.

It reads the outputs of the existing services in-process (never over HTTP, never from the browser), each behind a short cache and a
guard so that one failing module marks only its own engine as unavailable. It then fuses them (``fusion.py``), keeps a compact
per-minute timeline and raises de-duplicated alerts from changes between minutes. It computes nothing from raw feeds itself.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time as _time
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.intelligence import fusion as fz
from app.intelligence import heavyweights, rolling, turn, validation, voleval
from app.intelligence.store import IntelligenceStore

logger = logging.getLogger(__name__)
IST = ZoneInfo("Asia/Kolkata")
#: seconds an input is reused before the service is asked again
TTL = {"market": 5.0, "intraday": 15.0, "futures": 15.0, "skew": 30.0, "momentum": 30.0, "positioning": 30.0, "gex": 30.0, "vix": 300.0, "flow": 15.0, "heavymeta": 300.0, "ml": 300.0}
ALERT_COOLDOWN_S = 600.0


def parse_weights(raw: str | None) -> dict[str, float]:
    """Group weights from a JSON object (``{"positioning": 30, ...}``); unknown, missing or invalid entries keep the default. Never raises."""
    w = dict(fz.DEFAULT_WEIGHTS)
    try:
        for k, v in (json.loads(raw) if raw else {}).items():
            if k in w and isinstance(v, (int, float)) and v >= 0:
                w[k] = float(v)
    except (ValueError, AttributeError):
        pass
    return w


def _age(iso: Any, now: datetime) -> float | None:
    try:
        return max(0.0, (now - datetime.fromisoformat(str(iso))).total_seconds())
    except (TypeError, ValueError):
        return None


def rank_percentile(values: list[float | None], window: int) -> dict[str, float | None]:
    """IV rank and percentile of the newest value over the last ``window`` days (the same rule as lib/ivChart.ts ``rankAt``): missing days are
    skipped, and a window with fewer than 80 % of its days gives no figure."""
    i = max((k for k, v in enumerate(values) if v is not None), default=None)
    if i is None or i + 1 < window:
        return {"ivr": None, "ivp": None, "low": None, "high": None}
    win = [v for v in values[max(0, i - window + 1): i + 1] if v is not None]
    if len(win) < window * 0.8:
        return {"ivr": None, "ivp": None, "low": None, "high": None}
    v = float(values[i] or 0.0)
    lo, hi = min(win), max(win)
    return {"ivr": None if hi <= lo else round((v - lo) / (hi - lo) * 100, 1), "ivp": round(sum(1 for x in win if x < v) / len(win) * 100, 1), "low": lo, "high": hi}


class MarketIntelligence:
    def __init__(
        self, *, providers: Mapping[str, Callable[..., Any]], store: IntelligenceStore, default_expiry: Callable[[], str | None],
        clock: Callable[[], datetime] = lambda: datetime.now(UTC), weights: Mapping[str, float] | None = None, enabled: bool = True, vol_config: Any = None,
        live_only: bool = True,
    ) -> None:
        self.providers, self.store, self._default_expiry, self._clock = dict(providers), store, default_expiry, clock
        self.weights = dict(weights or fz.DEFAULT_WEIGHTS)
        self.vol_config = vol_config or voleval.DEFAULT
        self.enabled, self.live_only = enabled, live_only
        self._cache: dict[tuple[str, str], tuple[float, Any, dict[str, Any]]] = {}
        self._summary_cache: tuple[float, str, dict[str, Any]] | None = None
        self._lock = threading.RLock()
        self._task: asyncio.Task[None] | None = None
        self.last_error: str | None = None

    # ------------------------------------------------------------------ inputs
    def _get(self, name: str, expiry: str | None, now: datetime) -> tuple[Any, dict[str, Any]]:
        key = (name, expiry or "")
        hit = self._cache.get(key)
        if hit is not None and _time.monotonic() - hit[0] < TTL[name]:
            return hit[1], hit[2]
        t0 = _time.perf_counter()
        fn = self.providers.get(name)
        data: Any = None
        st: dict[str, Any] = {"ok": False, "age_s": None, "ms": 0.0, "error": None}
        if fn is None:
            st["error"] = "no provider"
        else:
            try:
                data = fn(expiry) if name in ("intraday", "skew", "momentum", "positioning", "gex") else fn()
                st["ok"] = True
            except Exception as e:  # noqa: BLE001 - one failing module must not block the dashboard
                st["error"] = f"{type(e).__name__}: {e}"[:160]
                logger.warning("intelligence_input_failed", extra={"fields": {"input": name, "error": st["error"]}})
                if hit is not None:
                    data = hit[1]  # keep the last good value but say it failed: its age keeps growing and the engine turns stale
        st["ms"] = round((_time.perf_counter() - t0) * 1000, 1)
        st["age_s"] = self._data_age(name, data, now) if data is not None else None
        st["as_of"] = self._as_of(name, data) if data is not None else None
        if st["ok"] or hit is None:
            self._cache[key] = (_time.monotonic(), data, st)
        return data, st

    @staticmethod
    def _as_of(name: str, d: Any) -> str | None:
        """The source's own timestamp (when its data was produced), not when this service read it."""
        pick = {"market": lambda: fz.g(d, "flow", "futures", "updated") or fz.g(d, "generated_at"), "intraday": lambda: fz.g(d, "market", "last_sample_at"),
                "futures": lambda: (fz.g(d, "times") or [None])[-1], "skew": lambda: fz.g(d, "at"), "momentum": lambda: fz.g(d, "latest_at"), "positioning": lambda: fz.g(d, "at"),
                "gex": lambda: (fz.g(d, "points") or [{}])[-1].get("at"), "vix": lambda: (fz.g(d, "dates") or [None])[-1], "flow": lambda: (fz.g(d, "fut") or [[None]])[-1][0], "ml": lambda: fz.g(d, "last_evaluation", "computed_at")}
        try:
            v = pick[name]()
        except (KeyError, IndexError, TypeError, AttributeError):
            return None
        return None if v is None else str(v)

    @staticmethod
    def _data_age(name: str, d: Any, now: datetime) -> float | None:
        if name == "market":
            return fz.num(fz.g(d, "flow", "futures", "age_seconds")) or 0.0
        if name == "intraday":
            return fz.num(fz.g(d, "market", "age_seconds"))
        if name == "futures":
            ts = fz.g(d, "times")
            return _age(ts[-1], now) if isinstance(ts, list) and ts else None
        if name in ("skew", "momentum", "positioning"):
            return fz.num(fz.g(d, "age_seconds"))
        if name == "gex":
            pts = fz.g(d, "points") or []
            return _age(pts[-1].get("at"), now) if pts else None
        if name == "flow":
            fut = fz.g(d, "fut") or []
            return _age(fut[-1][0], now) if fut else None
        return 0.0

    def inputs(self, expiry: str | None) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
        now = self._clock()
        data: dict[str, Any] = {}
        status: dict[str, dict[str, Any]] = {}
        for name in TTL:
            data[name], status[name] = self._get(name, expiry, now)
        # rolling windows come from the per-minute flow samples the market service already stores; nothing new is collected
        data["rolling"] = rolling.futures(fz.g(data["flow"], "fut") or []) if status["flow"]["ok"] else None
        data["heavy"] = heavyweights.assess(data, now)
        data["vol_config"] = self.vol_config
        return data, status

    # ------------------------------------------------------------------ summary
    def summary(self, expiry: str | None = None) -> dict[str, Any]:
        expiry = expiry or self._default_expiry()
        with self._lock:
            hit = self._summary_cache
            if hit is not None and hit[1] == (expiry or "") and _time.monotonic() - hit[0] < 5.0:
                return hit[2]
            out = self._build(expiry)
            self._summary_cache = (_time.monotonic(), expiry or "", out)
            return out

    def _build(self, expiry: str | None) -> dict[str, Any]:
        t0 = _time.perf_counter()
        now = self._clock()
        inp, status = self.inputs(expiry)  # noqa: N806
        engines = fz.build_engines(inp, status)
        fused = fz.fuse(engines, self.weights)
        by = {e["key"]: e for e in engines}
        gx = fz.gex_state(inp)
        reg = fz.regime(fused, by, inp, gx)
        divs, divs_missing = fz.divergences(inp, by, gx)
        spot = fz.num(fz.g(inp["intraday"], "price", "last")) or fz.num(gx.get("spot"))
        session = now.astimezone(IST).date().isoformat()
        hist = self.store.rows(session, 40, newest_first=True)
        prev_reg = next((h for h in hist if h["regime"] and h["regime"] != reg["name"]), None)
        since = next((h["at"] for h in reversed(hist) if h["regime"] != reg["name"]), None)
        for d in divs:
            d["status"], d["since"], d["previous"] = self._div_status(d["id"], hist)
        gone = [{"id": i, "status": "invalidated"} for i in (hist[0]["divs"] if hist else []) if isinstance(i, dict) and i.get("id") not in {d["id"] for d in divs}]
        sent = self._sentiment(fused, inp, by)
        return {
            "generated_at": now.isoformat(timespec="seconds"), "expiry": expiry, "session": session, "enabled": self.enabled,
            "status": status, "sentiment": sent, "regime": {**reg, "previous": None if prev_reg is None else prev_reg["regime"], "changed_at": since},
            "engines": engines, "pulse": self._pulse(inp, by, gx, expiry), "gex": gx, "heavyweights": inp["heavy"], "stock_futures": fz.g(inp["market"], "stock_futures"), "intraday_ml": inp.get("ml"), "observations": fz.observations(inp, by, gx),
            "interpretation": fz.interpretation(fused, engines, reg, divs, gx, inp),
            "divergences": divs, "divergences_invalidated": gone, "divergences_unavailable": divs_missing,
            "scenarios": fz.scenarios(fused, engines, gx, inp, spot), "panels": self._panels(inp, by, gx), "capabilities": fz.capabilities(inp, status, gx),
            "turn_watch": turn.assess_at(self.store.rows(session, 120)), "alerts": self.store.alerts(session, 30), "overlap_audit": fz.overlap_audit(engines),
            "config": {"weights": self.weights, "min_coverage": fz.MIN_COVERAGE, "min_engines": fz.MIN_ENGINES, "classes": [[lo, n] for lo, n in fz.CLASSES],
                       "note": fz.PROVISIONAL, "groups": {k: fz.ENGINE_NAMES[k] for k in fz.DEFAULT_WEIGHTS}},
            "compute_ms": round((_time.perf_counter() - t0) * 1000, 1),
        }

    def _sentiment(self, fused: dict[str, Any], inp: Mapping[str, Any], by: Mapping[str, Any]) -> dict[str, Any]:
        er = fz.num(fz.g(inp["intraday"], "price", "er_30")) or fz.num(fz.g(inp["intraday"], "price", "er_session"))
        conf = fused["confidence"]
        quality = None if conf is None else ("High" if conf >= 60 else "Medium" if conf >= 35 else "Low")
        return {**fused, "trend_strength": None if er is None else round(er * 100), "signal_quality": quality, "data_completeness": fused["coverage"],
                "volatility_regime": fz.volatility_regime(inp, fz.num(fz.g(by.get("volatility"), "atm_iv_change_15m")))}

    @staticmethod
    def _div_status(id_: str, hist: list[dict[str, Any]]) -> tuple[str, str | None, str | None]:
        run, since, prev_reading = 0, None, None
        for h in hist:  # newest first: count the unbroken run of recorded minutes that carried this divergence
            hit = next((d for d in h["divs"] if isinstance(d, dict) and d.get("id") == id_), None)
            if hit is None:
                break
            run += 1
            since = h["at"]
            prev_reading = prev_reading or hit.get("reading")
        status = "early warning" if run < 2 else "developing" if run < 9 else "confirmed"
        return status, since, prev_reading

    def _pulse(self, inp: Mapping[str, Any], by: Mapping[str, Any], gx: Mapping[str, Any], expiry: str | None) -> dict[str, Any]:
        g, num = fz.g, fz.num
        ins, mk, fut = inp["intraday"], inp["market"], inp["futures"]
        vol = g(ins, "volatility") or {}
        atm = num(g(ins, "options", "atm_strike"))
        px = {(r.get("strike"), r.get("side")): r.get("price") for r in (vol.get("rows") or [])}
        lat = g(fut, "latest") or {}
        g_iv = g(mk, "index_vwap") or {}
        vix = g(inp["vix"], "iv") or []
        vix_last = next((v for v in reversed(vix) if v is not None), None)
        vix_date = None
        if vix_last is not None:
            dates = g(inp["vix"], "dates") or []
            idx = max((k for k, v in enumerate(vix) if v is not None), default=None)
            vix_date = dates[idx] if idx is not None and idx < len(dates) else None
        oi_ch = next((v for v in reversed(g(fut, "oi_change") or []) if v is not None), None)
        flow = g(mk, "flow", "futures") or {}
        return {
            "spot": num(g(ins, "price", "last")), "change_pct": num(g(ins, "price", "change_pct")), "futures": num(lat.get("future")), "basis": num(lat.get("basis")), "basis_pct": num(lat.get("basis_pct")),
            "atm_strike": atm, "expiry": expiry, "atm_ce_premium": num(px.get((atm, "CE"))), "atm_pe_premium": num(px.get((atm, "PE"))), "atm_iv": num(vol.get("atm_iv")),
            "vwap": {"instrument": "NIFTY current-month future", "futures_price": num(g(ins, "vwap", "price")), "futures_vwap": num(g(ins, "vwap", "vwap")), "distance_pts": num(g(ins, "vwap", "distance_pts")),
                     "distance_pct": num(g(ins, "vwap", "distance_pct")), "side": g(ins, "vwap", "side"), "spot_vwap": g_iv.get("value"), "spot_vwap_estimate": g_iv, "spot_vwap_note": "an ESTIMATE from the constituents' day VWAPs (the index itself has no traded volume); never compared with the futures VWAP"},
            "india_vix": {"value": vix_last, "as_of": vix_date, "label": "India VIX – Last Daily Close", "intraday_signal": False,
                          "note": "A daily close dated " + (str(vix_date) if vix_date else "(date unknown)") + ", not a live quote: it is not used as an intraday volatility signal (live ATM IV and the expiry-specific skew are)."}, "pcr": num(g(ins, "options", "pcr_oi")), "net_gex": gx.get("net"), "gamma_flip": gx.get("flip"),
            "futures_oi_change": oi_ch, "futures_cvd_pct": num(flow.get("cvd_pct")), "futures_vwap": num(g(ins, "vwap", "vwap")),
            "heavyweight_cvd": g(by.get("orderflow"), "metrics", "weighted_cvd_score"),
        }

    def _panels(self, inp: Mapping[str, Any], by: Mapping[str, Any], gx: Mapping[str, Any]) -> dict[str, Any]:
        g, num = fz.g, fz.num
        ins, mk, fut, pos = inp["intraday"], inp["market"], inp["futures"], inp["positioning"]
        rows = g(pos, "rows") or []

        def top(side: str, field: str, n: int = 3, reverse: bool = True) -> list[dict[str, Any]]:
            v = [(r["strike"], r[side][field]) for r in rows if isinstance(r.get(side), dict) and r[side].get(field) is not None]
            v.sort(key=lambda x: x[1], reverse=reverse)
            return [{"strike": k, "change": c} for k, c in v[:n] if (c > 0 if reverse else c < 0)]

        o = g(ins, "options") or {}
        iv = g(inp["vix"], "iv") or []
        hv, rv = g(inp["vix"], "hv") or [], g(inp["vix"], "rv") or []
        vol = g(ins, "volatility") or {}
        rows_v = [r for r in (vol.get("rows") or []) if r.get("vega_pt") is not None]
        ce_v = [r["vega_pt"] for r in rows_v if r.get("side") == "CE"]
        pe_v = [r["vega_pt"] for r in rows_v if r.get("side") == "PE"]
        flow = g(mk, "flow") or {}
        return {
            "options": {"ce_oi": o.get("ce_oi"), "pe_oi": o.get("pe_oi"), "ce_oi_change": o.get("ce_oi_chg"), "pe_oi_change": o.get("pe_oi_chg"), "pcr_oi": o.get("pcr_oi"), "pcr_vol": o.get("pcr_vol"), "pcr_first": o.get("pcr_oi_first"),
                        "max_ce_oi_strike": o.get("max_ce_oi_strike"), "max_pe_oi_strike": o.get("max_pe_oi_strike"), "largest_call_additions": top("ce", "oi_change"), "largest_put_additions": top("pe", "oi_change"),
                        "largest_call_unwinding": top("ce", "oi_change", reverse=False), "largest_put_unwinding": top("pe", "oi_change", reverse=False), "demand": g(pos, "demand") or [],
                        "window": g(pos, "window"), "spot_change_pct": g(pos, "spot_change_pct"), "note": "OI does not identify who bought or sold; labels are 'potential'."},
            "gex": {**gx, "label": "Modelled GEX exposure (not observed dealer positioning)", "methodology": fz.GEX_METHOD},
            "vega": {"ce_avg_vega": round(sum(ce_v) / len(ce_v), 3) if ce_v else None, "pe_avg_vega": round(sum(pe_v) / len(pe_v), 3) if pe_v else None, "strikes": len(rows_v) // 2 if rows_v else 0,
                     "note": "Average vega per option (₹ per 1 IV point) over the strikes of the latest solved chain. OI-weighted vega, change and migration are on the Vega Analysis page (browser-computed)."},
            "volatility": {"atm_iv": num(vol.get("atm_iv")), "iv_change_15m": g(by.get("volatility"), "atm_iv_change_15m"), "hv": next((v for v in reversed(hv) if v is not None), None), "rv": next((v for v in reversed(rv) if v is not None), None),
                           "india_vix": next((v for v in reversed(iv) if v is not None), None), "india_vix_label": "India VIX – Last Daily Close", "india_vix_as_of": next((d for d, v in zip(reversed(g(inp["vix"], "dates") or []), reversed(iv), strict=False) if v is not None), None), **{f"{k}_252": v for k, v in rank_percentile(iv, 252).items() if k in ("ivr", "ivp")},
                           "skew_25d": g(inp["skew"], "cards", "skew_25d"), "skew_10d": g(inp["skew"], "cards", "skew_10d"), "risk_reversal_25d": g(inp["skew"], "cards", "call_minus_put_25d"),
                           "butterfly_25d": g(inp["skew"], "cards", "butterfly_25d"), "term_slope_30d": g(inp["skew"], "cards", "term_slope_per_30d"), "term_shape": g(inp["skew"], "term_structure", "shape"),
                           "term": [{"expiry": t.get("expiry"), "days": t.get("days"), "atm_iv": t.get("atm_iv")} for t in (g(inp["skew"], "term") or [])],
                           "expected_move_1sd_pts": num(vol.get("expected_move_iv_1sd_pts")), "straddle": num(vol.get("straddle")), "interpretation": vol.get("interpretation"),
                           "note": "India VIX is the last DAILY close (see its date): context only, never an intraday signal. IV rank and percentile are computed from those daily closes. HV/RV are close-to-close, 252-day annualisation."},
            "futures": {"series": g(fut, "latest"), "contract": g(fut, "contract"), "oi_change": next((v for v in reversed(g(fut, "oi_change") or []) if v is not None), None), "oi_baseline": g(fut, "oi_baseline"),
                        "volume": next((v for v in reversed(g(fut, "volume") or []) if v is not None), None), "buildup": by["positioning"].get("buildup"), "flow": g(flow, "futures"), "vwap": g(ins, "vwap"),
                        "rolling": inp.get("rolling"), "unavailable": ["rollover data (needs near-month and next-month contract OI and volume history)"],
                        "note": "CVD is an estimate by the quote and tick rule, not a trade-by-trade tape. Rolling windows are differences of the stored per-minute cumulative flow."},
        }

    # ------------------------------------------------------------------ timeline and alerts
    def record(self, now: datetime | None = None) -> bool:
        """Store this minute and raise alerts from the change since the previous recorded minute. Only while the market is live."""
        if not self.enabled:
            return False
        now = (now or self._clock()).replace(second=0, microsecond=0)
        s = self.summary()
        intraday = self._cache.get(("intraday", s["expiry"] or ""), (0, None, {}))[1]
        if self.live_only and fz.g(intraday, "market", "mode") != "live":
            return False
        sent, reg = s["sentiment"], s["regime"]
        eng = {e["key"]: e["score"] for e in s["engines"]}
        vol_e: dict[str, Any] = next((e for e in s["engines"] if e["key"] == "volatility"), {})
        gx = s["gex"]
        pl = s["pulse"]
        snap = {"spot": pl["spot"], "score": sent["score"], "confidence": sent["confidence"], "coverage": sent["coverage"], "regime": reg["name"], "vol_regime": sent["volatility_regime"],
                "gamma_regime": gx.get("regime"), "engines": eng,
                "metrics": {"arch": validation.ARCH, "cvd_pct": pl["futures_cvd_pct"], "fut_oi_change": pl["futures_oi_change"], "net_gex": gx.get("net"), "flip": gx.get("flip"), "flip_side": None if gx.get("flip_distance_pct") is None else (1 if gx["flip_distance_pct"] >= 0 else -1),
                            "atm_iv": pl["atm_iv"], "iv_change_15m": fz.g(vol_e, "atm_iv_change_15m"), "d25": next((t["score"] for t in vol_e.get("terms", []) if t["name"].startswith("Call versus put")), None),
                            "heavy_cvd": pl["heavyweight_cvd"], "hw15": fz.g(s["heavyweights"], "aggregate", "15", "score"), "vol": {"atm": fz.g(vol_e, "detail", "atm", "avg_change"), "spot": fz.g(vol_e, "detail", "spot_change_pct"), "rr": fz.g(vol_e, "detail", "d25", "rr_change")}, "hw_valid": fz.g(s["heavyweights"], "quality", "valid"), "hw_class": fz.g(s["heavyweights"], "participation", "class"), "vwap_side": fz.g(intraday, "vwap", "side"),
                            "ce_oi_chg": fz.g(s["panels"], "options", "ce_oi_change"), "pe_oi_chg": fz.g(s["panels"], "options", "pe_oi_change")},
                "divs": [{"id": d["id"], "reading": d["reading"], "direction": d["direction"], "severity": d["severity"]} for d in s["divergences"]]}
        prev = self.store.rows(s["session"], 1, newest_first=True)
        if not self.store.record(s["session"], now, s["expiry"] or "", snap):
            return False
        self._alerts(s, prev[0] if prev else None, snap, now)
        return True

    def _alerts(self, s: Mapping[str, Any], prev: Mapping[str, Any] | None, cur: Mapping[str, Any], now: datetime) -> None:
        if prev is None:
            return
        out: list[dict[str, Any]] = []
        ps, cs = prev["score"], cur["score"]
        agree = s["sentiment"].get("agreement") or 0

        def add(kind: str, sev: str, direction: str, text: str, ev: list[str], conf: str, inv: str) -> None:
            out.append({"kind": kind, "severity": sev, "direction": direction, "text": text, "evidence": ev, "confirmation": conf, "invalidation": inv})

        if cur["regime"] != prev["regime"]:
            add("Regime transition", "medium", "neutral", f"Regime changed from {prev['regime']} to {cur['regime']}", s["regime"]["evidence"], "holds for several minutes", "the previous regime returns")
        if ps is not None and cs is not None and abs(ps) >= 15 and abs(cs) >= 15 and ps * cs < 0:
            add("Sentiment reversal", "high", "bullish" if cs > 0 else "bearish", f"Sentiment flipped from {ps:+.0f} to {cs:+.0f}", [f"agreement {agree:.0%}"], "score keeps the new sign for 5 minutes", "score crosses back")
        if ps is not None and cs is not None and abs(cs) >= 70 and abs(ps) < 70 and agree >= 0.7:
            add(f"Strong {'bullish' if cs > 0 else 'bearish'} confirmation", "high", "bullish" if cs > 0 else "bearish", f"Score reached {cs:+.0f} with {agree:.0%} agreement", [e["name"] for e in s["engines"] if e["score"] is not None and e["score"] * cs > 0][:4], "agreement holds above 70%", "score falls under 35")
        pm, cm = prev["metrics"], cur["metrics"]
        if pm.get("flip_side") and cm.get("flip_side") and pm["flip_side"] != cm["flip_side"]:
            add("Gamma flip crossing", "high", "bullish" if cm["flip_side"] > 0 else "bearish", f"NIFTY crossed the gamma flip {'upwards' if cm['flip_side'] > 0 else 'downwards'}", [f"flip {cm.get('flip')}"], "holds on the new side for 5 minutes", "spot returns across the flip (model-based level)")
        if pm.get("flip") and cm.get("flip") and cur["spot"] and abs(cm["flip"] - pm["flip"]) / cur["spot"] * 100 >= 0.15:
            add("Significant GEX migration", "medium", "bullish" if cm["flip"] > pm["flip"] else "bearish", f"Gamma flip moved {cm['flip'] - pm['flip']:+.0f} points", [f"net GEX {cm.get('net_gex')}"], "the new level persists", "flip returns")
        po, co = prev["engines"].get("positioning"), cur["engines"].get("positioning")
        if po is not None and co is not None and abs(po) >= 15 and abs(co) >= 15 and po * co < 0:
            add("Smart OI shift", "medium", "bullish" if co > 0 else "bearish", f"Derivatives positioning turned {'bullish' if co > 0 else 'bearish'} ({po:+.0f} to {co:+.0f})", [], "next strike-positioning window agrees", "positioning group crosses back")
        if any(d["id"] == "price_cvd" for d in cur["divs"]) and not any(d["id"] == "price_cvd" for d in prev["divs"]):
            d = next(d for d in cur["divs"] if d["id"] == "price_cvd")
            add("Futures CVD divergence", "medium", d["direction"], d["reading"], [], "CVD stays opposite to price for 10 minutes", "CVD turns with price")
        ph, ch = prev["metrics"].get("heavy_cvd"), cm.get("heavy_cvd")
        if ph is not None and ch is not None and abs(ch) >= 40 > abs(ph):
            add("Heavyweight buying" if ch > 0 else "Heavyweight selling", "medium", "bullish" if ch > 0 else "bearish", f"Weighted heavyweight CVD (estimated) reached {ch:+.0f}", [], "stays beyond ±40 for 5 minutes", "falls inside ±25")
        iv = cm.get("iv_change_15m")
        if iv is not None and iv >= 0.5 and not (pm.get("iv_change_15m") or 0) >= 0.5:
            add("IV expansion", "medium", "neutral", f"ATM IV up {iv:+.2f} points in 15 minutes", [f"ATM IV {cm.get('atm_iv')}"], "IV stays up", "IV falls back")
        d25 = cm.get("d25")
        if d25 is not None and abs(d25) >= 80 and abs(pm.get("d25") or 0) < 80:
            add("Skew shock", "high", "bullish" if d25 > 0 else "bearish", f"25Δ call/put IV momentum reached {d25:+.0f}", [], "persists next window", "momentum fades")
        vs, vp = cm.get("vwap_side"), pm.get("vwap_side")
        if vs in ("above", "below") and vp in ("above", "below") and vs != vp:
            add("VWAP reclaim" if vs == "above" else "VWAP breakdown", "medium", "bullish" if vs == "above" else "bearish", f"Future {'reclaimed' if vs == 'above' else 'lost'} its day VWAP", [], "holds for 5 minutes", "price crosses back")
        rows = self.store.rows(s["session"], 120)  # the turn watch: alert once when a leaning signal switches on (the persistence rule already de-flickers it)
        if len(rows) >= 2:
            now_t, before_t = turn.assess_at(rows), turn.assess_at(rows, len(rows) - 2)
            had = {x["id"] for x in before_t.get("signals", [])}
            for x in now_t.get("signals", []):
                if x["id"] not in had and not x["id"].startswith("breadth"):
                    add("Turn watch", "high" if x.get("early") else "medium", x["direction"], x["title"] + (" (price has not confirmed yet)" if x.get("early") else ""), x["evidence"], "the signal stays on for 10 more minutes", x["invalidation"])
        for a in out:
            last = self.store.last_alert_at(s["session"], a["kind"], a["direction"])
            if last and (now - datetime.fromisoformat(last)).total_seconds() < ALERT_COOLDOWN_S:
                continue  # de-duplicated: the same alert is not raised again inside its cooldown
            self.store.add_alert(s["session"], now, a)

    def timeline(self, session: str | None = None) -> dict[str, Any]:
        session = session or self._clock().astimezone(IST).date().isoformat()
        rows = self.store.rows(session, 500)
        return {"session": session, "sessions": self.store.sessions(), "points": rows, "recorded": len(rows),
                "note": "Only minutes that were recorded appear here; a minute without a row was not captured and is not reconstructed."}

    def validation(self, sessions: int = 30) -> dict[str, Any]:
        """Walk-forward validation of the stored snapshots (read-only; see ``validation.py``). Uses the live weights to re-score history."""
        rows: list[dict[str, Any]] = []
        for sess in sorted(self.store.sessions(sessions)):
            rows += self.store.rows(sess, 500)
        return {"generated_at": self._clock().isoformat(timespec="seconds"), "weights": self.weights, "weights_note": fz.PROVISIONAL, **validation.report(rows, weights=self.weights)}

    # ------------------------------------------------------------------ lifecycle
    async def _loop(self) -> None:
        while True:
            try:
                await asyncio.to_thread(self.record)
                self.last_error = None
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - recording must never stop the application
                self.last_error = f"{type(e).__name__}: {e}"[:200]
                logger.warning("intelligence_record_failed", extra={"fields": {"error": self.last_error}})
            now = self._clock()
            await asyncio.sleep(max(5.0, 60.0 - now.second))

    def start(self) -> None:
        if self._task is None and self.enabled:
            self._task = asyncio.create_task(self._loop(), name="market-intelligence")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None


def minutes_ago(now: datetime, minutes: int) -> datetime:
    return now - timedelta(minutes=minutes)
