"""Transparent models: standardised, L2-regularised logistic regression (numpy, Newton's method).

Research-only: numpy is imported lazily so the small server never needs it unless it computes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


def _np() -> Any:
    try:
        import numpy as np
    except ImportError as e:  # pragma: no cover - environment dependent
        raise RuntimeError(
            "numpy is required for model training (pip install -r requirements-dev.txt)"
        ) from e
    return np


@dataclass
class LogisticModel:
    mean: Any
    scale: Any
    weights: Any  # first entry is the intercept (not penalised)

    def standardise(self, X: Any) -> Any:
        np = _np()
        return np.clip((np.asarray(X, dtype=float) - self.mean) / self.scale, -5.0, 5.0)

    def predict_proba(self, X: Any) -> list[float]:
        np = _np()
        Z = self.standardise(X)
        A = np.hstack([np.ones((len(Z), 1)), Z])
        return [float(v) for v in 1.0 / (1.0 + np.exp(-np.clip(A @ self.weights, -30, 30)))]

    def contributions(self, x: list[float]) -> list[float]:
        """Per-feature contribution to the log-odds for one row (weight x standardised value)."""
        z = self.standardise([x])[0]
        return [float(w * v) for w, v in zip(self.weights[1:], z, strict=True)]


def fit_logistic(
    X: list[list[float]], y: list[int], *, l2: float = 50.0, iters: int = 30
) -> LogisticModel:
    np = _np()
    A0 = np.asarray(X, dtype=float)
    mean = A0.mean(axis=0)
    scale = A0.std(axis=0)
    scale[scale == 0] = 1.0
    model = LogisticModel(mean, scale, np.zeros(A0.shape[1] + 1))
    A = np.hstack([np.ones((len(A0), 1)), model.standardise(A0)])
    t = np.asarray(y, dtype=float)
    pen = np.eye(A.shape[1]) * l2
    pen[0, 0] = 0.0
    w = np.zeros(A.shape[1])
    for _ in range(iters):
        p = 1.0 / (1.0 + np.exp(-np.clip(A @ w, -30, 30)))
        grad = A.T @ (p - t) + pen @ w
        hess = (A.T * (p * (1 - p))) @ A + pen + 1e-9 * np.eye(A.shape[1])
        step = np.linalg.solve(hess, grad)
        w = w - step
        if float(np.max(np.abs(step))) < 1e-8:
            break
    model.weights = w
    return model


# --------------------------------------------------------------------------- boosted shallow trees
@dataclass
class BoostModel:
    """Gradient-boosted shallow trees for a binary target (logistic loss, Newton leaves)."""

    base: float
    edges: list[Any]
    trees: list[Any]  # ("leaf", v) | ("split", feature, threshold, left, right)
    lr: float

    def _apply(self, node: Any, X: Any, idx: Any, out: Any) -> None:
        if node[0] == "leaf":
            out[idx] += node[1]
            return
        _, f, thr, left, right = node
        go_left = X[idx, f] <= thr
        self._apply(left, X, idx[go_left], out)
        self._apply(right, X, idx[~go_left], out)

    def predict_proba(self, X: Any) -> list[float]:
        np = _np()
        A = np.asarray(X, dtype=float)
        score = np.full(len(A), self.base)
        idx = np.arange(len(A))
        for t in self.trees:
            delta = np.zeros(len(A))
            self._apply(t, A, idx, delta)
            score += self.lr * delta
        return [float(v) for v in 1.0 / (1.0 + np.exp(-np.clip(score, -30, 30)))]


def fit_boost(
    X: list[list[float]], y: list[int], *, rounds: int = 100, depth: int = 2, lr: float = 0.03,
    min_leaf: int = 60, l2: float = 20.0, bins: int = 16,
) -> BoostModel:  # fmt: skip
    np = _np()
    A = np.asarray(X, dtype=float)
    t = np.asarray(y, dtype=float)
    n, d = A.shape
    edges = []
    binned = np.empty((n, d), dtype=np.int64)
    for j in range(d):
        e = np.unique(np.quantile(A[:, j], np.linspace(0, 1, bins + 1)[1:-1]))
        edges.append(e)
        binned[:, j] = np.searchsorted(e, A[:, j], side="left")
    mean = min(max(float(t.mean()), 1e-3), 1 - 1e-3)
    base = float(np.log(mean / (1 - mean)))
    score = np.full(n, base)

    def build(idx: Any, g: Any, h: Any, level: int) -> Any:
        G, H = g[idx].sum(), h[idx].sum()
        leaf = ("leaf", float(-G / (H + l2)))
        if level == 0 or len(idx) < 2 * min_leaf:
            return leaf
        best = (1e-9, -1, -1)
        parent = G * G / (H + l2)
        for j in range(d):
            nb = len(edges[j]) + 1
            b = binned[idx, j]
            Gc = np.cumsum(np.bincount(b, weights=g[idx], minlength=nb))[:-1]
            Hc = np.cumsum(np.bincount(b, weights=h[idx], minlength=nb))[:-1]
            Cc = np.cumsum(np.bincount(b, minlength=nb))[:-1]
            ok = (Cc >= min_leaf) & (len(idx) - Cc >= min_leaf)
            if not ok.any():
                continue
            gain = Gc**2 / (Hc + l2) + (G - Gc) ** 2 / (H - Hc + l2) - parent
            gain = np.where(ok, gain, -np.inf)
            k = int(np.argmax(gain))
            if gain[k] > best[0]:
                best = (float(gain[k]), j, k)
        if best[1] < 0:
            return leaf
        _, j, k = best
        left = binned[idx, j] <= k
        return (
            "split", j, float(edges[j][k]),
            build(idx[left], g, h, level - 1), build(idx[~left], g, h, level - 1),
        )  # fmt: skip

    trees: list[Any] = []
    all_idx = np.arange(n)
    model = BoostModel(base, edges, trees, lr)
    for _ in range(rounds):
        p = 1.0 / (1.0 + np.exp(-np.clip(score, -30, 30)))
        g, h = p - t, p * (1 - p)
        tree = build(all_idx, g, h, depth)
        trees.append(tree)
        delta = np.zeros(n)
        model._apply(tree, A, all_idx, delta)
        score += lr * delta
    return model
