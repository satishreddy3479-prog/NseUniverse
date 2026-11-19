# Audit: NIFTY intelligence and straddle decay intelligence (19 Nov 2026)

Question: can the system find a good entry for a short straddle and capture its decay? This audit uses only the stored data of the server (15 chain sessions 29 Oct - 19 Nov for the entry study, 7 sessions and 2,350 recorded minutes for the score validation). **Every number below is a description of 15 days, in-sample, before bid/ask and taxes. It is not evidence of an edge.**

## 1. What exists
- Straddle engine (`intelligence/straddle.py`): Black-76 attribution of the straddle's change into theta, vega, delta, gamma, vanna, volga; fixed, rolling ATM and (D204) managed 100-point straddle; IV regimes, realised against implied, GEX (modelled).
- Environment scores (`straddle_env.py`): seller and buyer 0-100, about 13 hand-weighted components each; flags; the class label; per-minute recording and alerts; validation page.
- NIFTY intelligence (`fusion.py` and the Market Intelligence engines): a fused directional score from positioning, order flow (CVD proxy), volatility, structure, participation (weights 30/20/10/20/20, "provisional").
- No entry logic: nothing says "enter now", at which strike, with which stop or roll, or what to expect.

## 2. What the data says
**A. Entry time (fixed ATM straddle at entry, held to 15:15, points, 15 sessions)**
Mean P&L is about zero at every entry time (-8 to +9) and the median is positive (+20 to +36 for entries before 10:30, +3 to +8 after 14:00); win rate 53-73%. The edge is a positive median with a heavy left tail: 6 Nov -215, 19 Nov -215 (09:30 entries), 5 Nov -47. Late entries (14:00+) risk about 8-11 points and make about 3-7: small and quiet.

**B. Decay is small on non-expiry days.** The premium of the 09:20 strike averages 97% of its 09:20 value at 11:00 and 95% at 13:00, back to 98% at 15:00 and 102% at 15:15 (12 days; range 80%-157% at the close). Theta is about 1.4 points an hour at four days to expiry. A short straddle on those days is a bet that NIFTY moves less than the premium, not a theta harvest.

**C. The outcome is the range.** P&L against the realised range after entry: correlation -0.90 (09:30 and 11:00 entries). Days with range / premium below about 0.5: mean +23 to +38; above about 1.0: -27 to -46. Entry timing within the day matters much less than whether the day trends.

**D. Management helps the tail (exploratory).** Re-strike to the nearest strike when NIFTY is X points away (2 points cost per re-strike), entry 09:30: X=50 -10.2 mean, 7 re-strikes a day (over-trading); X=75 -6.3; **X=100 +9.9 mean, +18.5 median, worst -107 against -215 unmanaged**; X=150 +4.2. A 20% premium stop on 09:30 entries: mean -8.9 to +7.9, worst -217 to -75 (median unchanged); on 11:00 entries a stop hurts (-5.7 to -12/-18): intraday noise stops it out before it recovers.

**E. Nothing visible predicts the day.** Opening 30-minute range, the opening gap, the previous day's range, days to expiry and the premium each correlate with P&L at |r| <= 0.34 (n 14-15). Not enough to build a filter, enough to say no cheap filter works.

**F. Expiry-day entries after 11:00** were positive on all three expiry days in the sample (11:00: +23.5, +4.2, +51.2; 13:00: +32.5, +21.1, +41.5). A hypothesis to track, not a finding.

**G. The scores do not separate.** Seller score >= 60 (n=100 picks, 15-minute horizon): mean result -1.66 points, win 45.5%; mid band 48.8%. To the close: high band +11.2 points, win 75% (n=20), mid +7.1 (n=7): consistent with theta paying only when held, and too few picks to tell. The decay-arithmetic check (16 sessions, 191 windows): predicted mean -2.05 against actual -0.15, correlation 0.17.

**H. The NIFTY direction score has no validated skill.** Hit rate 53.4% at 15 minutes (CI 50.8-56.1), 52.2% at 30, 52.7% at 60, 41.2% to the close, correlation -0.03 to -0.11. Walk-forward per day swings from 16% to 95%: it follows each day's drift, it does not forecast it.

## 3. Problems found
1. The score answers "are conditions nice" while the money depends on "will the range stay under the premium": a forecast the system does not make. The 13 weights are hand-set and the bands do not separate outcomes.
2. "Decay efficiency" frames the trade as theta capture; on most days it is variance carry (implied minus realised) minus a movement cost.
3. No entry, no exit, no roll, no stop, no sizing guidance, and no estimate of what to expect (median, tail).
4. The directional score is unvalidated yet feeds flags and side risk.
5. Costs are assumed (2 points a round trip, last traded prices); real slippage unknown. The data window is 15 sessions.

## 4. Proposed work (in this order)
1. **Entry Lab (evaluation harness, read-only)**: replay the stored sessions with rule sets (entry time, strike choice, stop, roll threshold, exit, cost) and show median, mean, worst, win rate with sample size and confidence; refreshed daily as sessions accumulate; refuses to claim edge below a stated sample size. Everything below is judged in it.
2. **Reframe the decay intelligence**: expected move to the close against the premium (break-even points, distance to them, gamma risk per 50 points), implied against realised variance, premium retained since entry; theta efficiency becomes a detail.
3. **Range-expansion intelligence**: opening-range break, path efficiency, realised-vol acceleration, overnight gap (GIFT Nifty and US close are already collected), event calendar (high-impact releases inside the hold), expiry-day rules: tested in the Entry Lab before any enters a score.
4. **Management rules by entry time** (re-strike at about 100 points; stops for early entries only), with the tail budget stated up front (the two -215 days).
5. **Show history next to every score**: "in states like this, a short ATM straddle held to 15:15 produced median X, worst Y (n)".
6. **Demote the direction score** to context until it shows skill (reduce its share in flags and side risk; show its hit rate beside it).
7. **Costs**: record ATM bid/ask to replace the assumed 2 points.
