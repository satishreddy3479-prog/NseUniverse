# Intraday intelligence engine: status against the 29 Oct 2026 specification

Source: the owner's "Advanced NIFTY Intraday Intelligence & Prediction Engine" brief (modules A-N). The brief is a
multi-week programme; it is built in phases, smallest tested increment first. Status words follow the brief.
Nothing here has been validated on live Kotak data yet (first market session after 29 Oct decides).

| Brief module | Status | What exists / what is missing |
|---|---|---|
| 4 Data reliability | PARTIALLY IMPLEMENTED | Live/stale/historical labels, per-source freshness rows, session alignment, bounded stream reconnects, data-health list exist. Missing: one unified observation model, configurable thresholds per source, API-error status per feed. |
| A Price structure | IMPLEMENTED BUT NOT FULLY VALIDATED | Opening range (15 and 30 min), minute closes of completed minutes only, swing structure (HH/HL/LH/LL, break of structure, change of character, confirmed K points later) and day VWAP of the NIFTY future (exchange ATP: distance, slope, crosses, reclaim/rejection). Tested on synthetic paths with hand calculations. Index VWAP is impossible (no index volume); anchored VWAP NOT IMPLEMENTED. |
| B Breakout intelligence | IMPLEMENTED BUT NOT FULLY VALIDATED | Six states with objective rules, 0-100 quality score with a documented formula (distance, follow-through, VWAP, volume, breadth), every status recorded each minute (`breakout` samples). The score is not a probability and its predictive value is untested (needs sessions). Missing: retest, ATR extension, nearby levels, volatility-regime inputs. |
| C Breadth and sectors | IMPLEMENTED BUT NOT FULLY VALIDATED | NIFTY 50/500 advance-decline, equal-weight, contribution (official weights), sectors, rotation; % of NIFTY 50 above own day VWAP (exchange average traded price), % above/below the 15-minute opening range (from recorded samples), 15-minute breadth momentum and price/breadth divergence. Tested with hand counts; needs live ticks. Missing: sector-level VWAP participation. |
| D Options intelligence | IMPLEMENTED BUT NOT FULLY VALIDATED | OI, OI change vs previous day, PCR (OI, volume) over ATM ±2/5/10 and all strikes, OI-change PCR since the open (only when call OI rose), four-way premium/OI reading against 15 minutes earlier with explicit limits, top-3 OI concentration and its shift since the open, straddle, walls, IV term structure across the expiries sampled together. Window PCR cross-checked against the existing feature on the real 28 Oct chain. Missing: expiry-specific positioning history, volume/OI ratio. |
| E IV, Greeks, expected move | IMPLEMENTED BUT NOT FULLY VALIDATED | Black-76 with the forward from put-call parity (no dividend assumption), bisection IV, delta/gamma/theta/vega, ATM and near-ATM IV, 25-delta skew, IV change over 5/15/30 min, realised volatility (60 min) and IV minus realised, straddle and one-sd expected move, contextual IV/price observations. Checked against a hand-solved Black-76 value, finite-difference Greeks, round-trip IV, and the real captured 28 Oct chain (ATM IV 16.5 %, straddle = 0.80 x one-sd move). Not compared with a broker reference IV (Kotak's chain carries none we use). Missing: term structure across expiries. |
| F Regime detection | PARTIALLY IMPLEMENTED | Trend / sideways / mean-reverting with gap tag from move size and 5-minute path efficiency. Missing: volatility expansion/contraction, potential reversal, event-driven states, ATR. |
| G Order flow and depth | IMPLEMENTED BUT NOT FULLY VALIDATED | Depth feed for the future and top-5 stocks; estimated CVD, order-book imbalance, price-vs-CVD divergence. Kotak's depth fields unverified live. Missing: spread metrics, absorption, liquidity deterioration. |
| H Global and events | PARTIALLY IMPLEMENTED | Previous-session global indices, USD/INR, event calendar. GIFT NIFTY and crude: not collected. |
| I Institutional flow | PARTIALLY IMPLEMENTED | NSE FII/DII of the previous session only (never used for same-day calls). |
| J Prediction engine | PARTIALLY IMPLEMENTED | Barrier labels (up/down touched first, none, ambiguous, missing) with volatility-scaled thresholds; walk-forward evaluation with majority, momentum and opening-range baselines and a regularised multinomial logistic model; log loss, Brier, accuracy, balanced accuracy, confusion, calibration; a gate that withholds probabilities until 20 sessions, a clear edge and calibration. Runs on stored sessions (`/api/intraday/research`); today it reports insufficient data. No probabilities are produced or shown. Missing: abstention rules tied to live data quality, VWAP/breadth/IV features in the dataset (needs `if-2`), time-of-day and regime breakdowns. |
| K Setup and risk engine | NOT IMPLEMENTED | Read-only; no order placement by design. |
| L Research database | PARTIALLY IMPLEMENTED | Observation DB, JSONL archives, minute samples, nightly feature rows, breakout and flow samples, EOD manifests. |
| M Backtesting, costs, calibration | NOT IMPLEMENTED | No backtest results or accuracy are claimed anywhere. |
| N Dashboard | PARTIALLY IMPLEMENTED | Command Center: regime, breadth, heavyweights, breakout intelligence, IV and Greeks, options positioning detail, futures flow, sectors, prediction-model research status, data health. Missing: prediction probabilities (by design until validated), setup monitor, session replay. |

## Order of the next increments
1. (done 29 Oct) E: implied volatility, Greeks, expected move.
2. (done 29 Oct) C gaps and D gaps.
3. (done 29 Oct) J groundwork: barrier labels, chronological evaluation, baselines, gate. Waits for stored sessions.
4. Dataset `if-2` (VWAP distance, futures flow, breadth, IV, breakout state as features) so the model can be tested on the new evidence; session replay widget.
5. K, M: setup monitor and cost-aware paper evaluation, after J has evidence.
