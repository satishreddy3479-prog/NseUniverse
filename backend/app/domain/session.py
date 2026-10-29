"""The NSE regular session the intraday analysis covers (IST).

Since 3 Aug 2026 equity derivatives (NIFTY futures and options) trade 09:15-15:40, ten minutes
longer than before, to line up with the cash market's Closing Auction Session (15:15-15:35 for
F&O stocks). Every sampler, feature, label and chart reads the close from here, so if NSE changes
the timing back, change SESSION_CLOSE (and SESSION_CLOSE_MIN in frontend/src/lib/session.ts) and
nothing else.
"""

from __future__ import annotations

from datetime import time

SESSION_OPEN = time(9, 15)
SESSION_CLOSE = time(15, 40)
LABEL = f"{SESSION_OPEN:%H:%M}–{SESSION_CLOSE:%H:%M} IST"
