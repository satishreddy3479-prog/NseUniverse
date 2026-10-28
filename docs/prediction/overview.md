# Prediction Intelligence: overview

Status: **Milestones 1-2 done (specification and foundations). No model exists yet and none is claimed.**
This is a research and forecasting system. It never places orders and never connects to an execution engine.

## What is being built
Two separate forecasters for the NIFTY 50 index, each with its own targets, features, evaluation, calibration, forecast ledger and forward-test statistics:

- **T+1**: the next regular session (gap, close-to-close, open-to-close, range, event probabilities).
- **T+5**: the cumulative return to the close of the fifth regular session after the reference session, with risk measures.

Definitions: [target-definitions](target-definitions.md). Inputs: [feature-catalog](feature-catalog.md), [data-sources](data-sources.md). Integrity rules: [leakage-prevention](leakage-prevention.md).

## Current architecture assessment (verified 2026-10-28)
| Existing piece | Reuse for prediction |
|---|---|
| Kotak Neo adapter, stream, 60 s sampler | NIFTY option-chain features (PCR, OI change, straddle) from the observation store; live only |
| `data/observations.sqlite3` (D39) | Source of option-derived features. History starts on the day collection started: **no multi-year option history exists** |
| Analytics module `app/analytics/oi.py`, widgets | Feature logic is reused, not copied; the frontend never feeds the models |
| FastAPI + SQLite + Parquet plan | Same stack; models read a backend feature interface |
| 1 GB / 1 vCPU server plan | Collector + inference only; training and backtests run on the PC or Codespaces |

New code lives in `backend/app/prediction/` (no second application, no duplicate ingestion):
`calendar.py` (NSE trading calendar), `targets.py` (labels), `pit.py` (information-cutoff guard), `ledger.py` (immutable forecasts), `evaluation.py` (purged splits and metrics). Tests: `backend/tests/unit/test_prediction.py`.

## What exists, what does not
| Capability | State |
|---|---|
| Trading calendar from NSE circulars (2026) | Done, tested. Other years refused until a circular is added |
| Target/label formulas | Done, tested by hand-worked examples |
| Point-in-time guard, publication rules | Done, tested |
| Immutable T+1 / T+5 ledgers | Done, tested; not yet connected to a model or the dashboard |
| Purged walk-forward splits, metrics, baselines | Done, tested |
| Historical NIFTY data | **Not in the project.** Needs an approved source |
| News, flows, global data, event calendar adapters | Specified, not built (need decisions below) |
| Any trained model | None |
| Dashboard workspace | Not built (Milestone 10) |

## Storage and resource budget (estimates, to be measured)
- Daily feature table: ~250 sessions/year x ~200 columns x 8 bytes is about 0.4 MB/year; ten years about 4 MB.
- News metadata only (headline, URL, times, tags; no article text): roughly 50-100 KB/day, so about 20-40 MB/year.
- Raw EOD file archive (if bhavcopy is used): order of 250 MB/year compressed (not measured).
- Ledgers and registry: negligible. Everything fits the 20 GB disk with room; the limit is memory, so training stays off the server.
- Never deleted: raw sources, feature tables, labels, ledgers (rule `nse-trading-desk-master` section 4).

## Milestones
1. Audit and specifications. **Done (these documents).**
2. Data foundation: calendar, labels, point-in-time, ledger, evaluation. **Foundations done**; source adapters wait for decisions.
3. Historical dataset: blocked on the NIFTY history source decision.
4-5. T+1 and T+5 baselines. 6. Indian feature families. 7. Global families. 8. News. 9. Advanced models. 10. Dashboard. 11. Shadow forward testing. 12. Model review.
Milestones are not skipped to make a dashboard look complete.

## Decisions
Made by the user on 2026-10-28:
1. **Forecast cutoff:** 08:30 IST on the morning of the next session (reference session = the previous day).
2. **Price history source:** free unofficial libraries (yfinance / Yahoo Finance). Personal use only, unofficial, may change or break; every bar is stored with provenance and later disagreements are logged, never applied. Series whose exchange close time is not yet checked are stored but not used as features.
3. **News:** official announcements + GDELT metadata, and Economic Times RSS (headline, link and times only; its terms could not be read by Claude, so this rests on the user's approval and stays easy to switch off). To be built in Milestone 8.

Still open:
4. Automated downloads from NSE itself (bhavcopy, FII/DII, participant data): NSE's terms ban systematic automated collection; nothing is downloaded from NSE automatically yet.
5. Free-key accounts (for example FRED for the 2-year yield and cleaner series): needs approval before an account is created.
6. Event thresholds (+/-0.5%, +/-1% for T+1; +/-1%, +/-2% for T+5) are placeholders to review on real data.
