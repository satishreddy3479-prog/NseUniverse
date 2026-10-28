---
name: validate-financial-math
description: Validate financial formulas and calculations (PCR, OI change, IV, Greeks, etc.) before they are called correct. Use when adding or changing any calculation.
---
# Validate a calculation
1. **State the formula** explicitly (with source/reference).
2. **Define variables and units** (rates, time basis, price units, lot size).
3. **List required inputs** and where each comes from; note missing-input behavior.
4. **Check assumptions** (model type, dividends, rate source, day-count).
5. **Verify conventions** — expiry date/time, timezone, year basis, timestamp alignment.
6. **Test boundaries** — zero/missing, expiry day, deep ITM/OTM, extreme volatility.
7. **Independent comparison** where practical (second implementation, hand calculation, trusted library).
8. **Known examples/authoritative references** with expected values.
9. **Check numeric precision** and tolerance.
10. **Document limitations.**

Code that merely runs is not evidence of correctness. Label anything unverified as "unvalidated".
