---
paths:
  - "backend/**"
  - "tests/**"
  - "docs/**"
---
# Financial-data rules
- **Provenance:** every record carries source (broker/feed), kind (snapshot|stream|stored), and receipt time. Mock/replay data must be labeled and never mixed with live data.
- **Timestamps:** store in UTC (ISO 8601) internally; display in Asia/Kolkata (IST). Keep `exchange_ts` (from the feed, if provided) and `received_ts` (local) as separate fields; never overwrite one with the other.
- **Missing/invalid:** represent as `None`/null, never 0 or last-value fill unless explicitly marked as carried-forward. Reject or flag malformed values (negative price/OI, bid > ask, NaN).
- **Precision:** use `Decimal` or integer paise for prices where arithmetic matters; floats only for analytics where tolerance is documented. Don't round before computing.
- **Instruments:** identify contracts by underlying, expiry date, strike, option type, and the broker's instrument token/symbol; keep the mapping explicit and tested. Do not parse meaning from symbol strings ad hoc.
- **Expiries:** use real exchange expiry dates discovered from broker data, not computed assumptions (holidays shift expiries). Label weekly vs monthly from data. Re-verify rules against current NSE circulars before encoding them.
- **Snapshot vs stream:** a snapshot is a point-in-time full chain; stream messages are partial updates. Do not treat a partial update as a full chain. Track last-update time per instrument.
- **Freshness:** define a staleness threshold per feed; expose `stale`/`incomplete` flags to the API and UI.
- **Calculations:** document formula, inputs, units, assumptions; validate with [validate-financial-math](../skills/validate-financial-math/SKILL.md). Calculations must be reproducible from stored inputs.
- **No unsupported assumptions** about market behavior (e.g. market hours, lot sizes, strike steps) — source them from data or authoritative references, or record as open questions.
