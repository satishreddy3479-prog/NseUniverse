# Leakage prevention

A forecast may use only information that was **published** at or before its cutoff. The code enforces this; documents alone are not trusted.

## Mechanisms
| Rule | Where | Test |
|---|---|---|
| Every value is an `Observation` with effective, published, retrieved and ingested times (all timezone-aware; naive times are rejected) | `app/prediction/pit.py` | `TestPointInTime` |
| Unknown publication time means **unavailable**, never "assume it was early" | `Observation.available_at`, `assert_point_in_time` | `test_unknown_publication_time_is_never_assumed` |
| Cutoff boundary is inclusive and compared in UTC | `available_at` | `test_the_boundary_is_inclusive` |
| Revised data: the version published latest before the cutoff is used, not the corrected one | `latest_available` | `test_a_revised_value_is_seen_as_it_was_known_at_the_time` |
| Publication rules for sources without per-record times must be marked `verified`, else they raise | `PublicationRule` | `test_publication_rules_must_be_verified` |
| A feature build must call `select_available`, which returns the inputs it left out; the forecast stores them in `excluded_inputs` | `pit.py`, `ledger.py` | ledger tests |
| Open markets at the cutoff: use the value observed at the cutoff; the later close belongs to a later forecast | `forecast_cutoff`, US-close test | `test_us_close_is_known_at_the_morning_cutoff_but_not_the_evening_one` |
| Labels use only `t+1..t+5`; nothing from those sessions is a feature | `targets.py` | label tests |
| Training and test splits are chronological; training samples whose label window reaches the test period are purged (and an embargo can be added) | `evaluation.walk_forward_splits` | `test_walk_forward_never_lets_label_windows_cross_the_boundary` |
| Preprocessing, imputation, normalisation, feature selection and calibration are fit on the training fold only | model pipeline (Milestone 4) | planned tests that fit on a fold and assert no test statistics were used |
| Forecasts are written before the first target session opens and can never change | `ledger.py` | `TestLedger` |

## Specific cases from the specification
- **FII/DII**: published after the close; usable only after its verified publication time. Until verified, the feature is unavailable for backtests.
- **Macro release after the cutoff**: the schedule is a feature (event proximity); the actual value is not.
- **News after the cutoff**: excluded; first-seen time is recorded, and a story's later update does not enter an earlier forecast.
- **Next-session volume, high, low, breadth, OI, close**: never inputs.
- **Overlapping T+5 labels**: purged and embargoed; neighbouring samples are not independent, which also limits significance claims.
- **Constituents**: today's NIFTY 50 membership is not applied to history without a survivorship-bias warning.

## What cannot be guaranteed yet
Because no feature pipeline exists yet, the end-to-end leakage test ("rebuild features for date D from data truncated at D's cutoff and compare") is specified but not yet runnable. It is a gate for Milestone 4.
