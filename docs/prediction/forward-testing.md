# Forward testing

Backtests do not establish that a forecaster works going forward. Forward testing is mandatory and starts **only after** a baseline model exists; until then the ledger is built and tested but empty.

## Ledger (`app/prediction/ledger.py`, `data/forecasts.sqlite3`)
- Separate tables for T+1 and T+5: `t1_forecasts`, `t1_outcomes`, `t5_forecasts`, `t5_outcomes`.
- A forecast stores: id (derived from horizon, model, version, reference session, cutoff), model name and version, dataset and feature versions, cutoff, generation time, reference session and price, first and final target sessions, payload (probabilities, expected return, interval, event probabilities, expected gap/range or volatility), data-quality flags, the inputs excluded because they were not yet published, and a content hash.
- **Immutable**: SQLite triggers abort UPDATE and DELETE; the same id cannot be written twice (a regenerated "better" forecast is refused); a hash mismatch is reported as `intact: false`.
- **Written before the first target session opens**, never in the future, with a cutoff not after generation.
- **Outcomes** go to a separate append-once table and can be attached only after the target session has closed (15:30 IST of the final target session).

## Daily process (Milestone 11)
1. Check the NSE calendar; collect only what is available now; record freshness and missing sources.
2. Build point-in-time features; if essential inputs are missing, suppress the forecast or mark it degraded; never emit a confident forecast on missing inputs.
3. Generate T+1 and T+5 forecasts from the approved model and every candidate in shadow; write them to the ledger.
4. After each horizon completes, attach realized outcomes (from the same label code) and update metrics.
5. Compare candidate vs approved model vs baselines; track stability and regime concentration.

## Approval gates
A model is "research-approved" only when: leakage tests pass; chronological evaluation passes; sample size supports the claim; calibration is evaluated; baselines are beaten (or the report says they were not); forward results are reported honestly; limitations are written down. There is no predetermined accuracy target. Approval never enables trading.

## Why a day can be "not recorded", and how it recovers (11 Nov 2026)
A day is recorded only when, inside 08:35-09:10 IST on the target day, every overnight series has the bar of the required US trading day (final, or provisional for series that settle after the morning). The requirement is the latest NYSE session on or before the day before the next Indian session: after an Indian holiday it is the world session that traded meanwhile; a US holiday is skipped. If the data is late, the run is a preview, is never counted, and is retried every four minutes until 09:10. The day is marked done only when the forecasts are in the ledger. The day log reads the ledger and the saved report, so a restart cannot change a recorded day into a missed one; a missed day keeps its reason and the preview number. See D105.

