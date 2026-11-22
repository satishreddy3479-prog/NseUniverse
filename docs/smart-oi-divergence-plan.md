# Smart OI divergence indicators: plan (23 Nov 2026)

Status: plan only, nothing built. Owner request: our own divergence indicators in Smart OI, using all the data Smart OI holds.

## What Smart OI has per candle (1, 3, 5 or 15 minutes, from stored one-minute samples)
- Price: NIFTY open, high, low, close (index bars; future-derived proxy minutes are flagged).
- Positioning flow: change in put OI (dPE), change in call OI (dCE), **Smart OI p = dPE - dCE**; day change of each against yesterday's close; day difference.
- Ratios: OI PCR; volume PCR (cumulative).
- Activity: put and call option volume per candle and cumulative.
- Quality flags: gap candles, strike-count changes, stalled index quote, thin bars, proxy minutes.
- Beside it (other stored series, same sessions): NIFTY future price, OI, volume and basis; per-strike option prices, OI and volume for ATM +-10, so implied volatility and premium change per strike.

## The indicators (each is a pure function in `lib/smartOiDivergence.ts`, same rules as the rest: missing stays missing, never zero)
1. **Flow divergence (price against cumulative Smart OI).** Cumulative Smart OI (CSOI = running sum of p) against price at confirmed swing highs and lows (a pivot needs k candles each side, k by timeframe). Regular bearish: price higher high, CSOI lower high. Regular bullish: price lower low, CSOI higher low. Hidden forms for trend continuation. Strength = normalised gap between the two slopes, so it is comparable across days.
2. **Writing or buying (interpretation-aware Smart OI).** Smart OI alone cannot say whether added put OI is put writing (bullish) or put buying (bearish). Using the premium change of the same strikes in the same candle: OI up with premium down = writing; OI up with premium up = buying. A divergence is raised when the label Smart OI gives (bullish or bearish) disagrees with who is actually paying.
3. **Conviction divergence (OI against volume).** |dOI| / option volume in the candle: a price move on high volume but flat OI is churn and squaring-off, not new positions; a move on rising OI is new money. Divergence = price extends while conviction falls.
4. **PCR divergence.** OI PCR trend against volume PCR trend (what is held against what is traded), and each against price.
5. **Future against options.** NIFTY future OI and price direction (long or short build-up) against Smart OI direction; basis change as a third witness.
6. **Zone divergence.** Where the change sits: dOI below spot against dOI above spot (support building against resistance building), near-ATM against the wings, and how the largest-change strike migrates. Needs the per-strike series, not only the totals.
7. **Momentum divergence.** Rate of change and acceleration of Smart OI (EMA slope) against price rate of change; and Smart OI's z-score against its own day and against the same time of day over the stored sessions (percentile), so a reading is "unusual for this time", not just "large".
8. **Composite.** A small state machine (none, forming, confirmed, failed) per indicator, a combined agreement count and an evidence-quality grade that drops when gaps, strike changes, stalls or proxy bars are inside the window.

## Build order
1. **Inputs and quality** (1 day): one typed series object joining Smart OI candles, per-strike premium/OI/volume and the future series on the same candle grid; tests that every join is exact or missing.
2. **Library** (2 to 3 days): indicators 1, 3, 4, 7 first (data already in the candles), then 2, 5, 6. Each with hand-calculated tests (small series where the divergence is counted by hand) and a test on a real captured session.
3. **UI** (1 to 2 days): markers on the Smart OI chart (triangles at confirmation, a dashed link between the two pivots), a divergence panel (active, forming, recent; direction, strength, window, evidence quality), a one-line summary on the Market Intelligence page, "how to read" text that states each rule.
4. **Research harness** (2 days): a script over the stored sessions (30 days on the server plus bundles): forward return and forward range after each confirmed signal at 15, 30 and 60 minutes against the all-candles baseline, with sample counts. Thresholds are fitted on the earlier sessions and judged on the later ones only. Until a signal beats its baseline with enough samples it is labelled "indicator, not validated" on screen. The earlier prediction engine was removed (D148); this stays an indicator and never produces an order or a target.
5. **Optional**: Heads-up alert on a confirmed high-quality divergence; weight in the intelligence summary only after step 4 supports it.

## Decisions needed from the owner
- Priority: all eight, or start with 1, 2 and 3 (the ones with the strongest reason)?
- Default timeframe (3 minutes today) and whether signals are shown on every timeframe or one.
- Whether the research step may use the server's stored sessions through the usual backup copy (read only).
- Expiry day: separate thresholds (OI behaves differently), or skip signals on expiry day until tested.

## Limits to state on screen
- Smart OI is built from ATM +-10 strikes only; far wings are not in it.
- Option volume and OI come from stored one-minute samples, not every trade; a candle's change is a difference of two samples.
- A divergence says positioning and price disagree; it does not say which one is right.
