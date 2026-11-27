"""Live position monitor (paper only, read-only): what the running strategy's open option legs have earned from time, paid to NIFTY's move and to volatility since they were entered.

Every minute in market hours the server stores the NIFTY level and the last traded prices of the strikes around it (and of the legs). The price change of the position between two samples is
split with the straddle engine's own repricing (``straddle.attribute_leg``: theta, vega, delta, gamma, vanna, volga, residual), weighted by the legs' side and lots, and summed. Nothing is
estimated from a page: every figure comes from the running document and the live feed on the server, so every device shows the same numbers.

Sign convention: points of premium for ONE lot of each leg, positive = the position gained. A sold option gains when its price falls. Rupees = points x lot size x multiplier.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import threading
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.domain.session import session_close, spot_end
from app.intelligence import straddle as sd
from app.intraday.volatility import CALL, DEFAULT_RATE, PUT, TRADING_MINUTES_PER_YEAR

logger = logging.getLogger(__name__)
IST = timezone(timedelta(hours=5, minutes=30))
Doc = dict[str, Any]

#: provisional reference levels (not validated): the loss, as a share of the premium at entry, at which the position is flagged and at which it is in the stop zone
WATCH_LOSS_PCT = 15.0
STOP_LOSS_PCT = 30.0
#: share of the way to the re-strike distance at which the position is flagged / alarmed
DIST_WATCH = 0.6
DIST_ALERT = 0.9
#: minutes of attribution before "NIFTY cost against time income" is called (earlier it is dominated by single ticks)
RATIO_MIN_STEPS = 15
MAX_SAMPLES = 500
SAMPLE_EVERY_S = 50.0
NEAR_STRIKES = 7  # strikes nearest the index whose prices go into each sample (the forward comes from their put-call parity)
LIMITS = ("Model estimates (Black-76, forward from put-call parity, assumed rate) on last traded prices, before costs and slippage. The split of the premium change is a repricing, not an accounting identity: "
          "what it does not explain is shown as 'other'. The levels are provisional and not validated. Paper only.")


def open_legs(doc: Doc | None) -> list[Doc]:
    """The ticked option legs that are open and have an entry premium."""
    legs = (doc or {}).get("legs") or []
    return [lg for lg in legs if lg.get("enabled") is not False and lg.get("type") in ("CE", "PE") and lg.get("exitPrice") is None and lg.get("premium") is not None]


def weight(lg: Doc) -> float:
    """+lots for a bought leg, -lots for a sold one: the sign of the leg's price change in the position's result."""
    return (1.0 if lg.get("action") == "BUY" else -1.0) * float(lg.get("lots") or 0)


def signature(legs: list[Doc]) -> str:
    """Which entered position this is: a re-strike or any new entry changes it, and the monitor starts a fresh account."""
    return "|".join(sorted(f"{lg.get('expiry')}:{lg.get('strike')}:{lg.get('type')}:{lg.get('action')}:{lg.get('lots')}:{lg.get('enteredAt')}" for lg in legs))


def side_of(lg: Doc) -> int:
    return CALL if lg.get("type") == "CE" else PUT


def build_snap(at: datetime, spot: float | None, legs: list[Doc], ladder: list[Doc], price_of: Callable[[Doc], float | None]) -> sd.Snap:
    """The index level and the last traded prices of the strikes nearest it and of the legs' own contracts, from the live feed."""
    prices: dict[tuple[float, int], float | None] = {}
    if spot:
        near = sorted(ladder, key=lambda r: (abs(float(r["strike"]) - spot), float(r["strike"])))[:NEAR_STRIKES]
        for r in near:
            k = float(r["strike"])
            prices[(k, CALL)] = price_of({"key": r["ce"]})
            prices[(k, PUT)] = price_of({"key": r["pe"]})
    for lg in legs:  # the legs' own contracts, whether or not they are near the index
        k = float(lg["strike"])
        px = price_of(lg) if lg.get("key") else None
        if px is not None:
            prices[(k, side_of(lg))] = px
    return sd.Snap(at, spot, {k: (v if v is not None and v > 0 else None) for k, v in prices.items()})


def step_effects(pa: sd.Point, pb: sd.Point, legs: list[Doc]) -> dict[str, float] | None:
    """The position's change between two points, split: theta (time), vol (vega, vanna, volga), spot (delta and gamma), other (the repricing residual), and the total; None when a leg has no price or vol at either end."""
    out = dict.fromkeys(("theta", "vol", "spot", "other", "actual"), 0.0)
    for lg in legs:
        x = sd.attribute_leg(pa, pb, float(lg["strike"]), side_of(lg))
        if x is None:
            return None
        w = weight(lg)
        out["theta"] += w * x["theta"]
        out["vol"] += w * (x["vega"] + x["vanna"] + x["volga"])
        out["spot"] += w * (x["delta"] + x["gamma"])
        out["other"] += w * x["residual"]
        out["actual"] += w * x["actual"]
    return out


class PositionMonitor:
    """Samples the running strategy once a minute and serves the account. ``automation`` is the StrategyAutomation holding the running document, the live-price lookup and the strikes' feed keys."""

    def __init__(
        self,
        automation: Any,
        data_dir: Path,
        spot_key: str = "nse_cm|Nifty 50",
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        rate: float = DEFAULT_RATE,
    ) -> None:
        self.auto = automation
        self._path = data_dir / "position-monitor.json"
        self.spot_key = spot_key
        self._now = now
        self.rate = rate
        self._lock = threading.RLock()
        self._task: asyncio.Task[None] | None = None
        self.state: Doc = self._load()
        self._steps: list[dict[str, Any]] = []
        self._steps_for: str | None = None
        self.last_error: str | None = None

    # ------------------------------------------------------------------ file
    def _load(self) -> Doc:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            return raw if isinstance(raw, dict) and isinstance(raw.get("samples"), list) else {}
        except (OSError, ValueError):
            return {}

    def _save(self) -> None:
        tmp = self._path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(self.state), encoding="utf-8")
            os.replace(tmp, self._path)
        except OSError as exc:
            logger.warning("position_monitor_save_failed", extra={"fields": {"error": type(exc).__name__}})

    # ------------------------------------------------------------------ helpers
    def _spot(self) -> float | None:
        v = self.auto.price_of_key(self.spot_key)
        return float(v) if v is not None and v > 0 else None

    def _expiry_date(self, legs: list[Doc]) -> date | None:
        exps = {lg.get("expiry") for lg in legs}
        if len(exps) != 1:
            return None
        try:
            return date.fromisoformat(str(next(iter(exps))))
        except ValueError:
            return None

    def _snap_from_sample(self, s: Doc) -> sd.Snap:
        return sd.Snap(datetime.fromisoformat(s["t"]), s["spot"], {(float(k), CALL if side == "C" else PUT): px for k, side, px in s["prices"]})

    def _rebuild_steps(self, legs: list[Doc], exp: date) -> None:
        """The account from the stored samples of this position (a few hundred steps: a moment)."""
        self._steps = []
        prev: sd.Point | None = None
        for s in self.state.get("samples", []):
            pt, _why = sd.build_point(self._snap_from_sample(s), exp, self.rate)
            if prev is not None and pt is not None:
                fx = step_effects(prev, pt, legs)
                if fx is not None:
                    self._steps.append({"t": s["t"], **fx})
            prev = pt if pt is not None else prev
        self._steps_for = self.state.get("sig")

    # ------------------------------------------------------------------ sampling (once a minute)
    def sample(self) -> bool:
        """Store one sample when there is an open position, the stream is live and the session is open. True when a sample was stored."""
        at = self._now()
        with self._lock:
            doc = self.auto.get()
            legs = open_legs(doc)
            if not doc or not legs or not doc.get("lotSize") or not self.auto.is_live() or not self.auto.market_open(at):
                return False
            exp = self._expiry_date(legs)
            spot = self._spot()
            if exp is None or spot is None:
                return False
            sig = signature(legs)
            if self.state.get("sig") != sig:  # a new position: a fresh account
                self.state = {"sig": sig, "since": at.isoformat(), "samples": [], "events": []}
                self._steps, self._steps_for = [], sig
            samples: list[Doc] = self.state["samples"]
            if samples and (at - datetime.fromisoformat(samples[-1]["t"])).total_seconds() < SAMPLE_EVERY_S:
                return False
            ladder = self.auto._ladder(str(legs[0].get("expiry")))  # noqa: SLF001 - the automation's own, cached, strike -> feed key table
            snap = build_snap(at, spot, legs, ladder, lambda lg: self.auto.price_of_key(lg["key"]) if lg.get("key") else None)
            if not snap.prices:
                return False
            if self._steps_for != sig:
                self._rebuild_steps(legs, exp)
            pt, _why = sd.build_point(snap, exp, self.rate)
            if pt is not None and samples:
                prev_pt, _w = sd.build_point(self._snap_from_sample(samples[-1]), exp, self.rate)
                fx = step_effects(prev_pt, pt, legs) if prev_pt is not None else None
                if fx is not None:
                    self._steps.append({"t": at.isoformat(), **fx})
            samples.append({"t": at.isoformat(), "spot": spot, "prices": [[k, "C" if side == CALL else "P", px] for (k, side), px in snap.prices.items() if px is not None]})
            del samples[:-MAX_SAMPLES]
            self._note_events(doc, legs, at)
            self._save()
            return True

    # ------------------------------------------------------------------ the account
    def _pnl_points(self, legs: list[Doc], px_of: Callable[[Doc], float | None]) -> float | None:
        total = 0.0
        for lg in legs:
            px = px_of(lg)
            if px is None:
                return None
            total += weight(lg) * (px - float(lg["premium"]))
        return total

    def payload(self) -> Doc:
        """The monitor's answer: the account since the position was entered, the figures now, the status and the log."""
        at = self._now()
        with self._lock:
            doc = self.auto.get()
            legs = open_legs(doc)
            base: Doc = {"available": False, "reason": None, "as_of": at.isoformat(), "limits": LIMITS}
            if not doc or not legs:
                return {**base, "reason": "No open option leg in the running strategy."}
            lot, mult = int(doc.get("lotSize") or 0), float(doc.get("mult") or 1)
            if not lot:
                return {**base, "reason": "The running strategy has no lot size yet."}
            exp = self._expiry_date(legs)
            if exp is None:
                return {**base, "reason": "The monitor follows one expiry at a time: the open legs are in more than one."}
            live = bool(self.auto.is_live() and self.auto.market_open(at))
            spot = self._spot()
            if self.state.get("sig") != signature(legs):
                self.state = {}  # a position the sampler has not seen yet
            if self._steps_for != self.state.get("sig"):
                self._rebuild_steps(legs, exp)
            ladder = self.auto._ladder(str(legs[0].get("expiry")))  # noqa: SLF001
            snap_now = build_snap(at, spot, legs, ladder, lambda lg: self.auto.price_of_key(lg["key"]) if lg.get("key") else None)
            pt_now, why = sd.build_point(snap_now, exp, self.rate)
            if pt_now is None:
                return {**base, "reason": f"No reading now: {why}."}
            leg_rows: list[Doc] = []
            now_px: dict[int, float] = {}
            net_delta = 0.0
            ivs: list[float] = []
            for i, lg in enumerate(legs):
                leg_pt = pt_now.leg(float(lg["strike"]), side_of(lg))
                px = snap_now.prices.get((float(lg["strike"]), side_of(lg)))
                if px is None or leg_pt is None:
                    return {**base, "reason": f"No live price for {lg['action']} {lg['strike']} {lg['type']}."}
                now_px[i] = px
                net_delta += weight(lg) * leg_pt.g.delta
                ivs.append(leg_pt.iv)
                leg_rows.append({"label": f"{lg['action']} {lg['strike']:g} {lg['type']}", "entry": float(lg["premium"]), "now": round(px, 2), "delta": round(leg_pt.g.delta, 3), "iv_pct": round(leg_pt.iv * 100, 2)})
            pnl = sum(weight(lg) * (now_px[i] - float(lg["premium"])) for i, lg in enumerate(legs))
            entry_price = -sum(weight(lg) * float(lg["premium"]) for lg in legs)  # net premium taken in (positive: a credit)
            now_price = -sum(weight(lg) * now_px[i] for i, lg in enumerate(legs))
            basis = abs(entry_price) or None
            loss_pct = None if basis is None else -pnl / basis * 100
            # cumulative account: the stored steps, plus the step from the last stored sample to the live prices
            steps = list(self._steps)
            samples = self.state.get("samples", [])
            if samples:
                last_pt, _w = sd.build_point(self._snap_from_sample(samples[-1]), exp, self.rate)
                fx = step_effects(last_pt, pt_now, legs) if last_pt is not None else None
                if fx is not None and datetime.fromisoformat(samples[-1]["t"]) < at:
                    steps.append({"t": at.isoformat(), **fx})
            cum = {k: sum(s[k] for s in steps) for k in ("theta", "vol", "spot", "other", "actual")}
            other = pnl - cum["theta"] - cum["vol"] - cum["spot"]  # what the repricing does not explain, with the move from the entry price to the first sample
            time_income = cum["theta"]
            ratio = None
            if len(steps) >= RATIO_MIN_STEPS and time_income is not None and time_income > 0.05 and cum["spot"] < 0:
                ratio = round(-cum["spot"] / time_income, 2)
            strikes = {float(lg["strike"]) for lg in legs}
            same = next(iter(strikes)) if len(strikes) == 1 else None
            restrike = (doc.get("restrike") or {}).get("points") if isinstance(doc.get("restrike"), dict) else None
            distance: Doc | None = None
            if spot is not None and same is not None:
                local = at.astimezone(IST)
                end = spot_end(local.date()) or session_close()
                mins_left = max(0.0, (datetime.combine(local.date(), end, IST) - local).total_seconds() / 60)
                sigma = sum(ivs) / len(ivs)
                sd_move = spot * sigma * math.sqrt(mins_left / TRADING_MINUTES_PER_YEAR)
                off = spot - same
                distance = {"spot": round(spot, 2), "strike": same, "points": round(off, 1), "restrike_points": restrike, "share_of_restrike": None if not restrike else round(abs(off) / float(restrike), 2),
                            "expected_move": round(sd_move, 1), "share_of_expected": None if sd_move <= 0 else round(abs(off) / sd_move, 2), "minutes_left": round(mins_left)}
            status = self._status(loss_pct, ratio, distance)
            since = self.state.get("since")
            return {
                **base, "available": True, "live": live, "name": doc.get("loaded") or doc.get("name") or None, "expiry": exp.isoformat(), "lot_size": lot, "mult": mult, "since": since,
                "legs": leg_rows,
                "pnl": {"points": round(pnl, 2), "rupees": round(pnl * lot * mult), "booked_other_rupees": round(sum(float(lg.get("realised") or 0) for lg in (doc.get("legs") or [])))},
                "premium": {"entry": round(entry_price, 2), "now": round(now_price, 2), "loss_pct": None if loss_pct is None else round(loss_pct, 1), "watch_pct": WATCH_LOSS_PCT, "stop_pct": STOP_LOSS_PCT, "credit": entry_price > 0},
                "delta": {"net": round(net_delta, 3), "units": round(net_delta * lot * mult)},
                "attribution": {"theta": round(cum["theta"], 2), "vol": round(cum["vol"], 2), "spot": round(cum["spot"], 2), "other": round(other, 2), "total": round(pnl, 2), "ratio": ratio, "steps": len(steps)},
                "distance": distance, "status": status, "series": self._series(legs, steps), "events": self._events(doc),
            }

    def _status(self, loss_pct: float | None, ratio: float | None, distance: Doc | None) -> Doc:
        reasons: list[str] = []
        level = "ok"
        if loss_pct is not None and loss_pct >= STOP_LOSS_PCT:
            level = "alert"
            reasons.append(f"The position is {loss_pct:.0f}% against its entry premium (stop zone from {STOP_LOSS_PCT:.0f}%).")
        elif loss_pct is not None and loss_pct >= WATCH_LOSS_PCT:
            level = "watch"
            reasons.append(f"The position is {loss_pct:.0f}% against its entry premium (watch from {WATCH_LOSS_PCT:.0f}%).")
        share = None if not distance else distance.get("share_of_restrike")
        if share is not None and share >= DIST_ALERT:
            level = "alert"
            reasons.append(f"NIFTY is {share * 100:.0f}% of the way to the re-strike distance.")
        elif share is not None and share >= DIST_WATCH:
            level = "watch" if level == "ok" else level
            reasons.append(f"NIFTY is {share * 100:.0f}% of the way to the re-strike distance.")
        if ratio is not None and ratio > 1.0:
            level = "watch" if level == "ok" else level
            reasons.append(f"NIFTY's move has cost {ratio:.1f} times what time has paid.")
        text = {"ok": "Within its limits", "watch": "Watch: " + (reasons[0].rstrip(".").lower() if reasons else ""), "alert": "Act: " + (reasons[0].rstrip(".").lower() if reasons else "")}[level]
        return {"level": level, "text": text, "reasons": reasons}

    def _series(self, legs: list[Doc], steps: list[dict[str, Any]]) -> Doc:
        """Cumulative time, volatility and NIFTY-move effects and the position's result at each stored minute, at most 150 points."""
        samples = self.state.get("samples", [])
        t, th, vo, sp, tot = [], [], [], [], []
        cth = cvo = csp = 0.0
        by_t = {s["t"]: s for s in steps}
        for s in samples:
            fx = by_t.get(s["t"])
            if fx:
                cth, cvo, csp = cth + fx["theta"], cvo + fx["vol"], csp + fx["spot"]
            pnl = 0.0
            ok = True
            for lg in legs:
                px = next((p for k, side, p in s["prices"] if float(k) == float(lg["strike"]) and side == ("C" if lg.get("type") == "CE" else "P")), None)
                if px is None:
                    ok = False
                    break
                pnl += weight(lg) * (px - float(lg["premium"]))
            t.append(s["t"])
            th.append(round(cth, 2))
            vo.append(round(cvo, 2))
            sp.append(round(csp, 2))
            tot.append(round(pnl, 2) if ok else None)
        stride = max(1, -(-len(t) // 150))
        pick = list(range(0, len(t), stride))
        if t and pick[-1] != len(t) - 1:
            pick.append(len(t) - 1)
        return {"t": [t[i] for i in pick], "theta": [th[i] for i in pick], "vol": [vo[i] for i in pick], "spot": [sp[i] for i in pick], "total": [tot[i] for i in pick]}

    # ------------------------------------------------------------------ the log
    def _note_events(self, doc: Doc | None, legs: list[Doc], at: datetime) -> None:
        """Remember the first minute each level was crossed (once per position), from the figures the monitor itself serves."""
        try:
            p = self.payload_light(doc, legs, at)
        except Exception:  # noqa: BLE001 - the log must never stop a sample
            return
        have = {e["key"] for e in self.state.get("events", [])}
        for key, text in p:
            if key not in have:
                self.state.setdefault("events", []).append({"key": key, "at": at.isoformat(), "text": text})

    def payload_light(self, doc: Doc | None, legs: list[Doc], at: datetime) -> list[tuple[str, str]]:
        out: list[tuple[str, str]] = []
        samples = self.state.get("samples", [])
        if not samples:
            return [("entered", "The monitor started following this position.")]
        spot = samples[-1].get("spot")
        strikes = {float(lg["strike"]) for lg in legs}
        restrike = ((doc or {}).get("restrike") or {}).get("points") if isinstance((doc or {}).get("restrike"), dict) else None
        if spot and restrike and len(strikes) == 1:
            share = abs(spot - next(iter(strikes))) / float(restrike)
            for lvl in (DIST_WATCH, DIST_ALERT):
                if share >= lvl:
                    out.append((f"dist{int(lvl * 100)}", f"NIFTY is {lvl * 100:.0f}% of the way to the re-strike distance ({share * 100:.0f}% now)."))
        steps = self._steps
        if len(steps) >= RATIO_MIN_STEPS:
            th, spx = sum(s["theta"] for s in steps), sum(s["spot"] for s in steps)
            if th > 0.05 and spx < 0 and -spx > th:
                out.append(("ratio1", "NIFTY's move has cost more than time has paid."))
        return out

    def _events(self, doc: Doc | None) -> list[Doc]:
        own = [{"at": e["at"], "text": e["text"]} for e in self.state.get("events", [])]
        server = [{"at": e.get("at"), "text": str(e.get("text", "")).replace(" [server]", "")} for e in ((doc or {}).get("serverEvents") or [])[-5:] if e.get("at")]
        return sorted([*own, *server], key=lambda e: str(e["at"]), reverse=True)[:12]

    # ------------------------------------------------------------------ lifecycle
    async def _run(self) -> None:
        while True:
            try:
                await asyncio.to_thread(self.sample)
                self.last_error = None
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                self.last_error = f"{type(exc).__name__}: {exc}"[:200]
                logger.warning("position_monitor_error", extra={"fields": {"error": self.last_error}})
            await asyncio.sleep(20)

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass


__all__ = ["PositionMonitor", "open_legs", "signature", "step_effects", "build_snap", "weight"]
