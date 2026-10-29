# Intraday intelligence engine: status against the 29 Oct 2026 specification

Source: the owner's "Advanced NIFTY Intraday Intelligence & Prediction Engine" brief (modules A-N). The brief is a
multi-week programme; it is built in phases, smallest tested increment first. Status words follow the brief.
Nothing here has been validated on live Kotak data yet (first market session after 29 Oct decides).

| Brief module | Status | What exists / what is missing |
|---|---|---|
| 4 Data reliability | PARTIALLY IMPLEMENTED | Live/stale/historical labels, per-source freshness rows, session alignment, bounded stream reconnects, data-health list exist. Missing: one unified observation model, configurable thresholds per source, API-error status per feed. |
| A Price structure | IMPLEMENTED BUT NOT FULLY VALIDATED | Opening range (15 and 30 min), minute closes of completed minutes only, swing structure (HH/HL/LH/LL, break of structure, change of character, confirmed K points later) and day VWAP of the NIFTY future (exchange ATP: distance, slope, crosses, reclaim/rejection). Tested on synthetic paths with hand calculations. Index VWAP is impossible (no index volume); anchored VWAP NOT IMPLEMENTED. |
| B Breakout intelligence | IMPLEMENTED BUT NOT FULLY VALIDATED | Six states with objective rules, 0-100 quality score with a documented formula (distance, follow-through, VWAP, volume, breadth), every status recorded each minute (`breakout` samples). The score is not a probability and its predictive value is untested (needs sessions). Missing: retest, ATR extension, nearby levels, volatility-regime inputs. |
| C Breadth and sectors | IMPLEMENTED BUT NOT FULLY VALIDATED | NIFTY 50/500 advance-decline, equal-weight, contribution (official weights), sectors, rotation. Missing: % above VWAP, % above/below opening range, breadth momentum, breadth-price divergence alert. |
| D Options intelligence | PARTIALLY IMPLEMENTED | OI, OI change vs previous day (local), PCR (OI, volume), straddle, premium sums, call/put walls exist. Missing: premium/OI four-way classification, near-ATM and window PCR variants, concentration tracking across snapshots. |
| E IV, Greeks, expected move | NOT IMPLEMENTED | Straddle exists; no IV solver, Greeks, skew, term structure, IV change. Next in line (pure Black-Scholes on real option LTPs). |
| F Regime detection | PARTIALLY IMPLEMENTED | Trend / sideways / mean-reverting with gap tag from move size and 5-minute path efficiency. Missing: volatility expansion/contraction, potential reversal, event-driven states, ATR. |
| G Order flow and depth | IMPLEMENTED BUT NOT FULLY VALIDATED | Depth feed for the future and top-5 stocks; estimated CVD, order-book imbalance, price-vs-CVD divergence. Kotak's depth fields unverified live. Missing: spread metrics, absorption, liquidity deterioration. |
| H Global and events | PARTIALLY IMPLEMENTED | Previous-session global indices, USD/INR, event calendar. GIFT NIFTY and crude: not collected. |
| I Institutional flow | PARTIALLY IMPLEMENTED | NSE FII/DII of the previous session only (never used for same-day calls). |
| J Prediction engine | NOT IMPLEMENTED | Data collection and forward-return labels exist (feature_rows `if-1`). Barrier labels (upside/downside first), probability model, calibration and abstention await the staged session count (docs/intraday-ml-plan.md). |
| K Setup and risk engine | NOT IMPLEMENTED | Read-only; no order placement by design. |
| L Research database | PARTIALLY IMPLEMENTED | Observation DB, JSONL archives, minute samples, nightly feature rows, breakout and flow samples, EOD manifests. |
| M Backtesting, costs, calibration | NOT IMPLEMENTED | No backtest results or accuracy are claimed anywhere. |
| N Dashboard | PARTIALLY IMPLEMENTED | Command Center with regime, breadth, heavyweights, breakout intelligence, flow, sectors, options, data health. Missing: prediction, setup monitor, model performance, session replay widgets. |

## Order of the next increments
1. E: implied volatility and Greeks from real option LTPs (pure functions, validated against hand-solved Black-Scholes cases), IV change, skew, expected move.
2. C/D gaps: % above VWAP and opening range per constituent, breadth divergence, premium/OI classification.
3. J groundwork: barrier labels (touch first, ambiguous when both touch in one sample), chronological split and baselines, run as soon as sessions are stored; probabilities stay hidden until calibrated.
4. N: model-performance and replay widgets on stored sessions.
5. K, M: setup monitor and cost-aware paper evaluation, after J has evidence.
