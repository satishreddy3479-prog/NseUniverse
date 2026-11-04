"""Daily refresh for the Swing page: new Chartink list, new bars, new report.

Usage (after the close, from research/): python -m swing.refresh
Run it after 16:00 IST. Before that Yahoo serves a partial bar for today; the loader drops it, so
the report would simply be one session behind.
"""

from __future__ import annotations

from collections import Counter

import json

from swing import chartink, data, indicators
from swing.export_report import write_report
from swing.run_backtest import ROOT


def main() -> None:
    rows = chartink.fetch_universe()
    if not rows:
        raise SystemExit("Chartink returned no stocks: keeping the previous universe and report")
    chartink.save_universe(rows, ROOT / "universe.json")
    symbols = sorted({r["nsecode"] for r in rows})
    cache = ROOT / "cache"
    st = data.download([data.NIFTY, *data.SECTOR_INDICES.values()], cache, chunk=20, refresh=True)
    st.update(data.download([f"{s}.NS" for s in symbols], cache, refresh=True))
    print("download:", dict(Counter(st.values())))
    bad = [t for t, v in st.items() if v not in ("ok", "cached")]
    if any(t.startswith("^") for t in bad):
        raise SystemExit(f"index download failed for {bad}: report not updated")
    info = data.fetch_sector_info(symbols, ROOT / "sector_info.json")
    sector_map = {s: indicators.map_stock_to_index(v.get("sector"), v.get("industry")) for s, v in sorted(info.items())}
    out = ROOT.parents[1] / "backend" / "app" / "swing" / "sectors.json"  # reference data the server job reads
    out.write_text(json.dumps({"_note": "Sector index per stock from Yahoo sector/industry via the spec's map_stock_to_index(). "
                               "Refreshed by research/swing/refresh.py; unknown stocks default to CNXINFRA.",
                               "map": sector_map}, indent=0, sort_keys=True), encoding="utf-8")
    print(f"sector map: {len(sector_map)} stocks -> {out}")
    write_report(ROOT)


if __name__ == "__main__":
    main()
