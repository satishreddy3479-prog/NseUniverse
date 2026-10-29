# Testing and validation: strategy builder

Run: `cd frontend && npx vitest run` and `cd backend && python -m pytest tests/unit/test_strategy_backtest.py tests/unit/test_observations.py`.

## Payoff engine (`strategy.test.ts`, 33 tests)
Hand-calculated expectations for long/short call and put, bull call spread, long straddle, short strangle, iron condor, call butterfly, 1:2 ratio spread; lots and lot-size multiplication; zero intrinsic and deep in-the-money; unlimited and bounded sides; one, two or no breakevens; multi-expiry and missing-premium cases return "undefined" instead of a number; Black-76 prices equal the backend's (vectors generated from `app/intraday/volatility.py`); put-call parity; implied-volatility round trip and refusal of impossible prices; theoretical P&L is 0 at entry and equals the exact payoff at expiry; analytic Greeks equal numerical differences; cost arithmetic; template strikes and error messages; validation of bad lots, unlisted strikes, past/unknown expiries, negative and missing premiums, duplicates.

## Backtester (`test_strategy_backtest.py`, 11 tests)
Two-to-three-session datasets built in the test with hand-computed outcomes: time exit, stop-loss at the breaching sample's price, target in rupees and % of premium, missing prices never filled (entry skipped; samples skipped and counted; unpriced exit reported), thin sessions, invalid times, costs and slippage, multi-session metrics (win rate, profit factor, drawdown, equity curve, monthly), reproducibility and hash change, strike offsets, expiry-day and direction buckets, API validation (422 on bad input).

## Page (`strategy-page.test.tsx`, 8 tests)
Template -> legs -> risk figures against hand-calculated values (lot size read from the chart response, not built in), editable legs and validation messages, missing premium asked for, multi-expiry handling and the backtest blocker, save and load, availability text, a full test run with the request body checked (ATM offsets, stop-loss), and the limits shown with the result.

## Not validated
* The cost defaults against a real contract note (rates are editable assumptions).
* Theoretical curves against Opstra or any broker tool (not available; the model is checked against its own mathematics and the backend implementation).
* Any strategy's profitability: there is not enough stored history to say anything.
