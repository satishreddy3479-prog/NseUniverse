# Advanced Greeks: what an institutional desk looks at, and what to add (plan, 23 Nov 2026)

Status: plan only. The page today (`/advanced-greeks`) shows rupee Greeks by leg, expiry bucket and limit, the gamma map and the volatility surface. The what-if scenarios moved to the Strategy Builder's Scenarios tab (D267). Read-only throughout: nothing here places an order.

## What a desk reads that this page does not yet show
Grouped by the question each answers. Every item lists its data, how it is verified, and what it cannot say.

### 1. Is the position safe to carry? (risk)
1. **Greek ladders.** Net delta, gamma, vega and theta in rupees at spot levels from -5 % to +5 % (and by time to expiry): how the exposure changes as the index moves. Shows where delta flips sign and where gamma peaks. Data: the engine already revalues at any spot. Verify: a point of the ladder equals the engine's scenario at that spot.
2. **Delta hedge sheet.** Futures lots to neutralise delta now, and at +-1 %, +-2 %: how often and how much to re-hedge, the cost at the quoted basis. Data: the NIFTY future is in the app. Cannot say: execution slippage (no order book depth stored for the future beyond the top).
3. **Gamma-theta breakeven.** Daily move in points at which gamma gains pay the theta; compared with the implied move (ATM implied volatility / sqrt(252) x spot) and with the realised move of the last sessions. Says whether the position is paid for the risk it takes. Data: Greeks (have), realised volatility from stored index bars (have).
4. **Tail and loss figures.** Delta-gamma parametric VaR and expected shortfall at 95 % and 99 % for one day, plus a surface-based full revaluation (Monte Carlo on the engine, a few thousand paths) as a check on the approximation. Verify: the two agree for small positions; the Monte Carlo is seeded and reproducible. Cannot say: gap risk beyond the model's distribution; label as a model estimate.
5. **Stress set.** Standard shocks (+-1, 2, 3 standard deviations with volatility up or down), the largest one-day moves in the stored sessions replayed on the current position, and reverse stress ("what move loses 50,000"). Data: stored sessions (7 now, growing).

### 2. Where does the risk sit? (decomposition)
6. **Vega by expiry and by strike bucket**, and **vega by smile factor**: level (ATM volatility), skew (risk reversal), curvature (butterfly) and term slope. The engine's smile is parametric (SVI), so the sensitivity of the position to each parameter is a revaluation with that parameter bumped. Says whether the position is long volatility or long skew. Verify: bump a parameter, recompute, compare with the finite-difference of the engine.
7. **Higher-order Greeks.** Vanna (delta against volatility), volga/vomma (vega against volatility), charm (delta decay), speed and zomma where useful, net and by leg. Vanna and charm explain why delta drifts when volatility moves or time passes (the intraday and expiry-day behaviour). Verify: each against a finite difference of the Black-76 price on the real chain, to 1e-6.
8. **P&L attribution.** Since entry and since the open, split into delta, gamma, vega, theta, rate and a residual (higher order and market-price vs model gap). The Strategy Builder's timeline already splits spot-driven and time-driven moves; this does it by Greek with the residual stated, never hidden.

### 3. What is the market paying? (volatility analytics)
9. **Smile analytics.** 25-delta risk reversal and butterfly, ATM term structure and forward volatility between expiries, each with its percentile against the stored sessions. Data: the fitted surface per expiry.
10. **Implied against realised.** ATM implied volatility against realised volatility (close-to-close and Parkinson from the one-minute bars) over 5, 10 and 20 sessions: the variance risk premium, and implied-volatility rank and percentile. Data: stored bars and surface; the history is short (7 sessions), so ranks start as "n of N sessions" until more accumulate.
11. **Dealer-style exposures.** Beside the existing GEX: vanna exposure and charm exposure by strike (how dealers' hedges change when volatility or time moves), with the sign convention stated as an assumption (the market long calls, short puts), like GEX.

### 4. Not possible from the data the app holds
Bid-ask cost of unwinding (no stored depth per option), margin and SPAN (not published to the app), counterparty and funding, and any live P&L from the broker. They are listed on the page so their absence is not read as zero.

## Build order
| Phase | Items | Why first | Size |
|---|---|---|---|
| 1 | 1 ladders, 3 gamma-theta breakeven, 2 delta hedge sheet | uses only what the engine and the future already give; the questions a seller asks every day | 3 to 4 days |
| 2 | 7 higher-order Greeks, 6 vega by factor, 8 attribution | needs new engine outputs (backend) and their independent verification | 5 to 6 days |
| 3 | 9 smile analytics, 10 implied against realised, 11 vanna and charm exposure | needs history and cross-session percentiles | 4 to 5 days |
| 4 | 4 VaR and shortfall, 5 stress set | builds on 1 and 2; Monte Carlo on the engine | 4 days |

Rules for every item: a missing input leaves the figure empty and says why; each formula is checked against an independent recompute (as D256 did for gamma and vega) before it is called verified; conventions that are assumptions are labelled as such on screen; nothing is presented as a forecast.

## Decisions needed from the owner
- Phase 1 first, or a different order?
- Which positions the page analyses: the Strategy Builder's strategy only, or any legs entered here (as today), or all saved strategies together (a portfolio view)?
- Whether a one-day VaR belongs on the page at all (it is a model estimate on a short history).
