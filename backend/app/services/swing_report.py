"""Serves the swing research report that research/swing writes to data/swing/report.json.

The backend only reads the finished file (stdlib only, no pandas): the backtest and the candidate
scan run on the research machine via scripts/swing-refresh.ps1.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

REPORT_PATH = Path("swing") / "report.json"
# A copy of the last built report travels with the release, so a server whose data folder has none
# still shows the backtest (meta says how old it is). A report in the data folder takes precedence.
_SWING_PKG = Path(__file__).resolve().parent.parent / "swing"
BUNDLED_REPORT = _SWING_PKG / "report.json"
SCHEMA = 1


class SwingReportError(RuntimeError):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def load_report(data_dir: Path) -> dict[str, Any]:
    path = data_dir / REPORT_PATH
    if not path.exists() and BUNDLED_REPORT.exists():
        path = BUNDLED_REPORT
    if not path.exists():
        raise SwingReportError(
            404, "swing_report_missing",
            "No swing report yet. Run scripts\\swing-refresh.ps1 to build it.",
        )
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise SwingReportError(
            503, "swing_report_unreadable", "The swing report file could not be read; rebuild it."
        ) from e
    if not isinstance(report, dict) or report.get("schema") != SCHEMA:
        raise SwingReportError(
            503, "swing_report_schema",
            f"The swing report has an unexpected format (expected schema {SCHEMA}); rebuild it.",
        )
    return report
