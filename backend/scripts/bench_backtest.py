"""Timing benchmark of ``IntradayService.backtest`` on a synthetic store (run from ``backend``: ``PYTHONPATH=. python -u scripts/bench_backtest.py 1 5 20 60``).

The store holds the real captured chain from the test fixtures repeated once a minute for N sessions (376 samples a session), so the
numbers are costs of reading and solving, not market results. Per session count and from a cold start (no cached features or results)
it reports: time to the first answer (a result, or "computing" for a large run), total time until the result, CPU seconds of the
process, peak process memory (working set / max RSS), snapshots processed, JSON size of the result, and the split between the stored-sample
query, the contract reads, the volatility solve and the GEX reconstruction. The store is built in a temporary directory and removed;
nothing on disk of the application is touched.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.intraday.service import IntradayService  # noqa: E402
from app.intraday.store import IntradayStore  # noqa: E402
from app.prediction.flows_store import FlowsStore  # noqa: E402
from app.prediction.history_store import HistoryStore  # noqa: E402
from app.storage.observations import ObservationStore  # noqa: E402
from tests.unit.test_intraday import EXP, ist, real_chain  # noqa: E402


def peak_memory_mb() -> float:
    """Peak memory of this process so far (Windows: peak working set; elsewhere: max RSS)."""
    try:
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

        c = Counters()
        c.cb = ctypes.sizeof(c)
        kernel, psapi = ctypes.WinDLL("kernel32"), ctypes.WinDLL("psapi")  # type: ignore[attr-defined]
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
        if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(c), c.cb):
            raise OSError("GetProcessMemoryInfo failed")
        return c.PeakWorkingSetSize / 1e6
    except (ImportError, AttributeError, OSError):
        import resource

        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def seed(tmp: Path, sessions: int) -> tuple[ObservationStore, datetime]:
    obs = ObservationStore(tmp)
    base = ist(9, 15)
    last = base
    n = 0
    for d in range(sessions):
        day0 = base - timedelta(days=sessions - 1 - d)
        for m in range(376):
            t = day0 + timedelta(minutes=m)
            obs.record_snapshot(real_chain(t.astimezone(UTC), f"b{n}", EXP), unchanged=False)
            last = t
            n += 1
    return obs, last


def main() -> None:
    counts = [int(x) for x in sys.argv[1:] if x.isdigit()] or [1, 5, 20, 60]
    tmp = Path(tempfile.mkdtemp(prefix="bench_bt_"))
    try:
        t0 = time.perf_counter()
        obs, last = seed(tmp, max(counts))
        print(f"seeded {max(counts)} sessions x 376 samples in {time.perf_counter() - t0:.1f} s; memory after seeding {peak_memory_mb():.0f} MB")
        svc = IntradayService(obs, HistoryStore(tmp), FlowsStore(tmp), IntradayStore(tmp), clock=lambda: (last + timedelta(minutes=1)).astimezone(UTC))
        print(f"{'sessions':>8} {'first ms':>9} {'total s':>8} {'cpu s':>7} {'peak MB':>8} {'snaps':>6} {'KB json':>8} {'query ms':>9} {'contract ms':>12} {'solve ms':>9} {'gex ms':>8}")
        for n in counts:
            svc._iv_cache = {}
            svc._feat_cache.clear()
            svc._bt_results.clear()
            svc._bt_job = None
            c0, w0 = time.process_time(), time.perf_counter()
            out = svc.backtest(EXP, n)
            first_ms = (time.perf_counter() - w0) * 1000
            while out.get("status") == "computing":
                time.sleep(0.2)
                out = svc.backtest(EXP, n)
            wall, cpu = time.perf_counter() - w0, time.process_time() - c0
            kb = len(json.dumps(out)) / 1024
            tm = out.get("timing", {})
            nan = float("nan")
            print(f"{n:>8} {first_ms:>9.0f} {wall:>8.2f} {cpu:>7.2f} {peak_memory_mb():>8.0f} {out.get('snapshots', 0):>6} {kb:>8.1f} {tm.get('plan_read_ms', nan):>9.0f} {tm.get('contracts_ms', nan):>12.0f} {tm.get('solve_ms', nan):>9.0f} {tm.get('gex_ms', nan):>8.0f}   status {out.get('status')}")
            w1 = time.perf_counter()
            svc.backtest(EXP, n)
            print(f"         repeat of the same request (cached result): {1000 * (time.perf_counter() - w1):.1f} ms")
            w2 = time.perf_counter()
            svc.backtest(EXP, n, cost_bps=7.0)
            print(f"         same sessions, other cost (cached features): {1000 * (time.perf_counter() - w2):.0f} ms")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
