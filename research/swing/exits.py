"""Multi-day exit logic for the pre-move study (pure numpy, no ML dependency)."""

from __future__ import annotations

import numpy as np

MAX_GAP = 4.0  # skip entries whose open is more than this % above the previous close

EXITS = {  # name: (stop %, trail %, target %, max days incl. entry day)
    "stop3_hold3": (3.0, None, None, 3),
    "stop5_hold5": (5.0, None, None, 5),
    "stop5_hold10": (5.0, None, None, 10),
    "trail5_hold10": (5.0, 5.0, None, 10),
    "stop3_tgt8_hold5": (3.0, None, 8.0, 5),
}


def simulate(px: dict[str, np.ndarray], i: int, e: float, spec: tuple) -> float | None:
    """One trade: signal at bar i close, entry on bar i+1. Returns % return before costs."""
    stop_pct, trail_pct, tgt_pct, days = spec
    O, H, L, C = px["O"], px["H"], px["L"], px["C"]
    if i + days >= len(C):
        return None
    pc = C[i]
    o = O[i + 1]
    if (o / pc - 1) * 100 > MAX_GAP:
        return None
    trig = pc * (1 + e / 100)
    if H[i + 1] < trig:
        return None
    fill = max(o, trig)
    stop = fill * (1 - stop_pct / 100)
    tgt = fill * (1 + tgt_pct / 100) if tgt_pct else None
    hh = fill
    for d in range(days):
        j = i + 1 + d
        if d > 0 and O[j] <= stop:
            return (O[j] / fill - 1) * 100
        if L[j] <= stop:
            return (stop / fill - 1) * 100
        if tgt is not None and H[j] >= tgt:
            return ((max(O[j], tgt) if d > 0 else tgt) / fill - 1) * 100
        hh = max(hh, H[j])
        if trail_pct:
            stop = max(stop, hh * (1 - trail_pct / 100))
    return (C[i + days] / fill - 1) * 100
