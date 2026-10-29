"""Index weights estimated from our own recordings (used only when no official weights are loaded).

NIFTY return since the previous close = sum(weight_i x stock return_i) with the previous-close weights, so
regressing the index change on the 50 stock changes (recorded every minute) recovers the weights. The fit is
accepted only when it reproduces the index within a small error; otherwise no weights are produced.
Pure Python (no numpy dependency on the server)."""

from __future__ import annotations


def _solve(a: list[list[float]], b: list[float]) -> list[float] | None:
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        if abs(m[p][c]) < 1e-12:
            return None
        m[c], m[p] = m[p], m[c]
        for r in range(n):
            if r != c:
                f = m[r][c] / m[c][c]
                if f:
                    for k in range(c, n + 1):
                        m[r][k] -= f * m[c][k]
    return [m[i][n] / m[i][i] for i in range(n)]


def estimate(
    rows: list[tuple[float, dict[str, float]]],
    symbols: list[str],
    ridge: float = 1e-6,
    max_rmse: float = 0.03,
    min_rows: int = 150,
) -> tuple[dict[str, float], float] | None:
    """rows = [(index change %, {symbol: stock change %})]. Returns ({symbol: weight %}, rmse in index-% points)."""
    data = [(y, x) for y, x in rows if all(s in x for s in symbols)]
    if len(data) < min_rows:
        return None
    active = list(symbols)
    w: dict[str, float] = {}
    for _ in range(
        len(symbols)
    ):  # drop negative weights and refit (non-negative least squares by elimination)
        k = len(active)
        ata = [
            [sum(x[active[i]] * x[active[j]] for _, x in data) for j in range(k)] for i in range(k)
        ]
        atb = [sum(y * x[active[i]] for y, x in data) for i in range(k)]
        for i in range(k):
            ata[i][i] += ridge * (ata[i][i] or 1.0)
        sol = _solve(ata, atb)
        if sol is None:
            return None
        neg = [active[i] for i, v in enumerate(sol) if v < 0]
        if not neg:
            w = dict(zip(active, sol, strict=True))
            break
        worst = min(range(k), key=lambda i: sol[i])
        active.pop(worst)
    else:
        return None
    total = sum(w.values())
    if total <= 0:
        return None
    err = [y - sum(w.get(s, 0.0) * x[s] for s in symbols) for y, x in data]
    rmse = (sum(e * e for e in err) / len(err)) ** 0.5
    if rmse > max_rmse or not 0.9 <= total <= 1.1:
        return None
    return {s: round(v / total * 100, 3) for s, v in w.items()}, round(rmse, 4)
