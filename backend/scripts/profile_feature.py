"""Where one snapshot's feature cost goes (run from ``backend``: ``PYTHONPATH=. python scripts/profile_feature.py``). Synthetic store, timing only."""

from __future__ import annotations

import cProfile
import pstats
import shutil
import sys
import tempfile
import time
from datetime import UTC, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.bench_backtest import seed  # noqa: E402

from app.intraday.service import IntradayService  # noqa: E402
from app.intraday.store import IntradayStore  # noqa: E402
from app.prediction.flows_store import FlowsStore  # noqa: E402
from app.prediction.history_store import HistoryStore  # noqa: E402
from tests.unit.test_intraday import EXP  # noqa: E402

tmp = Path(tempfile.mkdtemp(prefix="prof_"))
try:
    obs, last = seed(tmp, 1)
    svc = IntradayService(obs, HistoryStore(tmp), FlowsStore(tmp), IntradayStore(tmp), clock=lambda: (last + timedelta(minutes=1)).astimezone(UTC))
    plan = svc._bt_plan(EXP, 1)
    xs = [x for _, x in sorted(plan["by_day"][plan["days"][0]].items())][:20]
    timing: dict[str, float] = {}
    t0 = time.perf_counter()
    pr = cProfile.Profile()
    pr.enable()
    for x in xs:
        svc._feature(x, plan["exp_d"], plan["opening"][plan["days"][0]], timing)
    pr.disable()
    print(f"{(time.perf_counter() - t0) / len(xs) * 1000:.1f} ms per snapshot (profiled); split {timing}")
    pstats.Stats(pr).sort_stats("cumulative").print_stats(14)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
