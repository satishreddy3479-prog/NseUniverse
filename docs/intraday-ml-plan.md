# Intraday ML plan

Goal: a model for **intraday** moves (5, 15, 30, 60 minutes and to the close), trained and judged on the
option-chain samples the system stores itself. It is separate from the daily T+1/T+5 models and never feeds
them (D53). Training and evaluation run only after 15:45 IST.

## Why not wait 60 sessions

Training can start much earlier; what 60 sessions buys is the right to call a result *validated*. A session
gives ~375 samples, but samples inside one day move together, so the number of independent observations is
closer to the number of sessions than to the number of samples. The plan therefore starts training early,
labels every result with how many sessions stand behind it, and keeps "validated" for when the evidence exists.

| Stage | Labelled sessions | Calendar (trading days) | What runs | What may be said |
|---|---|---|---|---|
| 1 Collect | 0-4 | first week | features + labels built nightly | nothing about performance |
| 2 Experimental | 5+ | about 1 week | baselines and a logistic model, leave-one-day-out with purge | "experimental, N sessions", results with day-block confidence intervals |
| 3 Paper-test | 20+ | about 1 month | tree models vs baselines, calibration, per time-of-day and regime; every live prediction recorded before its outcome | "paper-tested" |
| 4 Eligible | 60+ | about 3 months | same, plus the promotion criteria | "validated" only if it beats the baselines across regimes with calibrated probabilities |

The page shows the current stage and the number of labelled sessions.

## What is built now (stage 1)

After each finished session (`app/intraday/dataset.py`, run by the end-of-day job) every in-session sample after
a 15-sample warm-up becomes one row in `intraday.sqlite3:feature_rows` (append-only, versioned `if-1`):

- **Features, from samples at or before that moment only:** minutes since open and to close, weekday, days to
  expiry, gap and distance from the previous close, returns over 5/15/30/60 minutes, 5-minute path efficiency,
  realized-volatility and range ratios, position in the day's range, above/below the opening range, PCR (OI and
  volume) and its change since the first sample, ATM straddle as % of spot and its change, put-minus-call OI-change
  imbalance. Missing values stay missing.
- **Labels, from later samples only:** forward NIFTY return over 5, 15, 30, 60 minutes, and to the last sample
  of the day (only if the day reached 15:25). A label is empty when no sample lies within 3 minutes of its
  target time: nothing is interpolated.
- Tests prove the separation: changing the future never changes any earlier row's features, and a row's
  features equal those of a day truncated at that moment.

Size: about 600 bytes per row, ~0.5 MB a day, ~110 MB a year.

## Next steps, in order

1. **Trainer (stage 2), built while the first sessions accumulate.** Purged leave-one-day-out evaluation (the
   embargo equals the label horizon), neutral band for "no clear move", baselines first (majority class,
   persistence of the last return, time-of-day mean), then regularised logistic regression; metrics: balanced
   accuracy, log loss, Brier, calibration, per time of day and regime, confidence intervals resampled by day.
   Results stored in an append-only evaluation table; runs after 15:45 only.
2. **Price-only head start (to verify first).** Yahoo Finance, already our daily-price source, serves recent
   5-minute index bars (roughly the last 60 days). That could give a price-only intraday model days of history
   immediately, to test the pipeline and to compare against the option-based features once those accumulate.
   Availability and terms for ^NSEI/^INDIAVIX 5-minute data have to be checked before anything is built.
3. **Prediction ledger (stage 3).** Live predictions at each sample, recorded before the outcome, with model
   version, features used and missing features; withheld when inputs are stale; evaluated nightly.
4. **Promotion rules.** A candidate replaces the approved model only if it beats the baselines on held-out
   days with calibrated probabilities, in more than one regime; the previous model stays for rollback.

## Honest limits

Early results (a few sessions) are close to noise whatever the model; the page will show them as experimental
with their confidence intervals, and no probability appears on the dashboard until a model has passed stage 3.
Intraday NIFTY moves are hard to predict; the baselines are there so "no edge" is a visible, acceptable answer.
