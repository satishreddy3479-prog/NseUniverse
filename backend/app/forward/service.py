"""The forward test service: every time the seller favourable score reaches 60, open paper short positions on the stored option chain, run every exit variant on them
minute by minute from the stored samples, settle them at 15:20 and keep the record the dashboards read. Paper only: nothing is sent to a broker.

Rules (user-approved 16 Nov 2026):
- the trigger is the seller score of the weekly expiry (cohort "weekly") and of the monthly expiry (cohort "monthly"), read from the straddle engine's live analysis;
- every re-crossing counts: after a position is opened the trigger re-arms once the score has been below 60 for 30 minutes, at most 3 triggers a day per cohort;
- entries between 09:30 and 14:30 IST on weekdays, at the last traded prices of the newest stored sample (it must be less than 5 minutes old);
- two structures per trigger: the at-the-money short straddle and the short strangle (the call 50 points above, the put 50 points below the at-the-money strike);
- all exits close at 15:20 IST the same day.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.forward import analytics
from app.forward.engine import LABELS, VARIANTS, CostCfg, is_done, new_state, settle, step
from app.forward.store import ForwardStore
from app.storage.observations import CALL, PUT

logger = logging.getLogger(__name__)
IST = ZoneInfo("Asia/Kolkata")
THRESHOLD, CAP_PER_DAY, REARM_MIN = 60.0, 3, 30
ENTRY_FROM, ENTRY_TO, CLOSE_AT = time(9, 30), time(14, 30), time(15, 20)
MAX_SAMPLE_AGE_S = 300


def next_arm(arm: dict[str, Any], score: float | None, now: datetime) -> tuple[dict[str, Any], bool]:
    """The re-arming rule: returns the new arming state and whether to open positions now. Missing stays missing: no score changes nothing."""
    if score is None:
        return arm, False
    a = dict(arm)
    if score >= THRESHOLD:
        a["below_since"] = None
        if a["armed"] and a["count"] < CAP_PER_DAY:
            a.update(armed=False, count=a["count"] + 1)
            return a, True
        return a, False
    if not a["armed"] and a["count"] < CAP_PER_DAY:
        if a["below_since"] is None:
            a["below_since"] = now.isoformat()
        elif (now - datetime.fromisoformat(a["below_since"])).total_seconds() >= REARM_MIN * 60:
            a.update(armed=True, below_since=None)
    return a, False


def _price(q: Any) -> float | None:
    return None if q is None or q.ltp is None or q.ltp <= 0 else float(q.ltp)


class ForwardService:
    def __init__(
        self, *, observations: Any, straddle: Any, store: ForwardStore, underlying: str, expiries: Callable[[], Awaitable[tuple[str | None, str | None]]], lot: int = 65,
        enabled: bool = True, clock: Callable[[], datetime] = lambda: datetime.now(UTC), cost: CostCfg = CostCfg(),  # noqa: B008
    ) -> None:  # fmt: skip
        self.obs, self.straddle, self.store, self.underlying, self._expiries = observations, straddle, store, underlying, expiries
        self.lot, self.enabled, self._clock, self.cost = lot, enabled, clock, cost
        self._task: asyncio.Task[None] | None = None
        self.last_tick: datetime | None = None
        self.last_error: str | None = None

    # ------------------------------------------------------------------ one pass (blocking: run it in a thread)
    def run_once(self, now: datetime, weekly: str | None, monthly: str | None) -> dict[str, Any]:
        ist = now.astimezone(IST)
        out: dict[str, Any] = {"opened": 0, "settled": 0}
        if ist.weekday() < 5 and ENTRY_FROM <= ist.time() <= ENTRY_TO:
            out["opened"] = self._detect(now, [("weekly", weekly), ("monthly", monthly if monthly != weekly else None)])
        out["settled"] = self._advance(now)
        return out

    def _latest_sample(self, expiry: str, now: datetime) -> Any:
        got = self.obs.samples(self.underlying, expiry, since=now - timedelta(minutes=10), until=now)
        return got[-1] if got and (now - got[-1].received_at).total_seconds() <= MAX_SAMPLE_AGE_S else None

    def _detect(self, now: datetime, cohorts: list[tuple[str, str | None]]) -> int:
        ist = now.astimezone(IST)
        session = ist.date().isoformat()
        opened = 0
        for cohort, expiry in cohorts:
            if expiry is None:
                continue
            a = self.straddle.summary(expiry)
            env = a.get("environment")
            if a.get("status") != "ok" or a.get("session") != session or env is None or not (a.get("quality") or {}).get("live"):
                continue
            score = (env.get("seller") or {}).get("score")
            arm = self.store.arm_get(session, cohort)
            new, fire = next_arm(arm, score, now)
            if fire:
                made = self._open(now, session, cohort, expiry, a, env, new["count"])
                if made == 0:  # no usable prices this minute: keep the trigger armed and try again next minute
                    new = arm
                opened += made
            if new != arm:
                self.store.arm_set(session, cohort, new["count"], new["armed"], new["below_since"])
        return opened

    def _open(self, now: datetime, session: str, cohort: str, expiry: str, a: dict[str, Any], env: dict[str, Any], n: int) -> int:
        s = self._latest_sample(expiry, now)
        if s is None or s.spot is None:
            return 0
        c = self.obs.contracts(s.values_from)
        listed = sorted({k for k, _ in c})
        if not listed:
            return 0
        atm = min(listed, key=lambda k: abs(k - s.spot))
        step_pts = min((abs(k - atm) for k in listed if k != atm), default=50.0)
        legs = {"straddle": (atm, atm), "strangle": (atm + step_pts, atm - step_pts)}
        ist = now.astimezone(IST)
        hist = a.get("history") or {}
        spots = [x for x in (hist.get("spot") or []) if x]
        rv, reg, ev = a.get("realised_vs_implied") or {}, a.get("regime") or {}, env.get("evidence") or {}
        context = {
            "dte": (date.fromisoformat(expiry) - ist.date()).days, "weekday": ist.weekday(), "minute": ist.hour * 60 + ist.minute, "expiry_day": bool(a.get("expiry_day")),
            "orderflow": ev.get("orderflow"), "heavy15": ev.get("heavy15"), "cvd": ev.get("cvd"), "vwap_pct": ev.get("vwap_pct"), "positioning": ev.get("positioning"),
            "path_eff_30": reg.get("path_efficiency_30m"), "accel": (reg.get("accel") or {}).get("ratio"), "iv_now": rv.get("iv_now"), "iv_open": rv.get("iv_open"),
            "rv_gap_15": (rv.get("gap") or {}).get("15"), "rv_gap_60": (rv.get("gap") or {}).get("60"), "implied_move_pts": rv.get("implied_move_pts"),
            "climate": (a.get("climate") or {}).get("label"), "spot_vs_open_pct": round((s.spot - spots[0]) / spots[0] * 100, 3) if spots else None,
        }  # fmt: skip
        made = 0
        for structure, (ce_k, pe_k) in legs.items():
            ce0, pe0 = _price(c.get((float(ce_k), CALL))), _price(c.get((float(pe_k), PUT)))
            if ce0 is None or pe0 is None:
                continue
            trade = {
                "session": session, "cohort": cohort, "expiry": expiry, "structure": structure, "n": n, "trigger_at": now.isoformat(timespec="seconds"), "spot0": s.spot,
                "ce_strike": float(ce_k), "pe_strike": float(pe_k), "ce0": ce0, "pe0": pe0, "lot": self.lot, "seller": (env.get("seller") or {}).get("score"),
                "buyer": (env.get("buyer") or {}).get("score"), "regime": (a.get("regime") or {}).get("label"), "context": context,
                "track": {"first": s.spot, "last": s.spot, "hi": s.spot, "lo": s.spot, "path": 0.0}, "last_sample_ms": int(s.received_at.timestamp() * 1000),
            }  # fmt: skip
            if self.store.add_trade(trade, {v: new_state() for v, _, _ in VARIANTS}) is not None:
                made += 1
        return made

    def _advance(self, now: datetime) -> int:
        """Feed every open position the samples stored since it was last looked at, and settle those whose 15:20 has passed."""
        settled = 0
        for t in self.store.open_trades():
            day = date.fromisoformat(t["session"])
            close = datetime.combine(day, CLOSE_AT, IST)
            until = min(now, close)
            since = datetime.fromtimestamp(t["last_sample_ms"] / 1000 + 0.001, UTC)
            states = {v: r["state"] for v, r in self.store.variants_of(t["id"]).items()}
            track = t["track"]
            last_ms = t["last_sample_ms"]
            for s in self.obs.samples(self.underlying, t["expiry"], since=since, until=until):
                c = self.obs.contracts(s.values_from)
                ce, pe = _price(c.get((t["ce_strike"], CALL))), _price(c.get((t["pe_strike"], PUT)))
                at = s.received_at.astimezone(IST).strftime("%H:%M")
                for v, st in states.items():
                    if not is_done(st):
                        states[v] = step(v, t["ce0"], t["pe0"], st, ce, pe, at)
                if s.spot is not None:
                    track["path"] = track.get("path", 0.0) + abs(s.spot - track["last"])
                    track.update(last=s.spot, hi=max(track["hi"], s.spot), lo=min(track["lo"], s.spot))
                last_ms = max(last_ms, int(s.received_at.timestamp() * 1000))
            self.store.save_progress(t["id"], last_ms, track, states)
            if now >= close:
                results = {v: settle(v, t["ce0"], t["pe0"], st, t["lot"], self.cost) for v, st in states.items()}
                self.store.settle_trade(t["id"], now, self._eod(t, track), results)
                settled += 1
        return settled

    @staticmethod
    def _eod(t: dict[str, Any], track: dict[str, Any]) -> dict[str, Any]:
        s0, last, hi, lo, path = t["spot0"], track["last"], track["hi"], track["lo"], track.get("path", 0.0)
        rng = hi - lo
        net = last - s0
        return {
            "range_pts": round(rng, 2), "range_pct": round(rng / s0 * 100, 3) if s0 else None, "net_move_pts": round(net, 2), "net_move_pct": round(net / s0 * 100, 3) if s0 else None,
            "path_eff": round(abs(net) / path, 3) if path else None, "max_up": round(hi - s0, 2), "max_down": round(s0 - lo, 2),
            "trend_day": bool(rng > 0 and abs(net) / rng >= 0.6 and rng / s0 * 100 >= 0.3),
        }  # fmt: skip

    # ------------------------------------------------------------------ views
    def overview(self, structure: str = "all", cohort: str = "all", rule: str = "hold", dim: str = "regime") -> dict[str, Any]:
        rule = rule if rule in LABELS else "hold"
        trades = analytics.filtered(self.store.settled(), structure, cohort)
        counts = self.store.counts()
        now = self._clock()
        last = self.store.last_run()
        open_rows = []
        for t in self.store.open_trades():
            if (structure != "all" and t["structure"] != structure) or (cohort != "all" and t["cohort"] != cohort):
                continue
            vs = self.store.variants_of(t["id"])
            marks = {}
            for v, r in vs.items():
                st = r["state"]
                ce = st["ce_x"] if st["ce_x"] is not None else st["last_ce"]
                pe = st["pe_x"] if st["pe_x"] is not None else st["last_pe"]
                marks[v] = {"pnl": None if ce is None or pe is None else round(((t["ce0"] - ce) + (t["pe0"] - pe)) * t["lot"], 2), "ce_open": st["ce_open"], "pe_open": st["pe_open"], "stopped_at": st["stopped_at"]}
            open_rows.append({
                "id": t["id"], "session": t["session"], "cohort": t["cohort"], "expiry": t["expiry"], "structure": t["structure"], "n": t["n"], "trigger_at": t["trigger_at"],
                "ce_strike": t["ce_strike"], "pe_strike": t["pe_strike"], "ce0": t["ce0"], "pe0": t["pe0"], "spot0": t["spot0"], "spot": t["track"].get("last"), "seller": t["seller"],
                "regime": t["regime"], "variants": marks,
            })  # fmt: skip
        return {
            "generated_at": now.isoformat(timespec="seconds"), "filters": {"structure": structure, "cohort": cohort, "rule": rule, "rule_label": LABELS[rule]},
            "meta": {
                "enabled": self.enabled, "counts": counts, "last_run": last, "last_tick": None if self.last_tick is None else self.last_tick.isoformat(timespec="seconds"), "last_error": self.last_error,
                "bytes": self.store.size_bytes(), "min_trades": analytics.MIN_TRADES,
                "setup": {"trigger": f"seller score of the expiry reaches {THRESHOLD:g}", "rearm": f"after {REARM_MIN} minutes below {THRESHOLD:g}, at most {CAP_PER_DAY} a day per cohort", "entry_window": "09:30-14:30 IST", "exit": "15:20 IST the same day", "lot": self.lot},
            },
            "rules": analytics.variant_table(trades), "portfolio": analytics.portfolio(trades, rule), "breakdown": analytics.breakdown(trades, dim, rule), "open": open_rows,
        }  # fmt: skip

    # ------------------------------------------------------------------ lifecycle
    async def tick(self) -> None:
        now = self._clock().replace(second=0, microsecond=0)
        try:
            weekly, monthly = await self._expiries()
            res = await asyncio.to_thread(self.run_once, now, weekly, monthly)
            self.last_error = None
            if res["opened"] or res["settled"]:
                self.store.add_run(now, True, res)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - the forward test must never stop the application
            self.last_error = f"{type(e).__name__}: {str(e)[:160]}"
            logger.warning("forward_test_tick_failed", extra={"fields": {"error": self.last_error}})
            self.store.add_run(now, False, {"error": self.last_error})
        self.last_tick = now

    async def _loop(self) -> None:
        await asyncio.sleep(20)
        while True:
            await self.tick()
            await asyncio.sleep(max(5.0, 60.0 - self._clock().second))

    def start(self) -> None:
        if self.enabled and self._task is None:
            self._task = asyncio.create_task(self._loop(), name="forward-test")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
