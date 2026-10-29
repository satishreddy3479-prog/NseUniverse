# Options backtesting engine

`backend/app/strategy/backtest.py`, `POST /api/strategy/backtest`, `GET /api/strategy/availability`.

## Data reality (checked, not assumed)
The only option prices are the last traded prices NSE Universe stored itself, about one per minute during market hours, from the **29 Oct 2026** session. There is no bid/ask and no earlier history. A session needs at least 30 stored samples to be used. On 30 Oct 2026 that is **one** session (29 Oct, 348 samples), so the first live run gave a single trade. It is a mechanics check, not evidence. Results over so few sessions show how rules behave, not whether a strategy works; every result says this, and bucket tables say "too few trades to conclude" below 30 trades.

## What is implemented
One trade per session: strikes chosen at entry as listed-strike offsets from the ATM; entry at the first stored sample at or after the entry time (within a configurable wait) where every leg has a price; stop-loss and target (rupees on the strategy, or % of premium traded) checked on every later sample, stop-loss first; otherwise exit at the first sample at or after the exit time. Lots, lot size (from the stored sample), costs and slippage (same cost model as the builder).

## Execution realism
* Fill price = stored last traded price of the chosen sample (no candle-close assumption), plus slippage and costs.
* A breach is acted on at the first sample that shows it, at that sample's price (gap-through is kept).
* Samples with any leg unpriced are skipped and counted per trade. If the entry cannot be priced within the wait, the session is listed under "not traded" with the reason; if the exit cannot be priced, it is listed as unpriced. No price is ever filled in.
* Stop and target cannot both trigger on one sample (a single value of the position is tested). Moves between samples are not seen; this is stated in every result.

## Output
Trades, wins/losses, win rate, gross and net P&L, average win/loss/trade, profit factor (null if no losses), max drawdown on the cumulative net curve, largest win/loss, average holding minutes, monthly and yearly net, equity curve, trade table, expiry-day vs other days and NIFTY-rose/fell buckets (the second is known only after the fact and is labelled so), skipped sessions with reasons. A risk-adjusted ratio is withheld below 30 trades.

## Reproducibility
Each result carries the configuration, its hash, and a fingerprint of the stored data it read (per-session sample counts and the highest sample id). Same configuration on the same data gives identical trades (tested).

## Not implemented
Multi-day holding, re-entry, trailing stop, partial exits, adjustments, indicator entry rules, multi-expiry strategies, parameter optimisation, walk-forward validation. They need either more history than exists or are not worth building before there are enough sessions to validate them; they are not shown in the interface. Safeguards for optimisation (separate test period, out-of-sample, sensitivity, trade counts) must be designed before the first optimiser is added.
