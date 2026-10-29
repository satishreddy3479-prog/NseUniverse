# Opstra public feature audit

Reference product: **Opstra by Definedge** (https://opstra.definedge.com/), chosen by the owner on 30 Oct 2026 instead of StockMock.
Written 30 Oct 2026. Nothing here is copied code or private API behaviour.

## Method and its limits

* Opstra's own site is a script-driven app. Fetching it returns only a title ("Opstra | Options Analytics Software"); the strategy builder is behind a login. **No account was created or used, no credentials were entered, no private endpoints were called.**
* Evidence is therefore secondary and public: independent reviews and comparisons (Strike.money, AlgoTest, Fintrakk, bankniftyoptions articles) plus the way comparable public builders (Sensibull help pages, Navia, 5paisa) describe the same ideas. Anything that rests only on those is marked **partially verified**.
* "Reverse engineering" here means: write down the observable behaviour and the standard option mathematics behind it, then implement it independently. Opstra's code, data and exact formulas were not available and were not used.
* Earlier, StockMock's public page was read the same way (its landing page lists: index, futures/options, call/put, buy/sell, strike, premium range, lots, stop-loss/target, entry/exit time; templates such as straddle, strangle, iron condor, spreads). That evidence is kept in the table where it overlaps.

## Findings

| Feature | Public evidence | Workflow as described | Inputs | Outputs | Confidence | NSE Universe implementation | Dependencies |
|---|---|---|---|---|---|---|---|
| Multi-leg position builder | Reviews: add one option, repeat for each leg; monitor P&L, payoff graph, Greeks | Add legs one by one from the option chain or from a template; edit or remove | Underlying, expiry, strike, CE/PE, buy/sell, lots, premium | Position table, combined payoff | Partially verified | Section 2: editable leg table, add / duplicate / remove | Stored option chain, lot size from it |
| Templates | Reviews: straddle, strangle, iron condor, butterfly, calendar, diagonal, ratio spreads; strikes auto-filled | Pick a template, strikes fill around ATM, then edit | Template, ATM | Pre-filled legs | Partially verified | `TEMPLATES` in `lib/strategy.ts` (18) | Listed strikes of the chain |
| Payoff at expiry | All sources | Live-updating chart as legs change | Legs | P&L curve, breakevens, max profit/loss | Verified | `analyzeExpiry`, `payoffCurve`, chart with breakevens and spot marker | Premiums |
| Payoff on a date before expiry ("target date" curve) | Opstra review: shows P&L at different dates before expiry, not only at expiry; Sensibull/Navia/5paisa describe the same with target date | A second curve for a chosen date and spot | Target spot, days to expiry, IV | Estimated P&L curve | Partially verified | Black-76 estimate (`theoreticalPnl`), labelled "model estimate"; sliders for target spot, days, volatility change | Per-leg volatility (implied from the entered premium unless overridden), rate assumption |
| Net Greeks and what-if | Opstra review: portfolio Greeks, "what-if" with price and IV | Greeks of the whole position; change price/IV to see them move | Legs, spot, IV | Delta, gamma, theta, vega | Partially verified | `netGreeks` (delta/gamma analytic, theta/vega one-day/one-point bumps), cross-checked numerically in tests | Same as above |
| P&L table | Sensibull/5paisa help pages | Table of P&L at spot levels and dates | Target spot, days | Grid | Partially verified | "P&L table": ±5 % levels, expiry vs target date | none |
| Strategy save / load | Sources mention saved positions | Name a strategy, reload later | Name | Saved legs | Unverified detail | Saved in this browser (`localStorage`) | none |
| Multi-expiry strategies | Opstra described as stronger for calendars/diagonals/ratios | Legs on different expiries | Expiry per leg | Combined view | Partially verified | Legs carry their own expiry; no single expiry payoff is drawn (disclosed), model estimate works | Chains for each expiry |
| Backtester | Opstra review: backtester, "advanced backtesting (custom entry/exit rules)" in the paid tier, history from 2016 (AlgoTest comparison) | Choose strategy, period, entry/exit, SL/target; see P&L, drawdown, trades | Strategy, dates, times, SL/target | Metrics, equity curve, trades | Partially verified | Section 4: intraday test on **stored** option prices | Stored option history (only since collection began) |
| Option simulator / replay | AlgoTest comparison lists "options simulator (intraday replay)" | Replay a past day minute by minute | Date | Replay | Unverified | Not implemented (see limitations) | Minute data |
| IV charts, skew, surface, OI analytics | Many reviews | Separate analytics pages | Strike, expiry | Charts | Partially verified | Out of scope here; OI, PCR and IV pieces already exist elsewhere in NSE Universe | Existing |
| Direct execution / basket orders | Reviews mention execution via Definedge Securities | Place orders from the builder | Orders | Orders | Partially verified | **Not built and not allowed** by this project's rules (read-only market data, no order placement) | n/a |
| Margin calculator | Not seen for Opstra (listed for other tools) | n/a | n/a | n/a | Unverified | Not built | Broker margin API |

## What is deliberately not copied

Order execution, paid-tier gating, multi-index coverage beyond the data we hold, and any claim of historical results we cannot produce.
