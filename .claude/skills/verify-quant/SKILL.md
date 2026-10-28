---
name: verify-quant
description: Audit a quantitative or financial calculation (OI change, PCR, max pain, straddle, premium sums, later IV/Greeks) with independent tests before calling it correct. Use when adding or changing any formula or when numbers on screen look wrong.
---
# Verify a calculation
Extends `validate-financial-math` with the project's test pattern. Never make trading decisions or invent signals or market values; this skill checks arithmetic and definitions only.

1. **Write down** the formula, every input, its unit (units vs lots, paise vs rupees, per-share vs per-lot) and the universe it runs over (all strikes, ATM ±N, selected expiry).
2. **Find the authority:** the exchange/broker definition or an established mathematical definition (e.g. PCR = put total ÷ call total; max pain = settlement strike minimising total option-buyer payout). Cite it in the code comment or `docs/decisions.md`. If none can be found, label the result "unvalidated".
3. **Separate theory from observation.** A value computed from stored data is an observation of a snapshot; label its source and time. Theoretical values (model prices) are never shown as market prices.
4. **Edge cases:** missing OI/LTP (excluded and counted, not zero), prev OI = 0 (no percentage), zero denominator, single strike, expiry day, negative OI change, strikes with only one side, large numbers (float precision).
5. **Independent test:** (a) a small hand-calculated example with the arithmetic written in the test comment; (b) a brute-force implementation compared on a larger generated chain; (c) when possible, recompute from the raw real payload in `backend/tests/fixtures` rather than from the app's own normalised output.
6. **Check units end to end:** backend field -> `types.ts` -> formatter (`format.ts`, lakh/crore) -> label. Kotak's `oi.chg` is a price change and must not be used for OI change.
7. **Run** the targeted tests, then the full suites (see `test-dashboard`).
8. **Report:** formula, source, tests added, results (actual commands), assumptions still open, and anything left "unvalidated". Do not claim correctness without evidence.

Done when independent tests with known answers pass and the limitations are documented.
