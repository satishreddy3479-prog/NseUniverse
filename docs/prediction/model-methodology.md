# Model methodology

Principle: simplest model that delivers repeatable, calibrated, out-of-sample improvement over honest baselines. Complexity is earned by evidence. Nothing here claims the market is predictable; daily index direction is expected to be only weakly predictable and a model of that quality may not survive costs. That expectation is general knowledge, not a result from this project.

## Stages (T+1 and T+5 each run their own copy)
1. **Baselines (no learning)**: zero return; unconditional historical distribution of returns (training data only); direction frequency (`climatology_probability`); previous-session momentum and reversal; for T+5 also five-session momentum and mean reversion.
2. **Transparent models**: regularised linear regression for returns; logistic regression for direction; quantile regression for intervals.
3. **Nonlinear tabular models** (only if stage 2 shows signal): gradient-boosted trees, random forests. Libraries are chosen offline (training is not done on the 1 GB server); the server loads a small exported model.
4. **Probabilistic outputs**: probability calibration on a held-out fold, quantile forecasts, interval coverage checks, tail-event probabilities.
5. **Combinations**: weighted blends, regime models, news-enhanced models: only with out-of-sample evidence.

## Validation
- Chronological training / validation / **final untouched test** periods. The final period is not used for tuning; looking at it more than once is recorded.
- Rolling-origin walk-forward with purge (`horizon` = 1 for T+1, 5 for T+5) and an embargo.
- Metrics: direction (balanced accuracy, confusion matrix, hit rate with a Wilson interval); probability (Brier, log loss, reliability table); returns (MAE, RMSE, correlation as secondary); distributions (pinball loss, interval coverage and width, tail calibration); stability (by volatility regime, around events, trending vs range-bound, sensitivity to removing a feature).
- Overlapping five-session labels and serial dependence reduce the effective sample size; confidence statements use block methods or are withheld. No "statistically significant" claim without a method that supports it; many comparisons are corrected for.
- Accuracy alone is never reported: a model that always says the dominant direction can look accurate and carry no information.

## Feature-family ablation
Test the incremental value of: (1) Indian price/technicals, (2) breadth and sectors, (3) institutional flows, (4) options features, (5) global and cross-asset, (6) news, (7) scheduled events. Each family is added to and removed from the others under the same splits. Predictive association is not causation and explanations (coefficients, permutation importance) are labelled as model explanations.

## Acceptance criteria
Not invented in advance. After the baselines are run on real data, we agree thresholds such as "beats climatology on Brier score in most walk-forward folds with an interval that excludes zero improvement, calibrated within X". Until then no model is "approved".

## Resources
Training and tuning run on the PC / Codespaces. The server only collects data, builds features, loads a small model, writes forecasts to the ledger and attaches outcomes. No automatic daily retraining; a retrain happens on a schedule or when enough new data exists, and a new model never replaces the approved one silently ([model-registry](model-registry.md)).
