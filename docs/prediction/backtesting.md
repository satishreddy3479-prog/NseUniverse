# Backtesting protocol

Status: **cannot be run yet.** The NIFTY history source is undecided (see [overview](overview.md) decision 2), so there is no dataset. Nothing below reports a result.

## What a valid backtest needs
1. A dataset version: source files (raw, untouched), parser version, calendar, feature specification version, label specification version, threshold set, and a content hash. Rebuilding with the same inputs gives the same bytes.
2. Features built **as of each cutoff** with publication times ([leakage-prevention](leakage-prevention.md)); features without verified timing are excluded and listed.
3. Purged, embargoed walk-forward splits and one untouched final period ([model-methodology](model-methodology.md)).
4. Costs only if a trading rule is simulated. Forecast evaluation does not need costs; any strategy built on a forecast does (STT, brokerage, slippage, dated schedule). This project does not trade.
5. All baselines run in the same folds.

## How much history is enough
Honest answer: unknown until we see the data. Rough orientation (not a target): about 250 regular sessions per year; T+5 labels overlap, so the effective number of independent five-session observations is about one fifth of the sessions. Ten years gives roughly 2,500 T+1 samples and about 500 independent T+5 samples. The bigger the family of features, the less this supports. Option-chain, news and flow features have far less history and are tested prospectively.

## What can honestly be tested first
Indian price/technical features, calendar/event-proximity features and (if sources are approved) global cross-asset features, all from long daily histories. Options, FII/DII-with-timing and news features start collecting now and are evaluated as data accrues.

## Reporting
Each run records: dataset version, split definitions, every metric above with intervals, baseline comparison, regime breakdown, number of models and variants tried (for multiple-comparison honesty), and the date the final test period was opened.
