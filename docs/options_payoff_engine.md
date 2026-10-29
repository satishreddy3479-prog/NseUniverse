# Options payoff engine

`frontend/src/lib/strategy.ts`: pure functions, no UI, no network.

## Convention
BUY = +1, SELL = -1. Leg P&L at expiry = sign x (intrinsic - premium) x lots x lot size, where intrinsic is max(S-K, 0) for a call and max(K-S, 0) for a put. Lot size is read from the stored chain.

## Exact risk figures
The strategy payoff is piecewise linear with kinks only at strikes. Over S >= 0 the extremes are therefore at S = 0 or at a strike, or unbounded when the slope above the highest strike (the sum of the call legs, signed) is not zero. Every breakeven lies on one linear piece and is found by interpolation. Handled and tested: unlimited loss (short call, short strangle, call ratio spread), unlimited profit (long call), put profit bounded by S >= 0, one, two or no breakevens (straddle, condor, butterfly), strategies whose payoff is finite on both sides.

## When no payoff is defined
Legs on different expiries, no legs, or any missing premium: `analyzeExpiry` returns `defined: false` with the reason and the page shows that reason; it never substitutes zero.

## Not in the engine
No option pricing model, Greeks, volatility, time-to-expiry curves or transaction costs (removed by decision; see the specification).
