# Options payoff and risk engine

`frontend/src/lib/strategy.ts`. Pure functions.

## Conventions
BUY = +1, SELL = -1. Leg P&L at expiry = sign x (intrinsic - premium) x lots x lot size. Intrinsic: call max(S-K,0), put max(K-S,0). Lot size comes from the stored chain.

## Three different quantities
1. **Expiry payoff**: exact. Defined only when every leg shares one expiry.
2. **Theoretical valuation**: Black-76 on forward F = S e^{rT} with each leg's volatility (the volatility implied by its entry premium at the current spot unless overridden), shifted by the what-if volatility change. An estimate for a date and spot; never a market result.
3. **Market P&L**: stored last traded price minus entry premium, only where a quote exists.

## Exactness of risk figures
The payoff is piecewise linear with kinks only at strikes. So the extremes over S >= 0 are at S = 0 or a strike, or unbounded if the slope above the last strike (sum of call legs) is not zero. Every breakeven lies on one linear piece and is found by interpolation. Consequences handled and tested: unlimited loss (short call, short strangle, ratio spread), unlimited profit (long call), put profit bounded because S cannot go below 0, several breakevens (straddle, condor, butterfly), no breakeven.

## Greeks
Delta and gamma are analytic (Black-Scholes d1 with spot fixed). Theta is the model P&L change from one day passing; vega the change for +1 volatility point. Tests compare all four against numerical differences of `theoreticalPnl`.

## Costs
`executionCost` per leg execution: brokerage, exchange charges, SEBI fee, STT (sell), stamp duty (buy), GST on brokerage + exchange + SEBI, slippage per unit. Defaults are only a starting point (brokerage 20, STT 0.1 %, exchange 0.03503 %, SEBI 0.0001 %, stamp 0.003 %, GST 18 %); statutory rates change and are editable. Estimated round trip assumes each leg is closed at its expiry value.

## Known simplifications
No dividends or carry beyond the single rate; European exercise; volatility smile per strike is only the leg's own implied volatility; exercise-time STT on in-the-money expiry is not modelled.
