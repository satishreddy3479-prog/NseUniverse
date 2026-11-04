"""The stdlib scorer used on the server must equal the pandas research scorer it was ported from."""

from __future__ import annotations

import random
import sys
from pathlib import Path

import pytest

pd = pytest.importorskip("pandas")
np = pytest.importorskip("numpy")
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "research"))

from swing import indicators as research  # noqa: E402

from app.swing.indicators import Bars, analyse, stage2_ok  # noqa: E402


def series(seed: int, n: int = 420, drift: float = 0.0006, vol: float = 0.015):
    rng = random.Random(seed)
    price, closes, opens, highs, lows, vols, bench = 100.0, [], [], [], [], [], []
    b = 100.0
    for _ in range(n):
        o = price * (1 + rng.gauss(0, 0.004))
        price *= 1 + rng.gauss(drift, vol)
        hi = max(o, price) * (1 + abs(rng.gauss(0, 0.005)))
        lo = min(o, price) * (1 - abs(rng.gauss(0, 0.005)))
        opens.append(o), closes.append(price), highs.append(hi), lows.append(lo)
        vols.append(float(rng.randint(200_000, 900_000)) * (3 if rng.random() < 0.05 else 1))
        b *= 1 + rng.gauss(0.0003, 0.008)
        bench.append(b)
    dates = [d.strftime("%Y-%m-%d") for d in pd.bdate_range("2021-06-01", periods=n)]
    return Bars(dates, opens, highs, lows, closes, vols, bench)


def frame(bars: Bars):
    idx = pd.to_datetime(bars.dates)
    df = pd.DataFrame({"Open": bars.o, "High": bars.h, "Low": bars.low, "Close": bars.c, "Volume": bars.v}, index=idx)
    return df, pd.Series(bars.bench, index=idx)


@pytest.mark.parametrize("seed,drift,vol", [(1, 0.0008, 0.012), (2, 0.0012, 0.02), (3, 0.0, 0.015), (4, 0.0015, 0.008), (5, 0.0006, 0.03)])
def test_every_field_matches_pandas_at_many_bars(seed: int, drift: float, vol: float) -> None:
    bars = series(seed, drift=drift, vol=vol)
    df, bench = frame(bars)
    ref = research.compute(df, bench)  # defaults = the reconstruction: Wilder ATR20 squeeze, min-max NATR
    scored = positive = 0
    for i in range(215, len(bars), 3):
        got, r = analyse(bars, i), ref.iloc[i]
        assert got is not None
        assert got.pillars == tuple(int(x) for x in r["pillars"]), (seed, i)
        assert got.score == r["score"], (seed, i)
        assert got.archetype == r["archetype"], (seed, i)
        for name, want in (("pivot", r["pivot"]), ("dist_pct", r["dist"]), ("atr14", r["atr14"]), ("ema10", r["ema10"]),
                           ("vol_sma20", r["vol_sma20"]), ("mrs", r["mrs"])):
            have = getattr(got, name)
            assert have == pytest.approx(want, rel=1e-9, abs=1e-9), (seed, i, name)
        scored += 1
        positive += r["score"] > 0
    assert scored > 60
    if drift >= 0.0008:
        assert positive > 5  # the comparison is not vacuous: many bars pass the trend template


def test_truncating_the_data_changes_nothing() -> None:
    bars = series(7, drift=0.001)
    cut = Bars(*(x[:330] for x in (bars.dates, bars.o, bars.h, bars.low, bars.c, bars.v, bars.bench)))
    for i in (260, 300, 329):
        assert analyse(bars, i) == analyse(cut, i)


def test_missing_benchmark_gives_no_score_not_zero_relative_strength() -> None:
    bars = series(2, drift=0.0012, vol=0.02)
    nob = Bars(bars.dates, bars.o, bars.h, bars.low, bars.c, bars.v, [None] * len(bars))
    got = analyse(nob, 300)
    assert got is not None and got.mrs is None and got.score == 0.0


def test_short_history_is_unscored() -> None:
    bars = series(2, n=150)
    got = analyse(bars)
    assert got is not None and got.score == 0.0 and got.pivot is None


def test_stage2_gate_matches_research() -> None:
    bars = series(4, drift=0.0015, vol=0.008)
    closes = pd.Series(bars.c)
    for n in (220, 300, 419):
        want_long = bool(research.stage2_gate(closes.iloc[:n]).iloc[-1])
        want_short = bool(research.stage2_gate(closes.iloc[:n], long=False).iloc[-1])
        assert stage2_ok(bars.c[:n]) is want_long and stage2_ok(bars.c[:n], long=False) is want_short
    assert stage2_ok(bars.c[:150]) is None and stage2_ok(bars.c[:30], long=False) is None
