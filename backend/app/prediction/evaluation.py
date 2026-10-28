"""Evaluation primitives: purged walk-forward splits, probability and return metrics, baselines.

Pure Python on purpose (no numpy/sklearn): these run anywhere, including the small server. Heavy
model training happens off-server. Everything here assumes chronological order and never shuffles.
"""

from __future__ import annotations

import math
from collections.abc import Iterator, Sequence
from dataclasses import dataclass


# ---------------------------------------------------------------------------- splitting
def walk_forward_splits(
    n: int,
    *,
    initial_train: int,
    test_size: int,
    horizon: int,
    embargo: int = 0,
    step: int | None = None,
) -> Iterator[tuple[list[int], list[int]]]:
    """Expanding-window walk-forward splits over ``n`` chronologically ordered samples.

    Sample ``i`` has a label that depends on observations through ``i + horizon`` (horizon = 1 for
    T+1, 5 for T+5). A training sample is kept only if its label window ends before the test window
    starts (minus ``embargo``), so overlapping five-session labels cannot leak across the boundary.
    """
    if min(initial_train, test_size) < 1 or horizon < 0 or embargo < 0:
        raise ValueError("initial_train and test_size must be >= 1; horizon and embargo >= 0")
    step = step or test_size
    start = initial_train
    while start + test_size <= n:
        train_end = start - horizon - embargo  # exclusive: i + horizon < start - embargo
        train = list(range(0, max(0, train_end)))
        test = list(range(start, start + test_size))
        if train:
            yield train, test
        start += step


# ---------------------------------------------------------------------------- probability metrics
def brier(p: Sequence[float], y: Sequence[int]) -> float:
    _check(p, y)
    return sum((a - b) ** 2 for a, b in zip(p, y, strict=True)) / len(p)


def log_loss(p: Sequence[float], y: Sequence[int], eps: float = 1e-15) -> float:
    _check(p, y)
    tot = 0.0
    for a, b in zip(p, y, strict=True):
        a = min(max(a, eps), 1 - eps)
        tot += -(b * math.log(a) + (1 - b) * math.log(1 - a))
    return tot / len(p)


@dataclass(frozen=True)
class CalibrationBin:
    low: float
    high: float
    n: int
    mean_predicted: float | None
    observed_frequency: float | None


def calibration_bins(p: Sequence[float], y: Sequence[int], bins: int = 10) -> list[CalibrationBin]:
    """Reliability table. Empty bins are reported as empty (None), not as zero."""
    _check(p, y)
    out = []
    for k in range(bins):
        lo, hi = k / bins, (k + 1) / bins
        idx = [i for i, a in enumerate(p) if (lo <= a < hi) or (k == bins - 1 and a == 1.0)]
        if idx:
            out.append(
                CalibrationBin(
                    lo,
                    hi,
                    len(idx),
                    sum(p[i] for i in idx) / len(idx),
                    sum(y[i] for i in idx) / len(idx),
                )
            )
        else:
            out.append(CalibrationBin(lo, hi, 0, None, None))
    return out


def wilson_interval(successes: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Confidence interval for a hit rate; wide when n is small, which is the honest message."""
    if n <= 0:
        raise ValueError("n must be positive")
    p = successes / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, centre - half), min(1.0, centre + half)


def balanced_accuracy(pred: Sequence[int], y: Sequence[int]) -> float | None:
    """Mean of recall per class; None when a class is absent (it is not defined then)."""
    _check(pred, y)
    rec = []
    for c in (0, 1):
        idx = [i for i, b in enumerate(y) if b == c]
        if not idx:
            return None
        rec.append(sum(1 for i in idx if pred[i] == c) / len(idx))
    return sum(rec) / 2


# ---------------------------------------------------------------------------- return metrics
def mae(pred: Sequence[float], y: Sequence[float]) -> float:
    _check(pred, y)
    return sum(abs(a - b) for a, b in zip(pred, y, strict=True)) / len(y)


def rmse(pred: Sequence[float], y: Sequence[float]) -> float:
    _check(pred, y)
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(pred, y, strict=True)) / len(y))


def pinball(pred_q: Sequence[float], y: Sequence[float], tau: float) -> float:
    """Quantile (pinball) loss for quantile level ``tau``."""
    _check(pred_q, y)
    if not 0 < tau < 1:
        raise ValueError("tau must be in (0, 1)")
    return sum(
        max(tau * (b - q), (tau - 1) * (b - q)) for q, b in zip(pred_q, y, strict=True)
    ) / len(y)


def interval_coverage(
    lo: Sequence[float], hi: Sequence[float], y: Sequence[float]
) -> tuple[float, float]:
    """(fraction of outcomes inside [lo, hi], mean interval width)."""
    _check(lo, y)
    _check(hi, y)
    inside = sum(1 for a, b, v in zip(lo, hi, y, strict=True) if a <= v <= b)
    return inside / len(y), sum(b - a for a, b in zip(lo, hi, strict=True)) / len(y)


# -------------------------------------------------------------- baselines (train data only)
def climatology_probability(train_y: Sequence[int]) -> float:
    """Frequency of the positive class in TRAINING data: the bar every classifier must beat."""
    if not train_y:
        raise ValueError("no training labels")
    return sum(train_y) / len(train_y)


def historical_mean(train_returns: Sequence[float]) -> float:
    if not train_returns:
        raise ValueError("no training returns")
    return sum(train_returns) / len(train_returns)


def empirical_quantile(values: Sequence[float], tau: float) -> float:
    """Interpolated sample quantile of TRAINING returns (unconditional-distribution baseline)."""
    if not values or not 0 <= tau <= 1:
        raise ValueError("need values and tau in [0, 1]")
    s = sorted(values)
    pos = tau * (len(s) - 1)
    lo = math.floor(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def _check(a: Sequence[object], b: Sequence[object]) -> None:
    if len(a) != len(b) or not a:
        raise ValueError("inputs must be non-empty and the same length")
