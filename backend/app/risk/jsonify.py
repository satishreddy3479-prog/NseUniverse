"""Turn the engine's dataclasses and NumPy values into plain JSON: a missing number (NaN or infinite) becomes null, never zero and never the invalid token NaN."""

from __future__ import annotations

import dataclasses
import math
from collections.abc import Mapping
from datetime import date, datetime
from typing import Any

import numpy as np


def to_json(x: Any) -> Any:
    """Recursively convert ``x`` to JSON-safe values (dicts, lists, strings, finite numbers, booleans, None)."""
    if x is None or isinstance(x, (bool, str)):
        return x
    if isinstance(x, (np.bool_,)):
        return bool(x)
    if isinstance(x, (int, np.integer)):
        return int(x)
    if isinstance(x, (float, np.floating)):
        v = float(x)
        return v if math.isfinite(v) else None
    if isinstance(x, np.ndarray):
        return [to_json(v) for v in x.tolist()]
    if dataclasses.is_dataclass(x) and not isinstance(x, type):
        return {f.name: to_json(getattr(x, f.name)) for f in dataclasses.fields(x)}
    if isinstance(x, Mapping):
        return {str(k): to_json(v) for k, v in x.items()}
    if isinstance(x, (list, tuple, set, frozenset)):
        return [to_json(v) for v in x]
    if isinstance(x, (datetime, date)):
        return x.isoformat()
    raise TypeError(f"cannot serialise {type(x).__name__}")
