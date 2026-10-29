"""T+1 (overnight) and T+5 (broad) direction research.

Two separate models families with separate inputs:
* T+1 uses only what is known by 08:30 IST on the next session: NIFTY's own last session, India VIX,
  the US/Europe/Asia closes, commodities, FX and yields dated on or before the reference session.
* T+5 adds sector strength, trend/vol context of the global series, and (when enough history exists)
  NSE participant positions in a separate "+flows" variant evaluated on its own shorter history.

Protocol (fixed before looking at results): purged expanding walk-forward folds; the earlier half
tunes hyper-parameters AND fits the probability calibrator; the later half is an untouched holdout
where every verdict is scored. A "call" (up/down) is made only when all base models agree and the
ensemble is clearly away from the base rate; otherwise the answer is "no call". A model is better
only if the Bonferroni-adjusted block-bootstrap interval of its Brier gain excludes zero.
Computation runs in a background thread and is cached; nothing is invented or forward-filled.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import math
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

from app.prediction.calendar import SessionLookup, TradingCalendar
from app.prediction.evaluation import (
    brier,
    calibration_bins,
    climatology_probability,
    empirical_quantile,
    log_loss,
    walk_forward_splits,
    wilson_interval,
)
from app.prediction.events import EventCalendar
from app.prediction.features_multi import (
    FLOW_NAMES,
    T1_CORE,
    T1_NAMES,
    T1_VERSION,
    T5_CORE,
    T5_NAMES,
    T5_VERSION,
    build_rows,
)
from app.prediction.history_store import HistoryStore
from app.prediction.ledger import Forecast, ForecastLedger, LedgerError
from app.prediction.models import _np, fit_boost, fit_logistic
from app.prediction.pit import IST, forecast_cutoff
from app.prediction.sources.yahoo import SYMBOLS
from app.prediction.targets import Bar, make_labels

MODEL_VERSION = "3"
REPORT_SCHEMA = 5  # bump whenever the stored report gains or changes fields, so an older cached report is recomputed
INITIAL_TRAIN = 1000
TEST_SIZE = 250
HORIZON_N: dict[str, int] = {"T1": 1, "T5": 5}
VARIANTS = ("T1", "T5", "T5F")  # T5F = T+5 with NSE participant positions (own, shorter history)
QUANTILES = (0.05, 0.25, 0.5, 0.75, 0.95)
BASE_MODELS = ("logit-all", "logit-core", "boost-all")
ENSEMBLE = "ensemble"
FRESH_KEYS = ("SPX", "VIX", "BRENT", "DXY", "USDINR", "UST10Y")  # must have a bar dated on/after the reference session
WINDOW = ((8, 35), (9, 10))  # IST: forecasts are recorded only inside this window
#: no model training or evaluation while the cash market is open (keeps the models away from the
#: live session and leaves the CPU to the collectors); the cached report is still served
MARKET_HOURS = ((9, 15), (15, 45))  # IST, weekdays that are trading sessions
EXCLUDED = [
    "news tone (collection started 29 Oct; too little history to train on)",
    "scheduled events (shown as risk flags, not model inputs)",
    "GIFT Nifty (no free history)",
    "FII/DII cash (NSE refuses automated download; the window is only 7 days)",
]


def _fit_logit(X: Any, y: list[int], p: dict[str, Any], core: tuple[int, ...]) -> Any:
    return fit_logistic(X, y, l2=p["l2"])


def _fit_core(X: Any, y: list[int], p: dict[str, Any], core: tuple[int, ...]) -> Any:
    m = fit_logistic([[r[i] for i in core] for r in X], y, l2=p["l2"])

    class _Sub:
        def predict_proba(self, Z: Any) -> list[float]:
            return m.predict_proba([[r[i] for i in core] for r in Z])

    return _Sub()


def _fit_boost(X: Any, y: list[int], p: dict[str, Any], core: tuple[int, ...]) -> Any:
    return fit_boost(X, y, rounds=p["rounds"], depth=p["depth"], lr=0.03)


MODELS: dict[str, tuple[str, Callable[..., Any], list[dict[str, Any]]]] = {
    "logit-all": ("Logistic regression, all features", _fit_logit, [{"l2": v} for v in (5, 50, 500, 5000)]),
    "logit-core": ("Logistic regression, a-priori core features", _fit_core, [{"l2": v} for v in (5, 50, 500, 5000)]),
    "boost-all": ("Boosted shallow trees (nonlinear), all features", _fit_boost, [{"depth": d, "rounds": r} for d in (1, 2) for r in (80, 200)]),
}  # fmt: skip
N_COMPARISONS = (len(MODELS) + 1) * len(VARIANTS)
STRICT_ALPHA = 0.05 / N_COMPARISONS


@dataclass
class _Data:
    names: list[str]
    sessions: list[date]
    X: list[list[float]]
    y: list[int]
    rets: list[float]
    core: tuple[int, ...]
    x_now: list[float] | None


def _core_idx(variant: str, names: list[str]) -> tuple[int, ...]:
    core = list(T1_CORE if variant == "T1" else T5_CORE) + (["fii_net_fut_share", "fii_net_fut_share_chg_5d"] if variant == "T5F" else [])
    return tuple(names.index(c) for c in core)


def _dataset(nifty: list[Bar], others: dict[str, list[Bar]], flows: Any, variant: str) -> _Data:
    horizon = "T1" if variant == "T1" else "T5"
    names, rows = build_rows(nifty, others, horizon, flows, with_flows=variant == "T5F")
    labels = make_labels(nifty)
    lab = (
        [(x.reference_session, x.positive, x.close_to_close) for x in labels.t1]
        if horizon == "T1"
        else [(x.reference_session, x.positive, x.ret5) for x in labels.t5]
    )
    lab = [r for r in lab if r[0] in rows]
    return _Data(
        names, [r[0] for r in lab], [rows[r[0]] for r in lab], [int(r[1]) for r in lab], [r[2] for r in lab],
        _core_idx(variant, names), rows.get(nifty[-1].session),
    )  # fmt: skip


def _block_bootstrap_ci(d: list[float], block: int = 20, reps: int = 2000, alpha: float = 0.05) -> tuple[float, float]:
    np = _np()
    a = np.asarray(d, dtype=float)
    m = len(a)
    block = min(block, m)
    cs = np.concatenate([[0.0], np.cumsum(a)])
    nb = math.ceil(m / block)
    starts = np.random.default_rng(0).integers(0, m - block + 1, size=(reps, nb))
    means = (cs[starts + block] - cs[starts]).sum(axis=1) / (nb * block)
    return float(np.percentile(means, 100 * alpha / 2)), float(np.percentile(means, 100 * (1 - alpha / 2)))


def _score(pm: list[float], pc: list[float], ys: list[int]) -> dict[str, Any]:
    m = len(ys)
    hits = sum((p > 0.5) == bool(t) for p, t in zip(pm, ys, strict=True))
    d = [(c - t) ** 2 - (p - t) ** 2 for p, c, t in zip(pm, pc, ys, strict=True)]
    lo, hi = _block_bootstrap_ci(d)
    slo, _ = _block_bootstrap_ci(d, alpha=STRICT_ALPHA)
    gain, b_c = sum(d) / m, brier(pc, ys)
    return {
        "n": m, "brier": brier(pm, ys), "log_loss": log_loss(pm, ys), "hit": hits / m, "hit_ci": list(wilson_interval(hits, m)),
        "gain": gain, "gain_ci95": [lo, hi], "gain_ci_strict_low": slo, "skill": gain / b_c,
        "verdict": "better" if slo > 0 else "promising" if lo > 0 else "worse" if hi < 0 else "no_difference",
    }  # fmt: skip


def _logit(p: float) -> float:
    p = min(max(p, 1e-6), 1 - 1e-6)
    return math.log(p / (1 - p))


class _Platt:
    """Probability calibration: logistic regression of the outcome on logit(p), fitted on tuning-period predictions only."""

    def __init__(self, p: list[float], y: list[int]) -> None:
        self.m = fit_logistic([[_logit(v)] for v in p], y, l2=1.0)

    def __call__(self, p: list[float]) -> list[float]:
        return self.m.predict_proba([[_logit(v)] for v in p])


def evaluate(data: _Data, variant: str, *, initial_train: int = INITIAL_TRAIN, test_size: int = TEST_SIZE) -> tuple[dict[str, Any], dict[str, Any]]:
    """Returns (JSON-able evaluation, fitted helpers for the live forecast)."""
    n = len(data.y)
    horizon = "T1" if variant == "T1" else "T5"
    splits = list(walk_forward_splits(n, initial_train=initial_train, test_size=test_size, horizon=HORIZON_N[horizon], embargo=0))
    if len(splits) < 2:
        return {"available": False, "reason": f"needs at least {initial_train + 2 * test_size} labelled sessions with every input present, have {n}"}, {}
    n_tune = len(splits) // 2
    ys_f = [[data.y[i] for i in te] for _, te in splits]
    base_f = [[climatology_probability([data.y[i] for i in tr])] * len(te) for tr, te in splits]
    preds: dict[str, list[list[list[float]]]] = {}
    for name, (_, fit, grid) in MODELS.items():
        preds[name] = []
        for params in grid:
            per_fold = []
            for tr, te in splits:
                mdl = fit([data.X[i] for i in tr], [data.y[i] for i in tr], params, data.core)
                per_fold.append(mdl.predict_proba([data.X[i] for i in te]))
            preds[name].append(per_fold)

    def cat(parts: list[list[Any]], lo: int, hi: int) -> list[Any]:
        return [v for f in parts[lo:hi] for v in f]

    L = len(splits)
    ys_tune, ys_hold = cat(ys_f, 0, n_tune), cat(ys_f, n_tune, L)
    pc_tune, pc_hold = cat(base_f, 0, n_tune), cat(base_f, n_tune, L)
    chosen = {nm: min(range(len(MODELS[nm][2])), key=lambda k, nm=nm: brier(cat(preds[nm][k], 0, n_tune), ys_tune)) for nm in MODELS}  # type: ignore[misc]
    raw: dict[str, list[list[float]]] = {nm: preds[nm][chosen[nm]] for nm in MODELS}
    raw[ENSEMBLE] = [[(a + b) / 2 for a, b in zip(fa, fb, strict=True)] for fa, fb in zip(raw["logit-all"], raw["boost-all"], strict=True)]
    platt = {nm: _Platt(cat(parts, 0, n_tune), ys_tune) for nm, parts in raw.items()}
    cal = {nm: platt[nm](cat(parts, 0, L)) for nm, parts in raw.items()}  # calibrated, flat over all folds
    sizes = [len(f) for f in ys_f]
    models_out: dict[str, Any] = {}
    for nm, parts in raw.items():
        flat_cal, flat_raw = cal[nm], cat(parts, 0, L)
        t_end = sum(sizes[:n_tune])
        hold = _score(flat_cal[t_end:], pc_hold, ys_hold)
        tune_raw = _score(flat_raw[:t_end], pc_tune, ys_tune)
        folds, pos = [], 0
        for k, (_, te) in enumerate(splits):
            seg = flat_cal[pos : pos + sizes[k]]
            pos += sizes[k]
            folds.append({"start": str(data.sessions[te[0]]), "end": str(data.sessions[te[-1]]), "n": len(te), "brier_model": brier(seg, ys_f[k]), "brier_base": brier(base_f[k], ys_f[k]), "phase": "tuning" if k < n_tune else "holdout"})  # fmt: skip
        models_out[nm] = {
            "description": MODELS[nm][0] if nm in MODELS else "Average of the tuned logit-all and boost-all, then calibrated",
            "params": MODELS[nm][2][chosen[nm]] if nm in MODELS else None,
            "holdout": hold,
            "holdout_raw_brier": brier(flat_raw[t_end:], ys_hold),
            "tuning": {"n": tune_raw["n"], "brier": tune_raw["brier"], "gain": tune_raw["gain"], "skill": tune_raw["skill"]},
            "calibration": [{"low": b.low, "high": b.high, "n": b.n, "predicted": b.mean_predicted, "observed": b.observed_frequency} for b in calibration_bins(flat_cal[t_end:], ys_hold, 10) if b.n],  # fmt: skip
            "folds": folds,
        }  # fmt: skip
    # ---- confidence / no-call rule, threshold set on the tuning period only
    t_end = sum(sizes[:n_tune])
    bases = pc_tune + pc_hold
    ens = cal[ENSEMBLE]
    agree = [len({cal[b][i] > bases[i] for b in BASE_MODELS}) == 1 for i in range(len(bases))]
    strength = [abs(ens[i] - bases[i]) for i in range(len(bases))]
    tau = empirical_quantile(sorted(strength[:t_end]), 0.75)
    called = [i for i in range(t_end, len(bases)) if agree[i] and strength[i] >= tau]
    ys_all = ys_tune + ys_hold
    calls: dict[str, Any] = {"threshold": tau, "rule": "all three base models on the same side of the base rate and the ensemble at least as far from it as the top quarter of tuning-period predictions", "n_holdout": len(ys_hold), "n_called": len(called)}  # fmt: skip
    if len(called) >= 30:
        hit = sum((ens[i] > bases[i]) == bool(ys_all[i]) for i in called)
        up = sum(ys_all[i] for i in called)
        calls.update(hit=hit / len(called), hit_ci=list(wilson_interval(hit, len(called))), always_up_hit=up / len(called), always_up_ci=list(wilson_interval(up, len(called))), coverage=len(called) / len(ys_hold))  # fmt: skip
        calls["verdict"] = "promising" if calls["hit_ci"][0] > calls["always_up_hit"] else "no_edge_shown"
    else:
        calls["verdict"] = "too_few_calls"
    ev = {
        "available": True, "n_labelled": n,
        "tuning_period": [str(data.sessions[splits[0][1][0]]), str(data.sessions[splits[n_tune - 1][1][-1]])],
        "holdout_period": [str(data.sessions[splits[n_tune][1][0]]), str(data.sessions[splits[-1][1][-1]])],
        "base": {"brier_holdout": brier(pc_hold, ys_hold), "brier_coin_flip": 0.25, "up_rate_holdout": sum(ys_hold) / len(ys_hold)},
        "models": models_out,
        "best_on_tuning": min(models_out, key=lambda k: models_out[k]["tuning"]["brier"]),
        "calls": calls, "features": data.names,
        "method": f"calibrated on tuning period; moving-block bootstrap (20 sessions, 2000 resamples); strict test allows for {N_COMPARISONS} comparisons (alpha {STRICT_ALPHA:.4f})",
    }  # fmt: skip
    return ev, {"chosen": {nm: MODELS[nm][2][chosen[nm]] for nm in MODELS}, "platt": platt, "tau": tau}


def _forecast_payloads(data: _Data, ev: dict[str, Any], helpers: dict[str, Any]) -> dict[str, dict[str, Any]]:
    assert data.x_now is not None  # noqa: S101 - caller checks
    tail = data.rets[-750:]
    common = {
        "p_up_climatology": climatology_probability(data.y),
        "p_up_climatology_recent_750": climatology_probability(data.y[-750:]),
        "return_quantiles_climatological": {str(q): empirical_quantile(tail, q) for q in QUANTILES},
    }
    raw: dict[str, float] = {}
    out: dict[str, dict[str, Any]] = {}
    for name, (_, fit, _) in MODELS.items():
        mdl = fit(data.X, data.y, helpers["chosen"][name], data.core)
        raw[name] = mdl.predict_proba([data.x_now])[0]
    raw[ENSEMBLE] = (raw["logit-all"] + raw["boost-all"]) / 2
    pcal = {nm: helpers["platt"][nm]([p])[0] for nm, p in raw.items()}
    base = common["p_up_climatology"]
    side = {b: pcal[b] > base for b in BASE_MODELS}
    strength = abs(pcal[ENSEMBLE] - base)
    if len(set(side.values())) != 1:
        call, why = None, "models disagree"
    elif strength < helpers["tau"]:
        call, why = None, "signal too close to the base rate"
    else:
        call, why = ("up" if pcal[ENSEMBLE] > base else "down"), "models agree and the signal is strong"
    full = fit_logistic(data.X, data.y, l2=helpers["chosen"]["logit-all"]["l2"])
    contrib = sorted(zip(data.names, full.contributions(data.x_now), strict=True), key=lambda t: -abs(t[1]))[:5]
    for nm in raw:
        out[nm] = {
            "p_up_model": pcal[nm], "p_up_raw": raw[nm], "model_verdict": ev["models"][nm]["holdout"]["verdict"],
            "params": ev["models"][nm]["params"], "call": call if nm == ENSEMBLE else None, "call_reason": why if nm == ENSEMBLE else None,
            "call_strength": strength if nm == ENSEMBLE else None, "call_threshold": helpers["tau"] if nm == ENSEMBLE else None,
            "top_drivers": [{"feature": f, "log_odds": c, "value": data.x_now[data.names.index(f)]} for f, c in contrib] if nm == "logit-all" else [],
            **common,
        }  # fmt: skip
    return out


class PredictionResearch:
    def __init__(
        self,
        store: HistoryStore,
        ledger: ForecastLedger,
        calendar: SessionLookup | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        initial_train: int = INITIAL_TRAIN,
        test_size: int = TEST_SIZE,
        cache_dir: Any = None,
        flows: Any = None,
        events: EventCalendar | None = None,
        pause_in_market_hours: bool = True,
    ) -> None:
        self._pause_in_market_hours = pause_in_market_hours
        self._store, self._ledger, self._clock, self._flows_store = store, ledger, clock, flows
        self._calendar = calendar
        self._events = events if events is not None else EventCalendar.load()
        self._it, self._ts = initial_train, test_size
        self._lock = threading.Lock()
        self._cache: tuple[tuple[Any, ...], dict[str, Any]] | None = None
        self._worker: threading.Thread | None = None
        self._error: str | None = None
        self._task: asyncio.Task[None] | None = None
        self._morning_done: date | None = None
        self._cache_file = None if cache_dir is None else cache_dir / "prediction_report.json"
        self._runs_file = None if cache_dir is None else cache_dir / "prediction_runs.json"
        self._runs: dict[str, dict[str, Any]] = self._load_runs()

    def _load_runs(self) -> dict[str, dict[str, Any]]:
        if self._runs_file is None or not self._runs_file.exists():
            return {}
        try:
            doc = json.loads(self._runs_file.read_text("utf-8"))
        except (OSError, ValueError):
            return {}
        return doc if isinstance(doc, dict) else {}

    def _mark(self, horizons: list[str], trigger: str, now: datetime) -> None:
        """When each horizon's models were last computed successfully, by the schedule or by hand."""
        with self._lock:
            for h in horizons:
                r = self._runs.setdefault(h, {})
                r["last_auto" if trigger == "auto" else "last_manual"] = {"at": now.isoformat()}
            if self._runs_file is not None:
                with contextlib.suppress(OSError):
                    self._runs_file.write_text(json.dumps(self._runs), "utf-8")

    def _cal(self) -> SessionLookup:
        if self._calendar is None:
            self._calendar = TradingCalendar.load()
        return self._calendar

    def market_hours(self, now: datetime) -> bool:
        ist = now.astimezone(IST)
        if not MARKET_HOURS[0] <= (ist.hour, ist.minute) < MARKET_HOURS[1] or ist.weekday() >= 5:
            return False
        try:
            return self._cal().is_session(ist.date())
        except Exception:  # noqa: BLE001 - calendar gap: the weekday rule above stands
            return True

    def _complete_bars(self, now: datetime) -> list[Bar]:
        bars = self._store.bars("NIFTY50")
        ist = now.astimezone(IST)
        if bars and bars[-1].session >= ist.date() and ist.hour < 16:
            bars = [b for b in bars if b.session < ist.date()]  # today's bar may still be forming
        return bars

    def _others(self) -> dict[str, list[Bar]]:
        return {s.key: self._store.bars(s.key) for s in SYMBOLS if s.key != "NIFTY50" and s.timing_verified}

    def _flows(self) -> dict[date, dict[str, dict[str, int]]]:
        return self._flows_store.participant_rows("fao_participant_oi") if self._flows_store is not None else {}

    def _read_disk(self, key: list[Any]) -> dict[str, Any] | None:
        if self._cache_file is None or not self._cache_file.exists():
            return None
        try:
            doc = json.loads(self._cache_file.read_text("utf-8"))
        except (OSError, ValueError):
            return None
        body = doc.get("key") == key and doc.get("body")
        return body if isinstance(body, dict) else None

    def _key(self, bars: list[Bar]) -> list[Any]:
        others = self._store.coverage()
        stamp = sorted((c["symbol"], c["last"], c["bars"]) for c in others)
        fl = self._flows_store.coverage()["fao_participant_oi"] if self._flows_store is not None else {}
        key = [str(bars[-1].session), len(bars), MODEL_VERSION, REPORT_SCHEMA, T1_VERSION, T5_VERSION, stamp, (fl.get("files") or 0) // 100]  # flows: re-evaluate only every ~100 new files
        out: list[Any] = json.loads(json.dumps(key))  # plain lists: equal after a JSON round trip
        return out

    def summary(self, force: bool = False, block: bool = False, trigger: str = "auto", only: str | None = None) -> dict[str, Any]:
        """``only`` = "T1" or "T5": retrain just that horizon's models and keep the other's stored result."""
        now = self._clock()
        bars = self._complete_bars(now)
        need = self._it + 2 * self._ts + 140
        if len(bars) < need:
            return {"ready": False, "reason": f"only {len(bars)} NIFTY 50 bars stored (need {need}); refresh the price history in Settings first"}
        key = self._key(bars)
        with self._lock:
            body = None if force else (self._cache[1] if self._cache and list(self._cache[0]) == key else self._read_disk(key))
            if body is not None:
                self._cache = (tuple(key), body)
            elif self._pause_in_market_hours and self.market_hours(now) and trigger != "manual":
                return {"ready": False, "paused": True, "reason": "Models are trained and evaluated only after the market closes (09:15-15:45 IST is excluded); the report will be computed then."}
            elif self._worker is None or not self._worker.is_alive():
                self._error = None
                base = None if only is None else (self._cache[1] if self._cache and list(self._cache[0]) == key else self._read_disk(key))
                self._worker = threading.Thread(target=self._run, args=(bars, key, now, trigger, only if base is not None else None, base), daemon=True, name="prediction-research")
                self._worker.start()
            worker = self._worker
        if body is None:
            if block and worker is not None:
                worker.join()
                return self.summary()
            if self._error:
                raise RuntimeError(self._error)
            return {"ready": False, "computing": True, "reason": "Training and evaluating models on the stored data. This takes a few minutes the first time and is then cached."}
        self._settle(bars)
        return {**body, "ledger": self._ledger_view(), "generated_at": now.isoformat(), "runs": self._runs, "computing": worker is not None and worker.is_alive()}

    def _run(self, bars: list[Bar], key: list[Any], now: datetime, trigger: str = "auto", only: str | None = None, base: dict[str, Any] | None = None) -> None:
        try:
            body = self._compute(bars, now, only)
            if only is not None and base is not None:
                body = self._merge(base, body, only)
        except Exception as e:  # noqa: BLE001 - surfaced to the page, never swallowed silently
            self._error = f"{type(e).__name__}: {e}"
            return
        with self._lock:
            self._cache = (tuple(key), body)
        if self._cache_file is not None:
            with contextlib.suppress(OSError):
                self._cache_file.write_text(json.dumps({"key": key, "body": body}), "utf-8")
        self._mark([only] if only else ["T1", "T5"], trigger, now)

    @staticmethod
    def _merge(base: dict[str, Any], new: dict[str, Any], hz: str) -> dict[str, Any]:
        """The stored report with one horizon's freshly trained part swapped in."""
        out = json.loads(json.dumps(base))
        variants = ("T1",) if hz == "T1" else ("T5", "T5F")
        for v in variants:
            if v in new["evaluation"]["horizons"]:
                out["evaluation"]["horizons"][v] = new["evaluation"]["horizons"][v]
        out["forecasts"][hz] = new["forecasts"][hz]
        out["data"]["up_rate_all"].update(new["data"]["up_rate_all"])
        out["data"]["inputs"].update(new["data"]["inputs"])
        out["data"]["overnight_data_fresh"], out["data"]["stale_series"] = new["data"]["overnight_data_fresh"], new["data"]["stale_series"]
        out["computed_at"] = new["computed_at"]
        return out  # type: ignore[no-any-return]

    def _fresh(self, others: dict[str, list[Bar]], ref: date, now: datetime) -> tuple[bool, list[str]]:
        stale = [k for k in FRESH_KEYS if k in others and (not others[k] or others[k][-1].session < ref)]
        done_at = datetime(ref.year, ref.month, ref.day, 3, 0, tzinfo=IST) + timedelta(days=1)  # US close + margin
        if not stale and now < done_at:
            stale = ["US session still open (complete after 03:00 IST)"]
        return not stale, stale

    def _compute(self, bars: list[Bar], now: datetime, only: str | None = None) -> dict[str, Any]:
        ref = bars[-1]
        others = self._others()
        flows = self._flows()
        fresh, stale = self._fresh(others, ref.session, now)
        horizons: dict[str, Any] = {}
        forecasts: dict[str, Any] = {"T1": {"models": {}}, "T5": {"models": {}}}
        ups: dict[str, float] = {}
        inputs: dict[str, dict[str, float]] = {}
        for v in VARIANTS:
            if only is not None and (v == "T1") != (only == "T1"):
                continue  # the other horizon keeps its stored result
            data = _dataset(bars, others, flows, v)
            if v == "T5F" and len(data.y) < self._it + 2 * self._ts:
                horizons[v] = {"available": False, "reason": f"NSE participant history is too short so far ({len(data.y)} usable sessions; needs {self._it + 2 * self._ts}); it keeps growing as files download"}
                continue
            ev, helpers = evaluate(data, v, initial_train=self._it, test_size=self._ts)
            horizons[v] = ev
            if not ev.get("available"):
                continue
            ups[v] = sum(data.y) / len(data.y)
            hz = "T1" if v == "T1" else "T5"
            if v != "T5F" and data.x_now is not None:
                inputs[v] = {n: x for n, x in zip(data.names, data.x_now, strict=True)}
            if data.x_now is None:
                forecasts[hz]["models"].update({f"{nm}{'+flows' if v == 'T5F' else ''}": {"recorded": False, "reason": "an input for the reference session is missing; no value is guessed", "reference_session": str(ref.session), "reference_close": ref.close, "payload": None} for nm in (*MODELS, ENSEMBLE)})  # fmt: skip
                continue
            payloads = _forecast_payloads(data, ev, helpers)
            for nm, pl in payloads.items():
                label = f"{nm}+flows" if v == "T5F" else nm
                forecasts[hz]["models"][label] = self._forecast(hz, label, bars, ref, pl, now, fresh, stale)
            if v != "T5F":
                forecasts[hz]["headline_model"] = ev["best_on_tuning"]
                forecasts[hz]["calls"] = {"call": payloads[ENSEMBLE]["call"], "reason": payloads[ENSEMBLE]["call_reason"], "strength": payloads[ENSEMBLE]["call_strength"], "threshold": payloads[ENSEMBLE]["call_threshold"]}  # fmt: skip
        return {
            "ready": True, "model_version": MODEL_VERSION,
            "features": {"T1": {"version": T1_VERSION, "names": list(T1_NAMES)}, "T5": {"version": T5_VERSION, "names": list(T5_NAMES), "flows": list(FLOW_NAMES)}},
            "data": {"symbol": "NIFTY 50 (^NSEI via Yahoo Finance) + global/sector series + NSE participant files", "bars": len(bars), "first": str(bars[0].session), "last": str(ref.session), "reference_close": ref.close, "up_rate_all": ups, "overnight_data_fresh": fresh, "stale_series": stale, "inputs": inputs},  # fmt: skip
            "evaluation": {"initial_train": self._it, "test_size": self._ts, "scheme": "expanding window purged by the label horizon; early half tunes and calibrates, later half is an untouched holdout", "horizons": horizons},
            "forecasts": forecasts, "excluded_inputs": EXCLUDED, "computed_at": now.isoformat(),
        }  # fmt: skip

    def _forecast(self, h: str, model: str, bars: list[Bar], ref: Bar, payload: dict[str, Any], now: datetime, fresh: bool, stale: list[str]) -> dict[str, Any]:
        out: dict[str, Any] = {"reference_session": str(ref.session), "reference_close": ref.close, "payload": payload}
        try:
            cal = self._cal()
            first, target = cal.next_session(ref.session, 1), cal.next_session(ref.session, HORIZON_N[h])
        except Exception as e:  # noqa: BLE001 - e.g. calendar coverage; reported, not hidden
            return {**out, "recorded": False, "reason": f"target session unknown: {e}"}
        out.update(first_target_session=str(first), target_session=str(target))
        ref_close = datetime(ref.session.year, ref.session.month, ref.session.day, 15, 30, tzinfo=IST)
        end_day = first if h == "T1" else target
        window_end = datetime(end_day.year, end_day.month, end_day.day, 15, 30, tzinfo=IST)
        risk = [e.public() for e in self._events.between(ref_close, window_end)]
        payload["event_risk"] = risk
        high = [e for e in risk if e["impact"] == "high"]
        if h == "T1" and payload.get("call") and high:  # precaution, not a validated improvement
            payload["call"], payload["call_reason"] = None, f"event risk: {high[0]['name']} before the target close (calls are withheld around high-impact events)"
        out["payload"] = payload
        ist = now.astimezone(IST)
        in_window = ist.date() == first and WINDOW[0] <= (ist.hour, ist.minute) < WINDOW[1]
        if not fresh:
            return {**out, "recorded": False, "preview": True, "reason": f"preview: overnight bars not yet in for {', '.join(stale)}"}
        if not in_window:
            return {**out, "recorded": False, "preview": True, "reason": "preview: forecasts are recorded between 08:35 and 09:10 IST on the target day"}
        f = Forecast(
            horizon=h,  # type: ignore[arg-type]
            model_name=model, model_version=MODEL_VERSION, dataset_version=f"yahoo+nse:{ref.session}:{len(bars)}",
            feature_version=T1_VERSION if h == "T1" else T5_VERSION, cutoff=forecast_cutoff(first, 8, 30), generated_at=now,
            reference_session=ref.session, reference_price=ref.close, first_target_session=first, target_session=target,
            payload=payload, data_quality={"bars": len(bars), "last_bar": str(ref.session)}, excluded_inputs=list(EXCLUDED),
        )  # fmt: skip
        try:
            return {**out, "recorded": True, "forecast_id": self._ledger.record(f)}
        except LedgerError as e:
            existing = self._ledger.get(h, f.forecast_id)  # type: ignore[arg-type]
            if existing is not None:
                return {**out, "recorded": True, "forecast_id": f.forecast_id, "payload": existing["forecast"]["payload"], "already_recorded": True}
            return {**out, "recorded": False, "reason": str(e)}

    def _ledger_view(self) -> dict[str, Any]:
        def brief(r: dict[str, Any]) -> dict[str, Any]:
            f = r["forecast"]
            return {
                "forecast_id": f["forecast_id"], "model": f["model_name"], "model_version": f["model_version"],
                "reference_session": f["reference_session"], "target_session": f["target_session"],
                "generated_at": f["generated_at"], "p_up_model": f["payload"].get("p_up_model"),
                "p_up_climatology": f["payload"].get("p_up_climatology"), "intact": r["intact"], "outcome": r["outcome"],
                "drivers": f["payload"].get("top_drivers") or [], "call": f["payload"].get("call"),
            }  # fmt: skip

        return {
            "counts": self._ledger.counts(),
            "recent": {h: [brief(r) for r in self._ledger.list(h, 60)] for h in ("T1", "T5")},
            "scoreboard": {h: self._scoreboard(h) for h in ("T1", "T5")},
        }

    def _scoreboard(self, h: str) -> dict[str, Any]:
        """Real forward results per model: only forecasts recorded before their outcome, scored after it."""
        agg: dict[str, dict[str, list[float]]] = {}
        for r in self._ledger.list(h, 1000):  # type: ignore[arg-type]
            if r["outcome"] is None:
                continue
            f = r["forecast"]
            p, base = f["payload"].get("p_up_model"), f["payload"].get("p_up_climatology")
            y = 1.0 if r["outcome"]["realized"]["positive"] else 0.0
            if p is None or base is None:
                continue
            a = agg.setdefault(f["model_name"], {"model": [], "base": [], "hit": []})
            a["model"].append((p - y) ** 2)
            a["base"].append((base - y) ** 2)
            a["hit"].append(1.0 if (p > 0.5) == bool(y) else 0.0)
        out: dict[str, Any] = {}
        for nm, a in agg.items():
            n = len(a["hit"])
            hits = int(sum(a["hit"]))
            out[nm] = {"n": n, "brier": sum(a["model"]) / n, "brier_base": sum(a["base"]) / n, "hit": hits / n, "hit_ci": list(wilson_interval(hits, n))}
        return out

    def _settle(self, bars: list[Bar]) -> None:
        labels = make_labels(bars)
        tables: dict[str, dict[date, Any]] = {"T1": {x.reference_session: x for x in labels.t1}, "T5": {x.reference_session: x for x in labels.t5}}
        for h, table in tables.items():
            for r in self._ledger.list(h, 500):  # type: ignore[arg-type]
                if r["outcome"] is not None:
                    continue
                lab = table.get(date.fromisoformat(r["forecast"]["reference_session"]))
                if lab is None:
                    continue
                realized = {"close_to_close": lab.close_to_close, "gap": lab.gap, "positive": lab.positive} if h == "T1" else {"ret5": lab.ret5, "positive": lab.positive}
                with contextlib.suppress(LedgerError):
                    self._ledger.attach_outcome(h, r["forecast"]["forecast_id"], realized)  # type: ignore[arg-type]

    # ------------------------------------------------------------------ daily morning run
    def _window_due(self, now: datetime) -> bool:
        ist = now.astimezone(IST)
        return ist.weekday() < 5 and WINDOW[0] <= (ist.hour, ist.minute) < WINDOW[1]

    def morning_ready(self, now: datetime) -> bool:
        """Inside the 08:35-09:10 window, not yet recorded today, and every overnight series has its final bar."""
        if not self._window_due(now) or self._morning_done == now.astimezone(IST).date():
            return False
        bars = self._complete_bars(now)
        return bool(bars) and self._fresh(self._others(), bars[-1].session, now)[0]

    async def _loop(self) -> None:
        await asyncio.sleep(30)
        while True:
            try:
                now = self._clock()
                # Train and record only when the overnight data is complete. If a series is late, look again in
                # four minutes until the window closes instead of giving the day up (a stale run is only a preview).
                if self.morning_ready(now):
                    self._morning_done = now.astimezone(IST).date()
                    await asyncio.to_thread(self.summary, True, True)  # force: new overnight data must be used
            except Exception:  # noqa: BLE001 - the scheduler must survive
                self._error = "morning run failed"
            await asyncio.sleep(240)

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

