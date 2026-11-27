"""Does TRENDINESS persist? For an unhedged short straddle the loss is set by the net displacement from the strike, not by path variance. Bars only, copies of the stored data.

Per sample at t (every 5 minutes): the last 30 minutes' net move R_p, path travelled P_p (sum of absolute 1-minute moves), efficiency ER_p = |R_p| / P_p; the next 30 minutes' net move R_f, path P_f, ER_f, and the displacement in units of the forecast sd.
"""

import math
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, "/opt/nse-universe/current/backend")
from app.market.store import MarketStore  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
mk = MarketStore(Path("/tmp/study"))
by_day = defaultdict(dict)
for a, p in mk.samples_since("index1m", "2020-01-01T00:00:00+00:00"):
    t = datetime.fromisoformat(a).astimezone(IST)
    m = (t.hour * 60 + t.minute) - 555
    if 0 <= m < 380 and p.get("c"):
        by_day[t.date()][m] = float(p["c"])


def rank(x):
    return np.argsort(np.argsort(x)).astype(float)


def sp(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    return float(np.corrcoef(rank(a), rank(b))[0, 1]) if len(a) > 10 and a.std() > 0 and b.std() > 0 else float("nan")


rows = []
for d, cl in sorted(by_day.items()):
    if d.weekday() >= 5 or len(cl) < 200:
        continue
    for t in range(40, 345 - 30, 5):
        need = [t - 30, t, t + 30]
        if any(m not in cl for m in need):
            continue
        seq_p = [cl.get(m) for m in range(t - 30, t + 1)]
        seq_f = [cl.get(m) for m in range(t, t + 31)]
        if any(x is None for x in seq_p) or any(x is None for x in seq_f):
            continue
        rp, rf = math.log(seq_p[-1] / seq_p[0]), math.log(seq_f[-1] / seq_f[0])
        pp = sum(abs(math.log(seq_p[i + 1] / seq_p[i])) for i in range(30))
        pf = sum(abs(math.log(seq_f[i + 1] / seq_f[i])) for i in range(30))
        rvp = sum(math.log(seq_p[i + 1] / seq_p[i]) ** 2 for i in range(30))
        rvf = sum(math.log(seq_f[i + 1] / seq_f[i]) ** 2 for i in range(30))
        if pp <= 0 or pf <= 0:
            continue
        rows.append({"day": str(d), "t": t, "rp": rp, "rf": rf, "erp": abs(rp) / pp, "erf": abs(rf) / pf, "pp": pp, "pf": pf, "rvp": rvp, "rvf": rvf})
n = len(rows)
print(f"samples {n}, sessions {len({r['day'] for r in rows})}")
g = lambda k: [r[k] for r in rows]  # noqa: E731
print("\nPersistence tests, all samples (rank correlations; overlapping windows, so read the sessions count too):")
print(f"  trendiness persists?  past efficiency ER vs next efficiency ER        rho {sp(g('erp'), g('erf')):+.3f}")
print(f"  displacement persists? |past net move| vs |next net move|              rho {sp([abs(x) for x in g('rp')], [abs(x) for x in g('rf')]):+.3f}")
print(f"  variance persists?     past realised variance vs next realised variance rho {sp(g('rvp'), g('rvf')):+.3f}")
print(f"  does variance forecast displacement? past variance vs |next net move|  rho {sp(g('rvp'), [abs(x) for x in g('rf')]):+.3f}")
same = [1.0 if (r['rp'] > 0) == (r['rf'] > 0) else 0.0 for r in rows]
print(f"  direction persists?    the next 30 minutes move the same way as the last 30: {100 * sum(same) / n:.1f}% of samples (50% = no persistence)")
big = [r for r in rows if r["erp"] >= np.quantile(g("erp"), 0.75)]
print(f"  after the most one-sided quarter (past ER in the top quarter): same direction {100 * sum(1 for r in big if (r['rp'] > 0) == (r['rf'] > 0)) / len(big):.1f}%, mean next ER {np.mean([r['erf'] for r in big]):.3f} vs all {np.mean(g('erf')):.3f}")
per = []
for d in sorted({r["day"] for r in rows}):
    rs = [r for r in rows if r["day"] == d]
    if len(rs) >= 20:
        per.append(sp([r["erp"] for r in rs], [r["erf"] for r in rs]))
print(f"  by session: past-ER vs next-ER correlation is positive in {sum(1 for x in per if x > 0)} of {len(per)} sessions (mean {np.nanmean(per):+.3f})")
