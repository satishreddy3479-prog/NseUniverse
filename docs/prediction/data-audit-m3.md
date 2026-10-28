# Milestone 3: price-history audit and first baselines (2026-10-28)

Script: `research/m3_audit.py` (reproducible; reads an export of `data/market_history.sqlite3`). Source: Yahoo Finance via yfinance, downloaded on the user's PC on 2026-10-28 (25 series, 115,708 bars stored). **These are observations about the data and about naive baselines. They are not a model and not evidence that the market is predictable.**

## What was downloaded
All 25 configured series returned data. NIFTY 50: 4,689 daily bars, 2007-09-17 to 2026-10-28. India VIX from 2008-03, NIFTY sector indices from 2007-2011 depending on the index, US/Asia/Europe indices from 2007-01, US 10-year yield, Brent, WTI, gold, dollar index and USD/INR. Bars that could not be real (high below open/close etc.) were skipped, not repaired: Brent 69, gold 149, USD/INR 237, WTI 2, Nikkei 1 missing-price row. No later download has disagreed with a stored bar (0 disagreements so far).

## Integrity checks on NIFTY 50
- **2026 calendar match:** every 2026 session in the data is a session in the NSE-circular calendar and none is missing (0 missing, 0 extra). Independent confirmation of both the data and the calendar for 2026.
- One Saturday session in the data, 2025-02-01 (Union Budget day), which is a genuine special session. It is kept; the calendar's regular-session rule would not list it, so history is labelled from the recorded dates ("SessionCalendar"), as designed.
- One gap of more than five calendar days (2014-10-01 to 2014-10-07, a holiday cluster). The labeller without a calendar skipped that single label conservatively.
- Return outliers above 7%: 2008-01-21, 2008-10-24, 2009-05-18 (+17.7%, the 2009 election rally), 2020-03-12/16/23, 2020-04-07. All match known market events; no sign of corrupt bars. Four days have a close identical to the previous close (not yet inspected).
- Labels built: 4,687 T+1 and 4,683 T+5.

## Distribution of the targets (all history, descriptive)
| | Mean | Std dev | Share positive | 5th / 95th percentile |
|---|---|---|---|---|
| T+1 close-to-close | +0.043% | 1.29% | 52.9% | -1.82% / +1.86% |
| T+1 opening gap | +0.093% | 0.58% | **63.8% positive** | -0.70% / +0.83% |
| T+5 return | +0.21% | 2.90% | 55.9% | -4.17% / +4.35% |

Event frequencies (placeholders): T+1 |move| >= 0.5%: 56.0%, >= 1%: 28.9%; |gap| >= 0.3%: 39.8%, >= 0.5%: 21.5%; T+5 |return| >= 1%: 65.8%, >= 2%: 38.4%; five-session close drawdown of 2% or more: 24.8%. Up-day share by year ranges from 43.0% (2011) to 58.8% (2020); 2026 so far 47.5%.

**Caution on the gap:** a 63.8% positive-gap share is unusually high. It may be real (overnight drift) or an artefact of how Yahoo records the index open. Before any gap model is trusted, a sample of opens must be compared with NSE's official daily open values.

## First baselines (no learning), purged walk-forward
Folds: initial 1,000 training sessions, 250-session test windows, 3,500 test samples; training window ends `horizon + embargo` samples before each test window.

| T+1 direction | Result |
|---|---|
| Brier, climatology (training up-frequency) | 0.24896 |
| Brier, coin flip | 0.25000 |
| Log loss, climatology / coin flip | 0.69106 / 0.69315 |
| Always-up hit rate | 53.6% (95% interval 51.9-55.3%) |
| "Same as previous session" hit rate | 54.2% (52.6-55.9%) |
| MAE of zero-return vs training-mean forecast | 0.710% vs 0.708% |

| T+5 direction | Result |
|---|---|
| Brier, climatology / coin flip | 0.24517 / 0.25000 |
| Log loss, climatology / coin flip | 0.68346 / 0.69315 |
| Always-up hit rate | 57.5% (55.8-59.1%) |
| MAE zero-return vs training-mean | 1.713% vs 1.693% |

**Reading these honestly:** the simple baselines are barely better than a coin on probability scores, and the previous-session-direction rule is statistically indistinguishable from always guessing up. Any candidate model has to beat these numbers out of sample, in the same folds, with intervals that account for overlapping T+5 windows. Accuracy near 54-57% from always saying "up" shows why accuracy alone is not a result.

## What this unlocks and what it does not
- Unlocked: Milestones 4-5 (transparent T+1 and T+5 models on technical features) on a long daily history; global and sector features once their close times are verified.
- Still blocked or unverified: FII/DII and participant data (publication times, automated-download terms), news history, point-in-time constituents, official index open check, close times for non-Indian series.
- Next: build the technical feature set from NIFTY and India VIX (publication = 15:30 IST close), run the logistic/ridge baselines against the numbers above, then add global series after checking their close times.
