"""Download indices, universe prices and sector info. Run: python -m swing.fetch_data"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

from swing import chartink, data

ROOT = Path(__file__).resolve().parents[2] / "data" / "swing"


def main() -> None:
    uni = chartink.load_universe(ROOT / "universe.json")
    symbols = sorted({r["nsecode"] for r in uni["rows"]})
    idx = [data.NIFTY, *data.SECTOR_INDICES.values()]
    cache = ROOT / "cache"
    st = data.download(idx, cache, chunk=20)
    print("indices:", st)
    st2 = data.download([f"{s}.NS" for s in symbols], cache)
    print("stocks:", Counter(st2.values()))
    (ROOT / "download_status.json").write_text(json.dumps({**st, **st2}, indent=1))
    info = data.fetch_sector_info(symbols, ROOT / "sector_info.json")
    print("sector info:", sum(1 for v in info.values() if v.get("sector")), "/", len(info))


if __name__ == "__main__":
    main()
