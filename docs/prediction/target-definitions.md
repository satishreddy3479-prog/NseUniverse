# Target definitions

Code: `backend/app/prediction/targets.py`. Tests: `tests/unit/test_prediction.py::TestTargets`. All returns are **simple returns as fractions** (0.01 = 1%).

## Timeline vocabulary
- **Reference session `t`**: the last regular NSE cash session completed before the forecast cutoff.
- **Cutoff**: the timestamp after which no new information may enter the features ([leakage-prevention](leakage-prevention.md)).
- **Regular session**: 09:15-15:30 IST on a day that is not a weekend or an NSE trading holiday. Muhurat trading and other special sessions are **not** regular sessions and are excluded from regular-session targets.
- Sessions come from the exchange calendar ([calendar.py]) for the future and from the price history's own dates for the past. Calendar days are never used for horizons.

## T+1 (next regular session `t+1`)
With `C[t]` the close of `t`, and `O, H, L, C` of `t+1`:

| Output | Formula |
|---|---|
| Opening gap | `O[t+1] / C[t] - 1` (official NIFTY 50 index open of `t+1` against the previous session's close) |
| Close-to-close return | `C[t+1] / C[t] - 1` |
| Open-to-close return | `C[t+1] / O[t+1] - 1` |
| Range | `(H[t+1] - L[t+1]) / C[t]` |
| Positive / negative | close-to-close `> 0` / `< 0` |
| Large move | close-to-close `>= +x` or `<= -x`, for x in {0.5%, 1%} (configurable) |
| Gap event | gap `>= +x` or `<= -x`, for x in {0.3%, 0.5%} (configurable) |

The gap and the close-to-close return are different quantities and are stored separately. Event comparisons tolerate 1e-12 of float noise (100.5 / 100 - 1 is 0.0049999999999999 in floating point and is a 0.5% move).

## T+5 (fifth regular session after `t`)
Let `t+1 .. t+5` be the next five regular sessions.

| Output | Formula |
|---|---|
| Five-session return | `C[t+5] / C[t] - 1` |
| Positive / negative | `> 0` / `< 0` |
| Exceedance | return `>= +x` or `<= -x`, x in {1%, 2%} (configurable) |
| Realized volatility | sample standard deviation (n-1) of the five daily close-to-close returns over `t+1..t+5` |
| Adverse-move risk | `min(C[k] / C[t] - 1) <= -2%` for `k` in `t+1..t+5` (close-based; threshold configurable) |
| Max favourable / adverse excursion | `max(H[k]) / C[t] - 1` and `min(L[k]) / C[t] - 1` over `t+1..t+5` |

## Validity rules
- A label exists only if every session it needs is present in the history **and** consecutive according to the calendar. A missing day invalidates the affected labels (they are reported in `LabelSet.skipped`); nothing is interpolated.
- Impossible bars (non-finite or non-positive prices, high below open/close, low above them) raise `BarError`. They are never repaired.
- The last session has no T+1 label; the last five have no T+5 label. A forecast for them is a forecast, not a label.
- Index levels are used as published. NIFTY 50 is an index (no splits); constituent price adjustments matter only for stock-level work later.

## Forecast outputs per horizon
Probability of a positive and of a negative return, expected return with a prediction interval, event probabilities for the thresholds above, and for T+1 the expected gap and range (only if evaluation shows skill), for T+5 expected volatility and adverse-move probability. Each forecast carries a data-quality status; a probability is never reported as certainty.

## Open definitions
- The exact "official opening reference price" for the index open (first computed index value after the pre-open session) must be confirmed against NSE index methodology when real data is loaded.
- Thresholds are placeholders pending a look at the real return distribution.
