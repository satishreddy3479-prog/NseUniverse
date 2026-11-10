"""A compact, stored summary of the intraday model research, so other pages can show it without recomputing anything.

The intraday model is a research pipeline, not a deployed predictor: every finished session is turned into labelled feature rows
(``dataset.py``), and ``evaluate.walk_forward`` tests a regularised logistic model against simple baselines on later sessions only. A gate
(``evaluate.gate``) decides whether probabilities may be shown at all; until it passes none is shown anywhere. The full evaluation is
CPU-heavy, so it runs once a day after the close; this module keeps the result of the last run as a small JSON file.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import datetime
from pathlib import Path
from typing import Any

FILE = "intraday_ml_digest.json"
BASELINES = ("majority", "momentum", "opening_range", "vwap")


def digest(res: Mapping[str, Any], horizon: int, k: float, now: datetime) -> dict[str, Any]:
    """The parts of an evaluation worth showing: what was tested, how each model scored (lower log loss is better), and why the gate said what it said."""
    models: dict[str, Any] = {}
    for name, m in (res.get("models") or {}).items():
        models[name] = {"log_loss": m.get("log_loss"), "brier": m.get("brier"), "n": m.get("n"), "ece": (m.get("calibration") or {}).get("ece")}
    base = [models[b]["log_loss"] for b in BASELINES if b in models and models[b]["log_loss"] is not None]
    lg = (models.get("logistic") or {}).get("log_loss")
    gate = res.get("gate") or {}
    return {
        "computed_at": now.isoformat(timespec="seconds"), "horizon_minutes": horizon, "barrier_k": k,
        "status": res.get("status"), "sessions": res.get("sessions"), "test_sessions": res.get("test_sessions"), "rows": res.get("rows"),
        "effective_observations": res.get("effective_observations"), "dropped": res.get("dropped"), "reason": res.get("reason"),
        "models": models, "best_baseline_log_loss": min(base) if base else None, "model_log_loss_gain": None if lg is None or not base else round(min(base) - lg, 5),
        "feature_groups": res.get("feature_groups"),
        "gate": {"status": gate.get("status"), "show_probabilities": bool(gate.get("show_probabilities")), "beat_share": gate.get("beat_share"), "mean_log_loss_gain": gate.get("mean_log_loss_gain"),
                 "sign_test_p": gate.get("sign_test_p"), "ece": gate.get("ece"), "reasons": gate.get("reasons") or []},
        "note": res.get("note"),
    }


def save(folder: Path, d: Mapping[str, Any]) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / (FILE + ".tmp")
    tmp.write_text(json.dumps(d), encoding="utf-8")
    tmp.replace(folder / FILE)  # a reader never sees a half-written file


def load(folder: Path) -> dict[str, Any] | None:
    try:
        d = json.loads((folder / FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) else None


def due(last: Mapping[str, Any] | None, now_ist: datetime, close_hhmm: tuple[int, int] = (15, 45)) -> bool:
    """Compute once per session day, only after the close (the plan keeps training out of market hours)."""
    if now_ist.weekday() >= 5 or (now_ist.hour, now_ist.minute) < close_hhmm:
        return False
    try:
        return last is None or datetime.fromisoformat(str(last["computed_at"])).astimezone(now_ist.tzinfo).date() < now_ist.date()
    except (KeyError, ValueError, TypeError):
        return True
