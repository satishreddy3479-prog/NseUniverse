# Swing engine backtest (research)

> **Status (2026-11-04):** the first results below (-19.6 %, +31.9 %) came from my own assumptions and are superseded by the section "Reconstruction with the original engine's rules" at the end, which matches the verified ledger's headline statistics.

Code: `research/swing/` (`chartink.py`, `data.py`, `indicators.py`, `backtest.py`, `run_backtest.py`, `fetch_data.py`). Tests: `backend/tests/unit/test_swing_backtest.py` (13, hand-calculated). Source spec: *Institutional Swing Trading Engine Master Specification* (PDF, user supplied).
Research only: not wired into the server, no orders, no live data.

## Run
```
cd research
python -m swing.fetch_data      # Chartink universe must exist in data/swing/universe.json; downloads Yahoo bars + sectors (parallel, ~15 s when cached)
python -m swing.run_backtest    # writes data/swing/results/{summary.json,trades_*.csv,equity_*.csv}
```
To refresh the universe: `chartink.save_universe(chartink.fetch_universe(), Path("data/swing/universe.json"))`.

## Result (2023-01-02 to 2026-11-03, 948 bars, capital Rs 10,00,000, run 2026-11-04)
| | Spec claim | Gross (spec rules) | Net, 0.15 % per side |
|---|---|---|---|
| Return | +80.01 % | **-19.59 %** | -41.61 % |
| CAGR | 16.56 % | -5.51 % | -13.05 % |
| Max drawdown | 13.91 % | 42.82 % | 53.54 % |
| Trades / win rate | 402 / 33.6 % | 571 / 28.4 % | 571 / 20.8 % |
| Avg win / avg loss | 2.62 | 2.30 | 3.03 |
| Profit factor | 1.77 | 0.91 | 0.8 |
| NIFTY 50 buy and hold | | +32.34 % (7.56 % CAGR) | |

**The spec's +80.01 % was not reproduced.** Parameters were not tuned toward it. Exit breakdown (gross): trailing/EMA stops +10.1 L (252 trades), Day-1 close-below-pivot cuts -5.0 L (184 trades, avg -0.35R), Day-1 stop-outs -6.9 L (84 trades, -1R). Entries are being stopped on day 1 far more often than the spec's "avg -2.1 % loss" implies. Sector gate / Mansfield / scorer details below are where my reading could differ from the author's.

## Data and provenance
- Universe: Chartink scan clause from the spec chapter 3, fetched 2026-11-04 (791 stocks). Spec says 807 on its own run date.
- Prices: Yahoo daily OHLCV, split-adjusted, dividends not folded in; from 2021-06 for warm-up. All 791 are included. 86 of them listed between Aug 2025 and Aug 2026 and only become eligible once they have ~200 bars (first run wrongly dropped them; fixed 2026-11-04, effect: +1 trade, -0.3 pt).
- Sector: Yahoo sector/industry text mapped with the spec's `map_stock_to_index()`; 1 stock had no sector (default CNXINFRA, per spec). Indices `^CNXAUTO` ... `^CNXPSE`, `^NSEI`.

## Limitations (these bias the result UPWARD, so the real figure is no better)
- **Look-ahead / survivorship:** Chartink returns today's fundamentals (ROE, ROCE, D/E, profit) and today's survivors, applied to 2023-2026. No point-in-time fundamentals or delisted stocks.
- Volume expansion uses the full T+1 day's volume, which is unknowable when the trigger fires intraday (spec rule, kept as written). Daily bars cannot order the intraday trigger vs the day's low.
- Costs are not in the spec; the 0.15 % per side figure is an assumption (STT, stamp, charges, slippage).
- Sharpe uses risk-free 0.

## Choices where the spec is silent
Pivot = highest high of the 20 bars **before** the signal bar (otherwise "breakout +0.0..+0.8 %" is impossible). Signal = score >= 60 and distance to pivot in [-4.0 %, +0.8 %] (the 0..-0.1 % gap treated as tight). Several same-day triggers: highest score first. ATR14 Wilder; ATR20 for Keltner is a simple mean of true range. NATR percentile = rank within the last 126 bars. Pocket pivot looks at the last 5 bars. Equity for sizing = prior-close mark-to-market. Stops are checked on the bar after they are set; gap-through exits at the open. Cooldown 3 bars. Positions open on the last bar are marked at the last close.

## Diagnosis: why half the entries die on day 1 (2026-11-04)
Not a code bug; the rules and the signal produce it.
- **Base rate:** over all 4,370 trigger events (no slot limit), 36.7 % close below the pivot on day 1. With 5 slots the portfolio saw 51 % day-1 exits (184 close-below-pivot, 84 stop-outs, 22 wick). The close-below-pivot rule fires when the close is only 0.3 % under the fill, so ordinary breakout fades trip it.
- **The Day-1 cuts help:** switching off the close/wick cuts gives -30.9 % instead of -19.3 %. Removing the volume filter is worse (-55.2 %); both off, -34.2 %.
- **Stops are wide:** median initial risk 5.2 % (cap 5.5 % binds for volatile names), so each of the 84 day-1 stop-outs costs about -4.9 % of the position (-1R).
- **Signal edge is tiny:** mean return fill to +5 days is +0.99 % (median +0.23 %) against +0.31 % (median -0.17 %) for any stock-day; fill to +10 days +1.70 %. That is far below the ~4.8 % risk taken, so whipsaws dominate.
- **Gap-up entries (17 %)** do worst: 65 % exit day 1, -0.24R, -2.2 L. Score does not rank outcomes (score >80: -0.55R).
- Conclusion: under these rules on this data the +80 % is not reachable and I cannot verify how the spec's figure was produced. Diagnostic switches `Params.day1_cuts` / `require_volume` exist for this analysis only (defaults are the spec rules).

## Pre-move pattern study (t-10..t-1 window, 2026-11-04)
Code: `research/swing/movers.py`, `build_movers.py`, `analyze_movers.py`, `entry_study.py`. Dataset `data/swing/movers_dataset.parquet`: 538,728 stock-days (730 stocks, turnover >= Rs 1 Cr), 43 features from the 10 bars ending the day before, label = next day closes +5..+15 % (17,258 events, base rate 3.2 %). Split: fit 2023-24, check 2025, 2026 held out. Universe caveat as above (today's Chartink list).
- **Strongest signal is volatility, not contraction:** average daily range, NATR and Bollinger width (AUC 0.63-0.70, same sign in all three periods). Picking the 5 most volatile stocks a day hits 8-9 % vs 3.2 % base.
- **Model (gradient boosting) adds a real but modest lift:** out-of-sample AUC 0.70-0.71; top-5/day hit rate 12.4 % (2025) and 13.0 % (2026), about 4x base and about +4 points over volatility alone; 3 of ~13 points are gap-ups of 3 %+ that an open entry cannot catch.
- **Institutional features are weak and mostly point the other way from the VCP idea:** within equal-volatility groups the stable positives are volume expansion (vol_ratio AUC 0.57), recent 3-day volume vs 50-day (0.56), distance above the 20 EMA (0.56), range/volume expanding (coil >1). Volume dry-up days lower the odds (AUC 0.47), NR7 lowers them (0.48), CMF is near nothing (0.51-0.53). Movers tend to be stocks already waking up.
- **No trading edge found:** top-5 picks average +0.4-0.5 % close-to-close but about 0 % open-to-close (-0.05 %). A buy-stop entry (0-3 % above prev close) with a 2.5 % or 4 % stop and next-close exit loses in every one of 8 settings in both 2025 and 2026 (average -0.5 % to -1.9 % per trade after 0.3 % round-trip costs; best case profit factor 0.73). Stop assumed hit first when both touch in a bar; one-day hold only.
- Not tested: multi-day holds, intraday entries, other labels (e.g. +5 % within 3 days), a portfolio simulation.

## Multi-day holds and the 3-day label (2026-11-04)
Code: `research/swing/multiday_study.py`. Two rankings fitted on 2023-24: A = next-day close +5..15 %, B = a high of at least +5 % within the next 3 days (base rate 22-24 %). Top 5 per day, entry next bar at the open or a buy-stop 1 % above prev close (gaps over 4 % skipped), 5 exit rules compared on 2025 and shown with 2026: stop 3 %/hold 3 d, stop 5 %/hold 5 d, stop 5 %/hold 10 d, 5 % trailing/hold 10 d, stop 3 % + target 8 %/hold 5 d. Costs 0.3 % round trip (assumption). Stop assumed hit first when both touch in one daily bar.
- **Label B is predictable:** top-5 hit rate 49.4 % (2025) and 53.2 % (2026) vs 22-24 % base and 40-45 % for the most volatile 5. AUC 0.68.
- **None of the 20 combinations makes money, even before costs.** Gross average per trade -0.2 % to -1.3 %; net -0.5 % to -1.6 %; best profit factor 0.85 (A, open entry, stop 5 %, hold 10 d, 2026); 2025 best 0.80. Results in 2025 and 2026 agree in sign everywhere.
- **Simulator sanity check:** with no stop, random liquid stock-days average -0.13 % over 5 days and -0.06 % over 10; the 5 most volatile stocks -0.29 % and -0.06 %: near zero, as expected. Adding a 5 % stop worsens both (-0.31 %, -0.77 %), i.e. volatile stocks get stopped out by noise. Exit logic is covered by 5 hand-calculated tests.
- Reading: the model finds stocks that WILL touch +5 % often, but the same stocks swing both ways, so a stop that limits loss also cuts most winners; entering at the open or after confirmation captures none of the move's edge.
- Still untested: intraday entries (the pre-open / first-hour signal), regime filters, position-level portfolio simulation, a different universe (untested outside today's Chartink list).

## Re-run at MIN_BREAKOUT_SCORE = 65 (2026-11-04)
The user supplied the score threshold used by the spec's own engine (65, not my assumed 60). `Params.min_score` default is now 65; the earlier 60 results above are kept as the sensitivity case. Best-score-first slot priority and Day-1 exit-at-close were already in the engine; stops were already tested on the current bar against the level set at the previous close.

| | Spec claim | Score 65, before costs | Score 65, 0.15 % per side |
|---|---|---|---|
| Return | +80.01 % | +31.85 % | -2.82 % |
| CAGR / max drawdown | 16.56 % / 13.91 % | 7.45 % / 20.22 % | -0.74 % / 28.75 % |
| Trades / win rate | 402 / 33.6 % | 534 / 30.7 % | 534 / 22.5 % |
| Profit factor / Calmar | 1.77 / 1.19 | 1.12 / 0.37 | 0.99 / -0.03 |

NIFTY 50 buy and hold over the same bars: +32.34 %. Still not reproduced (return, drawdown, trade count and profit factor all differ).

- **Same-bar trailing variant** (`Params.same_bar_trail`, diagnostic only: trail with the day's high, then test the day's low; uses a high that may print after the low): worse, -19.1 % at 65 and -47.2 % at 60. It is not the cause of the gap.
- **Threshold sensitivity (gross / net of costs):** 60: -19.6 / -41.6; 62: +16.3 / -15.1; 64: +9.0 / -19.7; 65: +31.9 / -2.8; 66: +39.8 / +4.5; 68: +46.3 / +12.3; 70: +2.9 / -19.5; 72: +22.6 / +0.8. The result swings by tens of points between neighbouring thresholds, so no single threshold can be trusted.
- **Concentration at 65:** by year +24.4 % (2023), -0.1 % (2024), -8.0 % (2025), +15.2 % (2026); the 10 best trades earned Rs 6.07 L against a total profit of Rs 3.19 L, so without them the strategy loses Rs 2.89 L.
- **Exit mix at 65 (gross):** 188 Day-1 close-below-pivot cuts (-6.8 L), 58 Day-1 stop-outs (-6.4 L), 244 trailing stops (+15.0 L).

## Comparison with the user's verified-run excerpt (2026-11-04)
The user supplied the original engine's settings, a year-by-year table and its top-10 2024 trades (the pasted excerpt, not the full ledger; I cannot verify the +80.01 % run itself).
- **Mechanics match exactly:** for all 10 ledger trades, `max(open, 20-bar prior high x 1.003)` computed on Yahoo **dividend-adjusted** prices (`auto_adjust=True`, adjusted with today's factors) reproduces the ledger entry price to the paisa. On raw prices 8 of 10 differ by 0.13-4.1 %. So pivot, trigger and fill logic agree; the original engine ran on adjusted prices, and its ledger prices are not prices that traded (SHARDAMOTR entry 1776.62 is below that day's actual low of 1805.80).
- **Adjusted prices alone do not explain the gap:** engine on adjusted data (`data/swing/cache_adj`, score 65): 481 trades, +41.9 % before costs, +7.8 % after 0.15 %/side, max drawdown 21.8 %; by year +34.1 / -11.4 / -1.1 / +20.3 % of capital vs the ledger's +24.9 / +44.0 / +4.5 / +6.6 %.
- **Hard distance gate (-4 %..+0.8 %) is not the cause:** removing it gives 487 trades, +33.8 % gross, +0.8 % net.
- **Day-1 low stop is inconsistent with the ledger:** SKYGOLD (2024-07-02) filled at 170.00, day-1 low 158.16 is below the stop floor of 160.65 (fill x 0.945), yet the ledger shows a +18 % winner held 14 days. With the written rule it exits on day 1. Diagnostic run with the Day-1 LOW stop off (close-based Day-1 cuts kept; `Params.day1_stop=False`): 474 trades, +66.8 % gross, max drawdown 18.7 %, profit factor 1.27, by year +36.3 / -1.5 / +4.2 / +27.8 %. That is closer but still short of +80 % and still misses 2024 (+44 %). Not adopted: it means ignoring a stop that would have filled live.
- **Of the 10 listed trades my adjusted run took 4** (COROMANDEL +22.2 %, V2RETAIL +18.8 %, ALKEM +14.7 %, DHANUKA +16.2 %: returns within about 1 point of the ledger). Of the other 6: ARROWGREEN scores 62 in my scorer (below 65), so the scorers differ by at least 3 points on 2024-07-23; the remaining 5 passed my signal but all 5 slots were already occupied, and slot occupancy cascades through a path-dependent portfolio.
- **Internal inconsistency in the excerpt:** yearly gross profit sums to Rs 19.45 L (loss Rs 11.45 L, profit factor 1.70) while the PDF states Rs 18.4 L / Rs 10.4 L (1.77), and the excerpt says Stage-2 trailing exits alone earned Rs 31.4 L, more than total gross profit.
- Still needed for a trade-by-trade reconciliation: the full 402-trade ledger (the app's `/api/trades/export` CSV) and the per-pillar score of ARROWGREEN on 2024-07-23.

## Audit of the full 402-trade ledger and reconciliation (2026-11-04)
Source: user-supplied `swing_trading_engine_full_audit_2023_2026.csv` (402 rows, 33 columns). Ledger prices are Yahoo dividend-adjusted. Checks below are my own computations from that file and Yahoo data.

**Ledger on its own terms**
- Net +Rs 8,00,089.62 (+80.01 %); 135 wins / 267 losses; gross profit Rs 31.91 L, gross loss Rs 23.91 L, so **profit factor 1.33 (the PDF headline says 1.77)**; average R **+0.13** (PDF: +0.43); holding days win/loss 23.1 / 5.1 (PDF: 18.2 / 4.1).
- No costs are applied (`pnl = shares x (exit - entry)`). Turnover Rs 23.8 Cr; at 0.15 % per side the ledger would be +44.3 % and at 0.10 % per side +56.2 %.
- **The 10 best trades are 89.7 % of net profit**; without them net is +Rs 82,132 (+8.2 %).
- First entry is 2023-06-01 (no trades Jan-May 2023). Year totals: 2023 +24.9 % (80 trades), 2024 +44.0 % (140), 2025 +4.5 % (96), 2026 +6.6 % (86). The yearly gross-profit/loss figures in the earlier pasted excerpt do not match the ledger (nets do).
- Rule consistency checked from the ledger's own columns: 0 violations of the Day-1 stop/close/wick rules, entry = max(open, pivot x 1.003) on all rows, no entries with open above pivot x 1.025, no score below 65, max 5 concurrent positions, slot size at most 20 % of equity, risk at most 1.62 % of equity. Stop distance exceeds 5.5 % of entry on 38.8 % of trades (max 8.7 %): the spec's "5.5 % maximum risk" does not hold in the ledger.
- 6 ledger symbols (BAJFINANCE, BHARTIARTL, KAYNES, PFC, RECLTD, TITAN) are not in today's 791-stock Chartink universe, so the original universe differs from mine.

**Confirmed: initial stop anchor.** On 97.2 % of ledger trades `initial_sl = max(pivot - 1.5 x ATR14, signal-day close x 0.945)` (fill-anchored version matches 59.5 %). Implemented as `Params.sl_anchor = "signal_close"`. This removes about 40 percent of my day-1 stop-outs and lifts the result (below).

**Scorer comparison (395 ledger signals).** Pivot, entry open and entry low agree with my adjusted-price data on 98.5-99.2 % of trades. Score agrees exactly on 61 % with my first scorer and 70.9 % when the Keltner ATR is Wilder-smoothed (`kc_atr="wilder20"`; reproduces ARROWGREEN's 14-bar squeeze). ARROWGREEN 2024-07-23: pillars 2, 3, 4 match the user's breakdown exactly (17, 20, 7). The rest of the gap is the NATR-percentile pillar: the ledger's percentile runs about 10-15 points below the plain 126-bar rank (user: 20.4 vs 32.5 here) and no past-only window I tried reproduces it. Unresolved; needs the engine's NATR percentile code.

**Same trade, same result.** With best reconstruction (adjusted prices, Wilder ATR20 squeeze, signal-close stop, start 2023-05-31) both engines took 171 identical trades; on those, returns agree (median absolute difference 0.0 points), 90 % share the exit date and Day-1 exit classification agrees on all. Execution and exit mechanics are therefore equivalent. The difference is **which trades get the 5 slots**: ledger-only 2024 trades earned +32.3 % of capital, my 66 non-ledger 2024 trades lost -20.3 %.

**Result of the reconstruction (before costs / 0.15 % per side)**
| run | trades | return | max DD | PF |
|---|---|---|---|---|
| ledger | 402 | +80.0 % (no costs) | 13.9 % | 1.33 |
| adjusted, signal-close stop, Wilder, from 2023-05-31 | 418 | +52.6 % / +20.4 % | 23.7 % | 1.24 |
| same, from 2023-01-01 | 463 | +71.4 % / +31.7 % | 23.6 % | 1.28 |
| same as first row of mine, raw (tradable) prices, fill-anchored stop, score 65 | 534 | +31.9 % / -2.8 % | 20.2 % | 1.12 |

**Tie-break sensitivity (the key robustness finding).** Scores are whole numbers, so many candidates tie for the 5 slots. Same rules, same data, only the order of equal-score candidates changed (from 2023-05-31): alphabetical +52.6 %, closest to pivot +59.0 %, strongest relative strength +88.9 %, random order +72.3 / +71.6 / +57.4 % (three seeds). Look-ahead probes (order by next-day volume +72.7 %, by next-day return +82.3 %) are in the same range. None of these raises the overlap with the ledger (158-171 of 402 trades) and none reproduces 2024 (+44 %). An arbitrary ordering of ties moves the result by more than 35 points, so a single backtest number, including +80 %, is not robust evidence of an edge.

Code changes: `Params.sl_anchor`, `Params.tie_break` / `tie_seed` (default alphabetical = previous behaviour), `indicators.compute(kc_atr, natr_window, dur_rule)`, `run_backtest.build(cache_name, start, **score_kw)`. Defaults reproduce the earlier numbers (raw prices: 534 trades, +31.85 %).

## Reconstruction with the original engine's rules (2026-11-04)
The user supplied the engine's NATR-percentile and ordering code. Findings and effect:
- **NATR "percentile" is a min-max scaler,** `(natr - min126) / (max126 - min126 + 1e-6)` (`indicators.minmax_pct`), not a statistical rank. With it (plus Wilder-smoothed ATR20 in the Keltner channel) ARROWGREEN on 2024-07-23 scores 68 as in the ledger and **92.9 % of the ledger's 395 signal scores are reproduced exactly** (70.9 % before; mean absolute difference 2.05). The min and max the user quoted (2.44 / 15.06) differ from my data (4.20 / 8.25) though the resulting 20.4 % agrees.
- **Tie-break is stable alphabetical order**, which is what the engine already did.
- **Sizing: the PDF's 2 % risk matches, the user's later "1 %" does not.** 1 % gives +62.7 %, 2 % gives +83.3 % (same run). The ledger's own share counts match a 2 % rule on 68 % of trades; its risk-to-equity ratio is median 0.99 %, max 1.62 %, so its sizing is not a clean 1 % cap either (slot size binds, since a stop about 5 % away makes 20 % of equity roughly 1 % risk).
- Defaults are now the reconstruction: signal-close stop anchor, `kc_atr="wilder20"`, `natr_method="minmax"`, 2 % risk, score >= 65, alphabetical ties.

| Run (before costs) | Trades | Return | Max DD | PF | Win |
|---|---|---|---|---|---|
| Ledger (adjusted prices, from 2023-06-01) | 402 | +80.0 % | 13.9 % | 1.33 | 33.6 % |
| Mine, adjusted, ledger universe incl. 6 extra symbols, from 2023-05-31 | 400 | +83.3 % | 13.0 % | 1.36 | 34.0 % |
| Mine, **raw tradable prices**, same | 423 | +80.7 % | 14.4 % | 1.32 | |
| Mine, raw, Chartink 791 only, from 2023-01-01 (`run_backtest` default) | 467 | **+95.4 %** | 14.2 % | 1.33 | 34.0 % |

After 0.15 % per side costs: adjusted +46.0 %, raw (6 extra symbols, from 2023-05-31) +41.7 %, default run (Chartink only, from 2023-01-01) +48.6 % (CAGR 10.9 %, max DD 17.1 %). NIFTY 50 buy and hold over the default run: +32.3 % (7.6 % CAGR). The ledger itself applies no costs.

Robustness (adjusted, from 2023-05-31, before costs): tie order random (5 seeds) +69 % to +91 %, closest-to-pivot +90.5 %, strongest relative strength +89.5 %; min score 66 / 67 / 68: +87.9 / +85.4 / +90.0 %, but **63: +23.2 % and 64: +43.2 %**. By year in the default run: 2023 +33.2 %, 2024 +35.1 %, 2025 +1.8 %, 2026 +25.4 % of capital.

What this does and does not show:
- Aggregate statistics (trades, return, drawdown, profit factor, win rate) reproduce within noise. Individual trades do not: only 181 of the ledger's 402 trades coincide with mine (7 % of scores still differ, the universe differs, and slot occupancy cascades). The yearly split also differs (ledger 2024 +44 % vs mine about +18 %).
- Concentration: the 10 best trades are 90-100 % of net profit, so without them the system roughly breaks even.
- Costs remove about 40 points of return; the edge after costs is about +42-49 % over 3.7-3.9 years against NIFTY +32 %.
- Start-date and tie-order noise is about +-10-15 points (+80.7 % from 2023-05-31 vs +95.4 % from 2023-01-01).
- Survivorship: universe is today's Chartink list (plus the ledger's 6 extra symbols in comparison runs); fundamentals are not point-in-time. The original engine's own 807-stock universe is not available, so the comparison universe is approximate.
- Not tested live or forward; the earlier daily-bar mover study (no tradable edge for 1-10 day holds) is a separate system and its conclusion stands.

## Website and automatic paper trading (2026-11-05, D65)
**Swing trading page** (`/swing`): Paper trading (default), Backtest, Backtest trades (filter, sort, CSV), Robustness, Rules & limits.

**How the paper trader runs** (`backend/app/swing`, standard library only, started with the backend):
1. From 17:00 IST (retry every 15 min until 23:30) it reads the Chartink list and Yahoo daily bars. It acts only when at least 90 % of the list has usable bars and every held or queued stock has bars; otherwise nothing is written and it retries.
2. **Settle** the session that just closed: last night's orders are judged on today's bar (no-chase gap, trigger, volume, free slot, 3-session cooldown), Day-1 cuts and stops are applied, trailing stops are updated, positions are marked to market (virtual Rs 10 L, 5 slots, 2 % risk, 0.15 % cost per side).
3. **Scan** every stock with the same scorer as the backtest, apply the NIFTY and sector gates, and queue the orders for the next session (best score first, ties alphabetical).
4. Everything for a session is committed in one transaction to `data/swing_paper.sqlite3` (append-only). A missed day is replayed in order the next time it runs. Manual pass: `python -m app.swing --data-dir PATH` from `backend`.

**Proof it is the same strategy:** `tests/unit/test_swing_indicators.py` (stdlib scorer = pandas scorer on every field at many bars; separately 1,455 real stock-days with 0 differences), `test_swing_engine.py` (paper engine = research backtest trade for trade on 30 synthetic stocks), `test_swing_service.py` (running day by day gives exactly the same book as one catch-up pass; incomplete data changes nothing; history cannot be edited).

**Live check, 2026-11-05 (scratch folder, real Chartink and Yahoo):** 803 of 803 stocks fetched, NIFTY gate open, 7 orders queued for the next session, 4 more blocked by the sector gate; 533 seconds (sequential, gentle on Yahoo), about 50 MB resident, Python peak 3.6 MB. Yahoo's newest bar had no close just after midnight, so that run settled 3 Nov; the job picks 4 Nov up on its own once the bar is complete.

**Limits of paper trading:** fills are simulated on the daily bar at the rule prices (the trigger is assumed filled when the high trades through it, the stop first when both trade in one bar, full-day volume is used for the volume rule), so real fills can be worse; the Chartink list is today's list but is now stored every day (point-in-time from here on); Yahoo currently needs the plain `Mozilla/5.0` user agent (long browser strings get HTTP 429), and if that changes the job fails safe and the page shows the book as stale. A few months of forward results are needed before drawing conclusions.

## Live prices from the Kotak feed (shadow mode, 2026-11-05, D66)
The after-close job stays the authority for the paper book. A live layer (`backend/app/swing/live.py`, `live_rules.py`)
adds what the feed makes possible during the session, for the few stocks that matter: tonight's queued orders and the open
positions (about a dozen).

- **Feed:** those stocks are subscribed on the running Kotak feed (`StreamManager.add_internal_tokens`, kept off the browser
  feed; re-subscribed on every reconnect through the universe provider). Tokens come from Kotak's instrument file
  (`scrip_master_rows`, which the code notes has not been exercised against the live service yet).
- **Pull, not hook:** every 2 seconds the layer reads the feed's latest value per stock. It is not on the tick path, so it cannot
  disturb the feed. Ticks older than 2 minutes are shown but never acted on; nothing is acted on outside 09:15-15:30 IST.
- **Rules applied to live prices:** entry = price through the trigger (pivot x 1.003), the open not above pivot x 1.025, and volume
  at pace (day volume so far at least the minimum volume scaled by the share of the session elapsed, a straight-line stand-in for
  the backtest's full-day rule); stop = last price or day low at or below the stop, filled at the stop or at the open if it gapped
  through; targets = the 1.8R (breakeven) and 2.5R (trailing) levels, reached by the day's high.
- **Stops and targets are not moved intraday.** The stop stays where the last close set it and the end-of-day job raises it from the
  day's high, exactly as backtested; reaching 1.8R or 2.5R is shown and logged, not acted on.
- **Shadow mode:** what the rules would do is shown on the page and logged once a day per kind and stock in `live_events`
  (append-only). The paper book is **not** changed by it. The paper record is permanent, and the live path cannot be tested before
  the first session, so live execution is enabled only after one session's shadow events have been compared with the end-of-day result.
- **Page:** the Paper trading tab has a "Live prices from your Kotak feed" panel (price, day change, volume and pace, distance to
  trigger, stop and targets, state in words, today's shadow decisions); `GET /api/swing/live`; setting `SWING_LIVE_ENABLED`.

**To verify in the first session (not verifiable before):** the instrument file downloads and resolves the watched symbols; the
feed's `volume` is the cumulative day volume in shares; the day open arrives on the first tick; ticks keep flowing for the extra
subscriptions without disturbing the existing ones; shadow trigger and stop events match what the end-of-day bar says.

**Then, phase 2 (live execution):** fills, stop exits and cash movements written to the book as they happen, with the end-of-day job
applying only the close-based day-1 cuts and the stop updates, and acting as the fallback when the feed is down. Needs: cash movements
logged between sessions, entry source on positions, the settlement skipping orders already decided live, and tests of each.

