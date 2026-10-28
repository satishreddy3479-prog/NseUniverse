---
name: verify-market-data
description: Verify market-data integration and data quality (Kotak Neo snapshots, streams, instrument and expiry mapping). Use when checking that data is real, complete, fresh, and correctly mapped.
---
# Verify market data
1. **Confirm the actual source** (live broker vs mock/replay/stored); never assume.
2. **Distinguish snapshots from live stream messages.**
3. **Verify instrument and expiry mappings** against broker-provided data (underlying, expiry, strike, CE/PE, token).
4. **Inspect timestamps** — exchange vs local receipt; check ordering and latency.
5. **Detect problems** — missing, stale, duplicate, malformed, out-of-order values.
6. **Subscriptions** — verify acknowledgements *and* that messages actually arrive for each subscribed instrument.
7. **Completeness** — expected strikes/expiries present; counts compared to the chain.
8. **Separate** mocked tests from live integration tests; live calls only with user authorization.
9. **Report** evidence (sanitized samples, counts, timestamps) and remaining uncertainties. Never include secrets.
