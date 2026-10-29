"""Chronological evaluation of probability models against baselines (pure Python, no numpy dependency).

Rows: {"session", "features": {name: float|None}, "outcome": "up"|"down"|"none"} for one horizon (ambiguous and
missing outcomes are dropped before and counted in the report). Splits are whole sessions in time order
(walk-forward, expanding window): a session is only ever predicted by a model fitted on earlier sessions, so no
sample or horizon window crosses the train/test boundary. Samples within a session overlap (one per minute for a
horizon of many minutes), so the report also gives the number of independent-looking observations
(rows / horizon steps) and the gate looks at sessions, not rows.
Models: majority class, momentum-state frequencies, opening-range-state frequencies (all fitted on the training sessions
only, with Laplace smoothing) and a regularised multinomial logistic regression. A VWAP baseline joins when the
dataset carries a VWAP feature.
Probabilities are shown to a user only if the gate passes (``gate``): never on a handful of sessions.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from typing import Any

CLASSES = ("up", "down", "none")
GROUPS: dict[str, tuple[str, ...]] = {
    "price": ("ret_5m", "ret_15m", "ret_30m", "from_prev_close_pct", "er_5m", "position_in_range", "above_or_high", "below_or_low", "minutes_since_open"),
    "options": ("pcr_oi", "straddle_change_pct", "oi_imbalance"),
    "volatility": ("iv_atm", "iv_chg_15m", "skew_25d"),
    "vwap_flow": ("fut_vwap_dist_pct", "fut_cvd_share", "fut_depth_imb"),
    "breadth": ("ad_balance", "breadth_mom_15m", "breadth_eq_return"),
    "breakout": ("breakout_state", "breakout_quality"),
}  # fmt: skip
FEATURES = tuple(f for g in GROUPS.values() for f in g)
MIN_SESSIONS_EXPERIMENTAL = 5
MIN_SESSIONS_VALIDATED = 20
GATE_BEAT_SHARE = 0.6
GATE_MAX_ECE = 0.05
EPS = 1e-9

Row = dict[str, Any]
Predictor = Callable[[Mapping[str, float | None]], list[float]]


# ----------------------------------------------------------------------------------------------- metrics
def _onehot(o: str) -> list[float]:
    return [1.0 if o == c else 0.0 for c in CLASSES]


def log_loss(probs: Sequence[Sequence[float]], outcomes: Sequence[str]) -> float:
    return -sum(math.log(max(EPS, p[CLASSES.index(o)])) for p, o in zip(probs, outcomes, strict=True)) / len(outcomes)


def brier(probs: Sequence[Sequence[float]], outcomes: Sequence[str]) -> float:
    """Multiclass Brier score: mean over rows of the sum over classes of (p - y)^2 (0 best, 2 worst)."""
    return sum(sum((pi - yi) ** 2 for pi, yi in zip(p, _onehot(o), strict=True)) for p, o in zip(probs, outcomes, strict=True)) / len(outcomes)


def confusion(probs: Sequence[Sequence[float]], outcomes: Sequence[str]) -> dict[str, dict[str, int]]:
    m = {a: dict.fromkeys(CLASSES, 0) for a in CLASSES}
    for p, o in zip(probs, outcomes, strict=True):
        m[o][CLASSES[max(range(3), key=lambda i: p[i])]] += 1
    return m


def accuracy_stats(probs: Sequence[Sequence[float]], outcomes: Sequence[str]) -> dict[str, Any]:
    cm = confusion(probs, outcomes)
    n = len(outcomes)
    correct = sum(cm[c][c] for c in CLASSES)
    recalls = {c: (cm[c][c] / sum(cm[c].values()) if sum(cm[c].values()) else None) for c in CLASSES}
    precisions = {c: (cm[c][c] / sum(cm[a][c] for a in CLASSES) if sum(cm[a][c] for a in CLASSES) else None) for c in CLASSES}
    have = [r for r in recalls.values() if r is not None]
    return {"accuracy": correct / n, "balanced_accuracy": sum(have) / len(have) if have else None, "recall": recalls, "precision": precisions, "confusion": cm}


def calibration(probs: Sequence[Sequence[float]], outcomes: Sequence[str], bins: int = 10) -> dict[str, Any]:
    """Reliability of every predicted class probability pooled: mean predicted vs observed frequency per bin, and ECE."""
    pairs = [(p[i], 1.0 if CLASSES[i] == o else 0.0) for p, o in zip(probs, outcomes, strict=True) for i in range(3)]
    rows = []
    ece = 0.0
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        sel = [(p, y) for p, y in pairs if lo <= p < hi or (b == bins - 1 and p == 1.0)]
        if not sel:
            continue
        mp, my = sum(p for p, _ in sel) / len(sel), sum(y for _, y in sel) / len(sel)
        rows.append({"bin": f"{lo:.1f}-{hi:.1f}", "n": len(sel), "mean_predicted": round(mp, 4), "observed": round(my, 4)})
        ece += len(sel) / len(pairs) * abs(mp - my)
    return {"bins": rows, "ece": round(ece, 4)}


# ----------------------------------------------------------------------------------------------- models
def _freq(outcomes: Sequence[str], alpha: float = 1.0) -> list[float]:
    c = Counter(outcomes)
    tot = len(outcomes) + alpha * 3
    return [(c[k] + alpha) / tot for k in CLASSES]


def majority(train: Sequence[Row]) -> Predictor:
    p = _freq([r["outcome"] for r in train])
    return lambda _f: list(p)


def state_model(train: Sequence[Row], state: Callable[[Mapping[str, float | None]], str | None]) -> Predictor:
    by: dict[str | None, list[str]] = {}
    for r in train:
        by.setdefault(state(r["features"]), []).append(r["outcome"])
    base = _freq([r["outcome"] for r in train])
    table = {k: _freq(v) for k, v in by.items() if k is not None}
    return lambda f: list(table.get(state(f), base))


def momentum_state(f: Mapping[str, float | None]) -> str | None:
    r = f.get("ret_15m")
    return None if r is None else ("up" if r > 0.05 else "down" if r < -0.05 else "flat")


def opening_range_state(f: Mapping[str, float | None]) -> str | None:
    a, b = f.get("above_or_high"), f.get("below_or_low")
    return None if a is None or b is None else ("above" if a else "below" if b else "inside")


def vwap_state(f: Mapping[str, float | None]) -> str | None:
    d = f.get("fut_vwap_dist_pct")
    return None if d is None else ("above" if d > 0.02 else "below" if d < -0.02 else "at")


def _softmax(z: list[float]) -> list[float]:
    m = max(z)
    e = [math.exp(v - m) for v in z]
    s = sum(e)
    return [v / s for v in e]


def logistic(train: Sequence[Row], names: Sequence[str] = FEATURES, l2: float = 1.0, iters: int = 200, lr: float = 0.3) -> Predictor:
    """Multinomial logistic regression on standardised features; missing values take the training mean and, for features
    that are ever missing in training, add an indicator column. Full-batch gradient descent with L2 on the weights."""
    names = [n for n in names if any(r["features"].get(n) is not None for r in train)]
    stats: dict[str, tuple[float, float]] = {}
    miss: list[str] = []
    for n in names:
        vals = [r["features"][n] for r in train if r["features"].get(n) is not None]
        mu = sum(vals) / len(vals)
        sd = math.sqrt(sum((v - mu) ** 2 for v in vals) / len(vals)) or 1.0
        stats[n] = (mu, sd)
        if len(vals) < len(train):
            miss.append(n)

    def vec(f: Mapping[str, float | None]) -> list[float]:
        x = [((f.get(n) if f.get(n) is not None else stats[n][0]) - stats[n][0]) / stats[n][1] for n in names]  # type: ignore[operator]
        return [1.0, *x, *[1.0 if f.get(n) is None else 0.0 for n in miss]]

    xs = [vec(r["features"]) for r in train]
    ys = [CLASSES.index(r["outcome"]) for r in train]
    d, n = len(xs[0]), len(xs)
    w = [[0.0] * d for _ in CLASSES]
    for _ in range(iters):
        grad = [[0.0] * d for _ in CLASSES]
        for x, y in zip(xs, ys, strict=True):
            p = _softmax([sum(wi * xi for wi, xi in zip(w[c], x, strict=True)) for c in range(3)])
            for c in range(3):
                e = p[c] - (1.0 if c == y else 0.0)
                if e:
                    gc = grad[c]
                    for j in range(d):
                        gc[j] += e * x[j]
        for c in range(3):
            for j in range(d):
                w[c][j] -= lr * (grad[c][j] / n + (l2 / n * w[c][j] if j else 0.0))
    return lambda f: _softmax([sum(wi * xi for wi, xi in zip(w[c], vec(f), strict=True)) for c in range(3)])


# ----------------------------------------------------------------------------------------------- walk-forward
def walk_forward(rows: Sequence[Row], min_train_sessions: int = 3, stride: int = 1, has_vwap: bool = False, group_tests: bool = False) -> dict[str, Any]:
    sessions = sorted({r["session"] for r in rows})
    result: dict[str, Any] = {"sessions": len(sessions), "rows": len(rows)}
    if len(sessions) <= min_train_sessions:
        return result | {"status": "insufficient", "reason": f"needs more than {min_train_sessions} labelled sessions to test on a later one (has {len(sessions)})"}
    makers: dict[str, Callable[[Sequence[Row]], Predictor]] = {
        "majority": majority,
        "momentum": lambda tr: state_model(tr, momentum_state),
        "opening_range": lambda tr: state_model(tr, opening_range_state),
        "logistic": logistic,
    }
    if has_vwap:
        makers["vwap"] = lambda tr: state_model(tr, vwap_state)
    if group_tests:  # does each evidence group add anything to price alone?
        makers["logistic_price"] = lambda tr: logistic(tr, GROUPS["price"], iters=100)
        for g, cols in GROUPS.items():
            if g != "price" and sum(1 for r in rows if any(r["features"].get(c) is not None for c in cols)) >= 0.2 * len(rows):
                makers[f"logistic_price+{g}"] = lambda tr, _c=cols: logistic(tr, (*GROUPS["price"], *_c), iters=100)
    pooled: dict[str, tuple[list[list[float]], list[str]]] = {k: ([], []) for k in makers}
    per_session: list[dict[str, Any]] = []
    for i in range(min_train_sessions, len(sessions)):
        train = [r for r in rows if r["session"] in sessions[:i]][::stride]
        test = [r for r in rows if r["session"] == sessions[i]]
        if not train or not test:
            continue
        one: dict[str, Any] = {"session": sessions[i], "n": len(test)}
        for name, make in makers.items():
            pred = make(train)
            probs = [pred(r["features"]) for r in test]
            outs = [r["outcome"] for r in test]
            pooled[name][0].extend(probs)
            pooled[name][1].extend(outs)
            one[name] = round(log_loss(probs, outs), 5)
        per_session.append(one)
    report: dict[str, Any] = {}
    for name, (probs, outs) in pooled.items():
        if outs:
            report[name] = {"log_loss": round(log_loss(probs, outs), 5), "brier": round(brier(probs, outs), 5), **accuracy_stats(probs, outs), "calibration": calibration(probs, outs), "n": len(outs)}
    if group_tests and "logistic_price" in report:
        result["feature_groups"] = {k.split("+", 1)[1]: {"log_loss": report[k]["log_loss"], "delta_vs_price_only": round(report[k]["log_loss"] - report["logistic_price"]["log_loss"], 5)}
                                    for k in report if k.startswith("logistic_price+")}  # fmt: skip
    result |= {"models": report, "per_session_log_loss": per_session, "test_sessions": len(per_session)}
    result["gate"] = gate(result)
    result["status"] = result["gate"]["status"]
    return result


def gate(res: Mapping[str, Any]) -> dict[str, Any]:
    """Whether probabilities may be shown. 'insufficient' / 'experimental' (labelled, not validated) / 'validated'."""
    n = res["sessions"]
    models = res.get("models", {})
    if "logistic" not in models:
        return {"status": "insufficient", "show_probabilities": False, "reasons": ["no test predictions"]}
    ps = res["per_session_log_loss"]
    baselines = [k for k in models if k in ("majority", "momentum", "opening_range", "vwap")]
    beat = sum(1 for s in ps if all(s["logistic"] < s[b] for b in baselines)) / len(ps) if ps else 0.0
    ece = models["logistic"]["calibration"]["ece"]
    reasons = []
    if n < MIN_SESSIONS_VALIDATED:
        reasons.append(f"only {n} labelled sessions (validation needs {MIN_SESSIONS_VALIDATED})")
    if beat < GATE_BEAT_SHARE:
        reasons.append(f"the model beat every baseline on log loss in {beat:.0%} of test sessions (needs {GATE_BEAT_SHARE:.0%})")
    if ece > GATE_MAX_ECE:
        reasons.append(f"calibration error {ece:.3f} exceeds {GATE_MAX_ECE}")
    ok = not reasons
    status = "validated" if ok else ("experimental" if n >= MIN_SESSIONS_EXPERIMENTAL else "insufficient")
    return {"status": status, "show_probabilities": ok, "beat_share": round(beat, 3), "ece": ece, "reasons": reasons, "label": None if ok else "EXPERIMENTAL MODEL: PROBABILITIES NOT VALIDATED"}
