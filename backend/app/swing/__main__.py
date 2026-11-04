"""Run one swing paper-trading pass by hand: python -m app.swing --data-dir PATH

Same job the server runs after 17:00 IST (settle the last session, scan, queue orders), using the
real Chartink and Yahoo data. Use a scratch --data-dir to try it without touching the live book.
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

from app.swing.engine import Config
from app.swing.fetch import HttpFetcher
from app.swing.service import SwingPaperService
from app.swing.store import PaperStore


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-dir", type=Path, required=True)
    ap.add_argument("--capital", type=float, default=1_000_000.0)
    ap.add_argument("--cost-per-side", type=float, default=0.0015)
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    svc = SwingPaperService(PaperStore(a.data_dir), HttpFetcher(),
                            cfg=Config(capital=a.capital, cost_per_side=a.cost_per_side))
    result = svc.run_once()
    print(json.dumps({"result": result, "status": svc.status()}, indent=1, default=str))
    return 0 if result["state"] in ("ok", "up_to_date") else 1


if __name__ == "__main__":
    raise SystemExit(main())
