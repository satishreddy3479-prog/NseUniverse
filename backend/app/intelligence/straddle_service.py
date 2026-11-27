"""Reads stored option-chain samples and serves the straddle decay analysis and the buyer/seller environments.

Separate from the sentiment fusion: it reads ``MarketIntelligence.summary()`` (cached there) for flow, positioning, GEX and term structure, never writes to it, and
subscribes to no feed. It records one compact row per market minute in its own SQLite file and raises alerts from changes between recorded minutes.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time as _time
from collections import OrderedDict
from collections.abc import Callable, Mapping
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.domain.session import session_close
from app.intelligence import fusion as fz
from app.intelligence import (
    live_regime,
    straddle,
    straddle_env,
    straddle_validation,
    straddle_watch,
)
from app.intelligence.cadence import seconds_to_next_record
from app.intelligence.straddle_store import StraddleStore
from app.storage.observations import to_ms

logger = logging.getLogger(__name__)
IST = ZoneInfo("Asia/Kolkata")
MAX_POINTS = 400  # a full session is about 385 one-minute samples: nothing is thinned
CACHE_S = 20.0
ASOF_KEEP = 48  # replay answers kept (each is a few hundred KB)
OPEN_T = time(9, 15)  # the close is ``session_close()``: it moves from 15:40 to 15:45 on 7 Dec 2026


def _ladder(snap: straddle.Snap) -> dict[str, Any] | None:
    """Prices of the five strikes around the ATM strike (two each side), so the same contract can be priced later without the chain archive."""
    ks = sorted({k for k, _ in snap.prices})
    if snap.spot is None or len(ks) < 2:
        return None
    k0 = straddle.nearest(ks, snap.spot)
    step = min(b - a for a, b in zip(ks, ks[1:], strict=False))
    if k0 is None or not step:
        return None
    grid = [k0 + i * step for i in range(-2, 3)]
    return {"k0": k0, "step": step, "ce": [snap.prices.get((k, 0)) for k in grid], "pe": [snap.prices.get((k, 1)) for k in grid]}


def snapshot(a: Mapping[str, Any], env: Mapping[str, Any], last: straddle.Snap | None, expiry_day: bool) -> dict[str, Any]:
    """The compact per-minute record. Every value is what the engines computed that minute; a missing value is None."""
    g = straddle_env.g
    att = a.get("attribution") or {}

    def eff(m: str, w: str) -> dict[str, Any]:
        e = g(att, m, w, "efficiency") or {}
        return {"status": e.get("status"), "pct": e.get("efficiency_pct")}

    iv, rvs, st = a.get("iv") or {}, a.get("realised_vs_implied") or {}, a.get("structure") or {}
    mv = iv.get("moves") or {}
    gx = st.get("gex") or {}
    flip, spot = gx.get("flip"), (a.get("spot") or [None])[-1]
    ev = env.get("evidence") or {}
    open_win = g(att, "fixed", "open", "both") or {}
    fixed = a.get("tracker", {}).get("fixed", {})
    return {
        "spot": spot, "expiry_day": expiry_day, "regime": g(a, "regime", "label"), "seller": g(env, "seller", "score"), "buyer": g(env, "buyer", "score"),
        "seller_class": g(env, "seller", "class"), "buyer_class": g(env, "buyer", "class"), "coverage": [g(env, "seller", "coverage"), g(env, "buyer", "coverage")],
        "types": {k: v.get("score") for k, v in (g(env, "buyer", "types") or {}).items()}, "direction": {"value": g(env, "direction", "value"), "label": g(env, "direction", "label")},
        "atm": {"k": g(a, "tracker", "atm_now"), "ce": (a.get("series") or {}).get("rolling", {}).get("ce", [None])[-1], "pe": (a.get("series") or {}).get("rolling", {}).get("pe", [None])[-1],
                "iv": g(iv, "rolling", "combined", "current")}, "fixed": {"k": fixed.get("strike"), "straddle": g(fixed, "straddle", "current")},
        "ladder": _ladder(last) if last is not None else None,
        "eff30": eff("rolling", "30"), "eff60": eff("rolling", "60"), "effopen": eff("fixed", "open"), "terms": {k: round(v, 3) for k, v in open_win.items()},
        "iv": {"atm15": g(mv, "rolling_atm", "15"), "atm30": g(mv, "rolling_atm", "30"), "ce15": g(mv, "fixed_ce", "15"), "pe15": g(mv, "fixed_pe", "15"), "skew25": g(iv, "skew25", "current"),
               "regimes": g(iv, "regimes", "30", "tags")},
        "rv": {"accel": g(rvs, "acceleration", "ratio"), "rv5": g(rvs, "windows", "5", "vol_pct"), "rv15": g(rvs, "windows", "15", "vol_pct"), "rv60": g(rvs, "windows", "60", "vol_pct"), "iv": rvs.get("iv_now"), "gap60": g(rvs, "gap", "60")},
        "gex": {"net": gx.get("net"), "flip": flip, "side": None if flip is None or spot is None else (1 if spot > flip else -1), "dist_pts": gx.get("flip_distance_pts")},
        "flow": {"orderflow": ev.get("orderflow"), "heavy15": ev.get("heavy15"), "cvd": ev.get("cvd"), "vwap_pct": ev.get("vwap_pct"), "positioning": ev.get("positioning")},
        "flags": [f["id"] for f in g(env, "seller", "flags") or []],
        "track": g(a, "live_regime", "track"),
        "live": {"flags": [f["id"] for f in g(a, "live_regime", "flags") or []], "messages": {f["id"]: f["message"] for f in g(a, "live_regime", "flags") or []}, "label": g(a, "live_regime", "label"),
                 "ib_ratio": g(a, "live_regime", "ib", "ratio")},
    }  # fmt: skip


def mi_context(mi: Mapping[str, Any]) -> dict[str, Any]:
    """What the page shows from Market Intelligence unchanged: positioning, term structure, skew cards, futures flow, VWAP, heavyweight CVD."""
    pn = mi.get("panels") or {}
    vol, opt, fut = pn.get("volatility") or {}, pn.get("options") or {}, pn.get("futures") or {}
    hw = mi.get("heavyweights") or {}
    return {
        "as_of": mi.get("generated_at"), "volatility": {k: vol.get(k) for k in ("skew_25d", "skew_10d", "risk_reversal_25d", "butterfly_25d", "term_slope_30d", "term_shape", "term", "atm_iv", "expected_move_1sd_pts")},
        "options": {k: opt.get(k) for k in ("ce_oi", "pe_oi", "ce_oi_change", "pe_oi_change", "pcr_oi", "pcr_vol", "max_ce_oi_strike", "max_pe_oi_strike", "largest_call_additions", "largest_put_additions",
                                            "largest_call_unwinding", "largest_put_unwinding", "demand", "window", "note")},
        "futures": {"oi_change": fut.get("oi_change"), "buildup": fut.get("buildup"), "flow": fut.get("flow"), "vwap": fut.get("vwap"), "rolling": fut.get("rolling"), "note": fut.get("note")},
        "heavyweights": {"aggregate": hw.get("aggregate"), "participation": hw.get("participation"), "method": hw.get("method")},
        "groups": {e["key"]: {"name": e.get("name"), "score": e.get("score"), "class": e.get("class")} for e in (mi.get("engines") or []) if isinstance(e, Mapping)},
        "gex": mi.get("gex"),
    }  # fmt: skip


def sources(mi: Mapping[str, Any], a: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Every input with its source, timestamp, age and status (AVAILABLE, PARTIAL when stale or failing, UNAVAILABLE)."""
    names = {"market": "Futures flow and heavyweights (market service)", "intraday": "Command centre (stored chain)", "futures": "Futures series", "skew": "IV skew and term structure", "momentum": "IV momentum",
             "positioning": "Strike positioning (OI, Smart OI)", "gex": "GEX history (modelled)", "vix": "IV chart and India VIX (daily close)", "flow": "Stored per-minute flow (rolling CVD)",
             "heavymeta": "Heavyweight index weights"}  # fmt: skip
    out = []
    q = a.get("quality") or {}
    out.append({"id": "chain", "name": "Option chain samples (stored, last traded prices)", "as_of": q.get("last_sample_at"), "age_s": None if q.get("age_minutes") is None else round(q["age_minutes"] * 60),
                "status": "UNAVAILABLE" if not q else "PARTIAL" if q.get("stale") else "AVAILABLE", "reliability": "last traded prices; model IV and Greeks (assumed rate)"})  # fmt: skip
    for k, st in (mi.get("status") or {}).items():
        if k not in names or not isinstance(st, Mapping):
            continue
        age = st.get("age_s")
        status = "UNAVAILABLE" if not st.get("ok") else "PARTIAL" if (age is not None and age > 180 and k not in ("vix", "heavymeta", "ml")) else "AVAILABLE"
        out.append({"id": k, "name": names[k], "as_of": st.get("as_of"), "age_s": None if age is None else round(age), "status": status, "reliability": st.get("error") or "ok"})
    return out


class StraddleDecay:
    def __init__(self, *, observations: Any, underlying: str, gex: Callable[[str], Any] | None, rate: float, enabled: bool = True,
                 clock: Callable[[], datetime] = lambda: datetime.now(UTC), store: StraddleStore | None = None, mi: Callable[[str | None], Mapping[str, Any]] | None = None,
                 alert_cfg: Mapping[str, float] | None = None) -> None:  # fmt: skip
        self.obs, self.underlying, self._gex, self.rate, self.enabled, self._clock = observations, underlying, gex, rate, enabled, clock
        self.store, self._mi, self.alert_cfg = store, mi, dict(alert_cfg or straddle_watch.CFG)
        self._cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}
        self._asof: OrderedDict[tuple[str, str, str], dict[str, Any]] = OrderedDict()  # replay answers (past minutes do not change); a few dozen kept
        self._last: dict[tuple[str, str], straddle.Snap | None] = {}
        self._managed_days: dict[str, dict[str, Any]] = {}  # finished sessions' managed books: they do not change
        self._lock = threading.RLock()
        self._task: asyncio.Task[None] | None = None
        self.last_error: str | None = None

    # ------------------------------------------------------------------ stored sessions
    def _expiries(self, day: date) -> list[str]:
        lo, hi = datetime.combine(day, time(9, 0), IST), datetime.combine(day, time(16, 0), IST)
        return [e for e, _ in self.obs.day_counts(self.underlying, to_ms(lo), to_ms(hi))]

    def latest(self) -> tuple[date, str] | None:
        """Newest day (within nine) with samples and its nearest expiry, as the dashboard's default."""
        today = self._clock().astimezone(IST).date()
        for back in range(9):
            day = today - timedelta(days=back)
            ex = self._expiries(day)
            if ex:
                return day, ex[0]
        return None

    def _read(self, expiry: str, day: date, max_points: int | None = MAX_POINTS, until: datetime | None = None) -> tuple[list[straddle.Snap], list[tuple[datetime, float | None]]]:
        lo, hi = datetime.combine(day, OPEN_T, IST), datetime.combine(day, session_close(), IST)
        if until is not None:
            hi = min(hi, until)  # a replay: only what had been stored by then
        samples = [s for s in self.obs.samples(self.underlying, expiry, since=lo, until=hi) if s.spot is not None]
        spots = [(s.received_at, s.spot) for s in samples]
        stride = 1 if not max_points else max(1, -(-len(samples) // max_points))
        use = samples[::stride]
        if samples and use[-1].sample_id != samples[-1].sample_id:
            use.append(samples[-1])
        cache: dict[int, Any] = {}
        snaps: list[straddle.Snap] = []
        for s in use:
            if s.values_from not in cache:
                cache[s.values_from] = self.obs.contracts(s.values_from)
            c = cache[s.values_from]
            snaps.append(straddle.Snap(s.received_at, s.spot, {k: (q.ltp if q.ltp is not None and q.ltp > 0 else None) for k, q in c.items()}, {k: q.oi for k, q in c.items()}))
        return snaps, spots

    # ------------------------------------------------------------------ views
    def summary(self, expiry: str | None = None, session: str | None = None, as_of: datetime | None = None) -> dict[str, Any]:
        """The analysis of one stored session. With ``as_of`` it is the analysis as it stood at that moment (a replay): only the samples stored up to it,
        the recorded history and alerts up to it, never live and never the buyer/seller environments (they read live flow). Nothing of it touches the
        live minute's cache or the premium ladder that ``record`` keeps."""
        pick = self.latest()
        day = date.fromisoformat(session) if session else (pick[0] if pick else None)
        if day is None:
            return {"status": "unavailable", "message": "No option-chain samples are stored yet.", "interpretation": []}
        if expiry is None:
            ex = self._expiries(day)
            expiry = ex[0] if ex else None
        if expiry is None:
            return {"status": "unavailable", "message": f"No samples are stored for {day.isoformat()}.", "interpretation": [], "session": day.isoformat()}
        key = (expiry, day.isoformat())
        with self._lock:
            if as_of is not None:
                as_of = as_of.astimezone(IST).replace(second=0, microsecond=0) + timedelta(seconds=59)  # one answer per stored minute
                akey = (expiry, day.isoformat(), as_of.isoformat())
                got = self._asof.get(akey)
                if got is not None:
                    self._asof.move_to_end(akey)
                    return got
            hit = self._cache.get(key) if as_of is None else None
            if hit is not None and _time.monotonic() - hit[0] < CACHE_S:
                return hit[1]
            now = self._clock() if as_of is None else as_of
            t0 = _time.perf_counter()
            snaps, spots = self._read(expiry, day, until=as_of)
            t_read = _time.perf_counter()
            live = as_of is None and day == now.astimezone(IST).date()
            gex: dict[str, Any] | None = None
            points: list[Any] = []
            if self._gex is not None and live:
                try:
                    raw = self._gex(expiry)
                    gex, points = fz.gex_state({"gex": raw}), list((raw or {}).get("points") or [])
                except Exception:  # noqa: BLE001 - structure is optional context
                    gex = None
            out = straddle.analyse(snaps, spots, date.fromisoformat(expiry), rate=self.rate, now=now, gex=gex, live=live, gex_points=points)
            out |= {"session": day.isoformat(), "expiry": expiry, "generated_at": now.isoformat(timespec="seconds"), "expiry_day": expiry == day.isoformat()}
            t_an = _time.perf_counter()
            if out["status"] == "ok":
                if as_of is None:
                    self._last[key] = snaps[-1] if snaps else None  # used by record() for the premium ladder (a replay must not overwrite it)
                mi: Mapping[str, Any] = {}
                if live and self._mi is not None:
                    try:
                        mi = self._mi(expiry)
                    except Exception:  # noqa: BLE001 - one failing input must not hide the straddle analysis
                        mi = {}
                if live:
                    recent = [r["seller"] for r in self.store.rows(day.isoformat(), 2, newest_first=True)][::-1] if self.store is not None else []
                    env = straddle_env.assess(out, mi, recent)
                    out["environment"], out["context"], out["sources"] = env, mi_context(mi), sources(mi, out)
                    last_oi = snaps[-1].oi if snaps else None
                    trk = live_regime.track_now(last_oi, (out.get("spot") or [None])[-1], mi)
                    hist = [(r["at"], (r["data"] or {}).get("track")) for r in self.store.rows(day.isoformat(), 120, newest_first=True)] if self.store is not None else []
                    out["live_regime"] = live_regime.evaluate_live_regime(out, mi, trk, hist)
                    out["preflight"] = straddle_env.evaluate_preflight(out, env, out["live_regime"])
                else:
                    out["environment"], out["context"], out["preflight"], out["live_regime"] = None, None, None, None
                    out["environment_note"] = "Buyer and seller environments are computed for the live session only (they read live flow and positioning). The recorded history below is what was stored."
                out |= self._history(day.isoformat(), until=as_of)
            if as_of is not None:
                out["as_of"] = as_of.isoformat(timespec="seconds")
            t_end = _time.perf_counter()
            out["compute_ms"] = round((t_end - t0) * 1000, 1)
            out["timing_ms"] = {"read_samples": round((t_read - t0) * 1000), "gex_and_analysis": round((t_an - t_read) * 1000), "environment_and_inputs": round((t_end - t_an) * 1000)}
            if as_of is None:
                self._cache[key] = (_time.monotonic(), out)
            else:
                self._asof[akey] = out
                while len(self._asof) > ASOF_KEEP:
                    self._asof.popitem(last=False)
            return out

    def _history(self, session: str, until: datetime | None = None) -> dict[str, Any]:
        if self.store is None:
            return {"history": None, "alerts": [], "environment_trend": None}
        rows = self.store.rows(session, 500)
        if until is not None:
            rows = [r for r in rows if datetime.fromisoformat(r["at"]) <= until]  # a replay: only what had been recorded by then
        hist = {"times": [r["at"] for r in rows], "seller": [r["seller"] for r in rows], "buyer": [r["buyer"] for r in rows], "regime": [r["regime"] for r in rows],
                "eff30": [(r["data"].get("eff30") or {}).get("pct") for r in rows], "spot": [r["spot"] for r in rows]}  # fmt: skip
        trend: dict[str, Any] | None = None
        if rows:
            last = datetime.fromisoformat(rows[-1]["at"])

            def at(minutes: int, key: str) -> float | None:
                cut = last - timedelta(minutes=minutes)
                old = [r for r in rows if datetime.fromisoformat(r["at"]) <= cut]
                return old[-1][key] if old and datetime.fromisoformat(old[-1]["at"]) >= cut - timedelta(minutes=3) else None

            trend = {k: {"now": rows[-1][k], "m15": at(15, k), "m30": at(30, k)} for k in ("seller", "buyer")}
        alerts = self.store.alerts(session, 30 if until is None else 500)
        if until is not None:
            alerts = [a for a in alerts if datetime.fromisoformat(a["at"]) <= until][:30]
        return {"history": hist, "alerts": alerts, "environment_trend": trend, "storage": {"rows_today": len(rows), "bytes": self.store.size_bytes()}}

    def latest_scores(self) -> dict[str, Any]:
        """The seller and buyer environment scores for the top bar: the LIVE calculation on the newest stored sample (the page's own 20 s analysis, so the bar and the page show the
        same numbers and both move as soon as a new sample is stored, not at the next recorded minute). Only when no live calculation exists does it fall back to the newest
        recorded minute, as such (``source`` says which). Also where the scores were 15 minutes before, from the record."""
        if self.store is None or not self.enabled:
            return {"available": False}
        days = self.store.sessions(1)
        if not days:
            return {"available": False}
        rows = self.store.rows(days[0], 40, newest_first=True)
        now = self._clock()
        a = self.summary() if self.obs is not None else {}
        env, q = a.get("environment"), a.get("quality") or {}
        sell, buy = straddle_env.g(env, "seller", "score"), straddle_env.g(env, "buyer", "score")
        if a.get("status") == "ok" and q.get("live") and sell is not None and buy is not None and q.get("last_sample_at"):
            at = datetime.fromisoformat(q["last_sample_at"])
            ref = rows[0] if rows else None
            ref_at = datetime.fromisoformat(ref["at"]) if ref else at
            cut = ref_at - timedelta(minutes=15)
            old = next((r for r in rows if cut - timedelta(minutes=3) <= datetime.fromisoformat(r["at"]) <= cut), None)
            return {
                "available": True, "source": "live", "session": a.get("session"), "at": q["last_sample_at"], "age_s": max(0, round((now - at).total_seconds())), "expiry": a.get("expiry"),
                "seller": sell, "buyer": buy, "regime": straddle_env.g(a, "regime", "label"), "seller_15m": None if old is None else old["seller"], "buyer_15m": None if old is None else old["buyer"],
            }  # fmt: skip
        if not rows or rows[0]["seller"] is None or rows[0]["buyer"] is None:
            return {"available": False}
        last = rows[0]
        at = datetime.fromisoformat(last["at"])
        cut = at - timedelta(minutes=15)
        old = next((r for r in rows if datetime.fromisoformat(r["at"]) <= cut and datetime.fromisoformat(r["at"]) >= cut - timedelta(minutes=3)), None)
        return {
            "available": True, "source": "recorded", "session": days[0], "at": last["at"], "age_s": max(0, round((now - at).total_seconds())), "expiry": last["expiry"], "seller": last["seller"], "buyer": last["buyer"],
            "regime": last["regime"], "seller_15m": None if old is None else old["seller"], "buyer_15m": None if old is None else old["buyer"],
        }  # fmt: skip

    def alerts(self, session: str | None = None, limit: int = 60) -> dict[str, Any]:
        day = session or self._clock().astimezone(IST).date().isoformat()
        return {"session": day, "alerts": [] if self.store is None else self.store.alerts(day, limit), "thresholds": self.alert_cfg,
                "note": "Alerts describe a change in readings, with persistence checks and a cooldown per kind; none is a trade signal."}

    # ------------------------------------------------------------------ recording
    def record(self, now: datetime | None = None) -> bool:
        """Store this minute and raise alerts. Only in market hours on a live, fresh chain; nothing is back-filled."""
        if not self.enabled or self.store is None:
            return False
        now = (now or self._clock()).replace(second=0, microsecond=0)
        ist = now.astimezone(IST)
        if ist.weekday() >= 5 or not (OPEN_T <= ist.time() <= session_close()):
            return False
        with self._lock:
            self._cache.clear()  # the minute's reading must be fresh, not the 20 s cache of the page
            a = self.summary()
            if a.get("status") != "ok" or not (a.get("quality") or {}).get("live") or a.get("environment") is None:
                return False
            age = (a["quality"] or {}).get("age_minutes")
            if age is None or age > 5:
                return False
            last = self._last.get((a["expiry"], a["session"]))
            snap = snapshot(a, a["environment"], last, bool(a.get("expiry_day")))
            prev = [r["data"] for r in self.store.rows(a["session"], 20, newest_first=True)]
            if not self.store.record(a["session"], now, a["expiry"], snap):
                return False
            for al in straddle_watch.detect(prev, snap, self.alert_cfg):
                last_at = self.store.last_alert_at(a["session"], al["kind"])
                if last_at and (now - datetime.fromisoformat(last_at)).total_seconds() < self.alert_cfg["cooldown_s"]:
                    continue
                self.store.add_alert(a["session"], now, al)
            return True

    def validation(self, sessions: int = 20, minutes: int = 30) -> dict[str, Any]:
        """Two read-only checks: the time-decay arithmetic over stored chain sessions, and the recorded environment scores against what followed."""
        now = self._clock().astimezone(IST)
        out: list[dict[str, Any]] = []
        for back in range(120):
            if len(out) >= sessions:
                break
            day = now.date() - timedelta(days=back)
            ex = self._expiries(day)
            if not ex or (back == 0 and now.time() < session_close()):
                continue  # today's session is still running: not yet a chronological history
            snaps, _ = self._read(ex[0], day, None)
            out.append({"session": day.isoformat(), "expiry": ex[0], "windows": straddle.window_pairs(snaps, date.fromisoformat(ex[0]), minutes, self.rate)})
        out.reverse()
        env: dict[str, Any] = {"sessions": 0, "sufficient": False, "message": "No environment scores have been recorded yet."}
        if self.store is not None:
            ses = []
            for d in sorted(self.store.sessions(120)):
                rows = self.store.rows(d, 500)
                if rows:
                    ses.append({"session": d, "expiry_day": bool(rows[0]["data"].get("expiry_day")), "rows": rows})
            if ses:
                env = straddle_validation.evaluate(ses)
        return {"generated_at": self._clock().isoformat(timespec="seconds"), "window_minutes": minutes, **straddle.validate(out), "environment": env}

    def managed_history(self, sessions: int = 20) -> dict[str, Any]:
        """The managed straddle's trades (re-struck when NIFTY is ``threshold`` points from the held strike) for each stored session, newest first: the day's
        re-strikes with their times and prices, the open position, and the profit in points and rupees per lot. Past sessions do not change, so each is computed
        once and kept (only the small book, not the analysis it came from); today's is read again. Read-only; stored last traded prices, before costs."""
        now = self._clock().astimezone(IST)
        days: list[dict[str, Any]] = []
        for back in range(120):
            if len(days) >= sessions:
                break
            day = now.date() - timedelta(days=back)
            ex = self._expiries(day)
            if not ex:
                continue
            key = day.isoformat()
            past = day < now.date() or now.time() >= session_close()
            item = self._managed_days.get(key) if past else None
            if item is None:
                a = self.summary(expiry=ex[0], session=key)
                with self._lock:
                    self._cache.pop((ex[0], key), None)  # the analysis of a day looked at only for its book is not kept
                book = (a.get("tracker") or {}).get("managed") if a.get("status") == "ok" else None
                keep = ("threshold", "restrikes", "segments", "open", "strike_now", "realised", "open_pnl", "total", "total_rupees", "lot_size", "note")
                item = {"session": key, "expiry": ex[0], "live": not past, "opening_at": (a.get("tracker") or {}).get("opening_at"),
                        "book": None if book is None else {k: book.get(k) for k in keep}, "message": None if book is not None else a.get("message") or "No managed-straddle book for this session."}  # fmt: skip
                if past and book is not None:
                    self._managed_days[key] = item
            days.append(item)
        done = [d["book"] for d in days if d["book"] is not None]
        totals = {"sessions": len(done), "restrikes": sum(int(b["restrikes"]) for b in done), "total": straddle.rd(sum(float(b["total"]) for b in done if b["total"] is not None), 2),
                  "total_rupees": straddle.rd(sum(float(b["total_rupees"]) for b in done if b["total_rupees"] is not None), 0), "winning_sessions": sum(1 for b in done if b["total"] is not None and b["total"] > 0)}  # fmt: skip
        return {"generated_at": self._clock().isoformat(timespec="seconds"), "threshold": straddle.RESTRIKE_POINTS, "days": days, "totals": totals}

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
                logger.warning("straddle_record_failed", extra={"fields": {"error": self.last_error}})
            await asyncio.sleep(seconds_to_next_record(self._clock()))

    def start(self) -> None:
        if self._task is None and self.enabled and self.store is not None:
            self._task = asyncio.create_task(self._loop(), name="straddle-decay")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
