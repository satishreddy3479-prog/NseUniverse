"""The /proc readers of the server page, run on lines read from the production server on 20 Nov 2026 (a 1 GB RackNerd VPS); expected values are worked out by hand from those lines."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.servermgmt import metrics

MEMINFO = """MemTotal:         992724 kB
MemFree:           82852 kB
MemAvailable:     438652 kB
Buffers:           49028 kB
Cached:           483296 kB
SwapTotal:       1048572 kB
SwapFree:        1001792 kB
"""
NET_DEV = """Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 8625114188 3597606    0    0    0     0          0         0 8625114188 3597606    0    0    0     0       0          0
  eth0: 67284129355 158304008    0  436    0     0          0         0 11627918873 92102476    0    0    0     0       0          0
"""
DISKSTATS = """ 252       0 vda 4522709 693870 266275158 1403772 10083864 8586839 265891920 2768367 0 8021156 4363475 0 0 0 0 2982159 191335
 252       1 vda1 1021 0 68018 108 0 0 0 0 0 952 108 0 0 0 0 0 0
 252       2 vda2 4370608 602524 264117388 1381033 9939295 8135534 261124928 2745893 0 7910732 4126926 0 0 0 0 0 0
   7       0 loop0 100 0 800 5 0 0 0 0 0 10 5 0 0 0 0 0 0
"""
STAT = "1069794 (head) R 1069788 1069788 1069788 0 -1 4194304 95 0 0 0 0 0 0 0 20 0 1 0 195948934 5922816 272 18446744073709551615 94384422395904 94384422416705 140723397567744 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0 94384422431376\n"


@pytest.fixture()
def proc(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    p = tmp_path / "proc"
    (p / "net").mkdir(parents=True)
    (p / "1069794").mkdir()
    (p / "self").mkdir()
    (p / "meminfo").write_text(MEMINFO)
    (p / "net" / "dev").write_text(NET_DEV)
    (p / "diskstats").write_text(DISKSTATS)
    (p / "uptime").write_text("1959489.35 1798338.78\n")
    (p / "loadavg").write_text("0.61 0.65 0.57 1/120 1069800\n")
    (p / "1069794" / "stat").write_text(STAT)
    (p / "self" / "statm").write_text("241711 70290 4500 1580 0 90000 0\n")
    monkeypatch.setattr(metrics, "PROC", p)
    monkeypatch.setattr(metrics, "PAGE", 4096)
    monkeypatch.setattr(metrics, "TICKS", 100)
    return p


def test_memory_in_bytes_with_swap_used_by_hand(proc: Path) -> None:
    m = metrics.meminfo()
    assert m is not None
    assert m["total"] == 992724 * 1024 and m["available"] == 438652 * 1024 and m["free"] == 82852 * 1024
    assert m["swap_total"] == 1048572 * 1024 and m["swap_used"] == (1048572 - 1001792) * 1024  # 46,780 kB used, the 45.7 MB the server showed
    (proc / "meminfo").write_text("MemFree: 1 kB\n")
    assert metrics.meminfo() is None  # no MemTotal: unavailable, never a made-up zero


def test_network_skips_loopback_and_disks_count_whole_devices_only(proc: Path) -> None:
    assert metrics.net_totals() == (67284129355, 11627918873)  # eth0 only: lo (8.6 GB) is the machine talking to itself
    # reads: vda sector count 266,275,158 x 512; writes 265,891,920 x 512; the partitions vda1 and vda2 and loop0 would count the same bytes twice
    assert metrics.io_totals() == (266275158 * 512, 265891920 * 512)


def test_uptime_load_and_a_missing_proc_stay_missing(proc: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    assert metrics.uptime_s() == 1959489.35 and metrics.loadavg() == (0.61, 0.65, 0.57)
    monkeypatch.setattr(metrics, "PROC", tmp_path / "nowhere")
    assert metrics.uptime_s() is None and metrics.loadavg() is None and metrics.net_totals() is None and metrics.io_totals() is None and metrics.processes() is None


def test_a_process_row_from_a_real_stat_line_and_the_app_rss(proc: Path) -> None:
    rows = metrics.processes()
    assert rows is not None and len(rows) == 1
    r = rows[0]
    assert r["pid"] == 1069794 and r["name"] == "head" and r["state"] == "R"
    assert r["rss"] == 272 * 4096  # field 24 of the line, in pages
    assert r["cpu_seconds"] == 0.0 and r["runtime_s"] == round(1959489.35 - 195948934 / 100)  # uptime less start time (ticks / 100): a process started 0.01 s ago, rounded to whole seconds
    assert r["mem_pct"] == round(100.0 * 272 * 4096 / (992724 * 1024), 2)
    assert metrics.own_rss() == 70290 * 4096  # field 2 of statm, in pages


def test_a_sample_from_this_proc_is_complete_where_readable(proc: Path, tmp_path: Path) -> None:
    row = metrics.collect(metrics.Cpu(), tmp_path)
    assert row["mem_total"] == 992724 * 1024 and row["net_rx"] == 67284129355 and row["io_read"] == 266275158 * 512 and row["app_rss"] == 70290 * 4096
    assert row["cpu_pct"] is None  # the first CPU read has no previous one; the missing /proc/stat gives no reading either
    assert row["status"] == "ok" and row["disk_total"] is not None
