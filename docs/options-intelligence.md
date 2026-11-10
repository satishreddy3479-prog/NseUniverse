# Options intelligence and market regime (10 Nov 2026)

Decision record: D97 (foundation) and D98 (this document's scope). Everything below is derived from the stored option-chain samples the sampler already writes (gzip files plus the SQLite index) and from the live chain in the browser. **No new tables or stored copies were added**: derived metrics are computed on demand and cached in memory per newest sample, so the storage budget in [storage-plan](storage-plan.md) is unchanged.

## Sections and where they live

| Section (menu: Options) | Backend | Browser | Methodology panel |
|---|---|---|---|
| Volatility Skew (smile with call and put curves, spot/ATM lines, 25Δ and 10Δ points; skew, butterfly, slope, term) | `skew_metrics`, `iv_at_delta`, `iv_term_structure` in `app/intraday/volatility.py` | `lib/skew.ts`, `components/IvSkew.tsx` | iv_skew, iv_butterfly, iv_slope, term_slope |
| IV Momentum (CE vs PE IV change at ATM, 25Δ, 10Δ over 1, 5, 15, 30, 60 min and previous close) | `app/intraday/momentum.py`, `GET /api/intraday/iv-momentum` | `components/IvMomentum.tsx` | iv_momentum |
| IV / HV / RV, IV Rank, IV Percentile | `app/intraday/hv.py` | `lib/ivChart.ts`, `components/IvChartPages.tsx` | iv_rank, iv_percentile, hv_rv, iv_minus_hv |
| Strike Positioning (per-strike premium, OI, volume, IV, delta, class; OTM demand reading; fixed/dynamic premium baskets; asymmetry) | `app/intraday/strike_positioning.py`, `GET /api/intraday/strike-positioning` | `components/StrikePositioning.tsx` | oi_premium_class, premium_asymmetry, demand_classifier |
| Gamma analysis (universes, sign sensitivity, density, intraday dynamics, GEX-price divergence) | none (computed in the browser, as before) | `lib/gammaAnalysis.ts` (the one GEX calculation), `lib/gexIntel.ts`, `components/dashboard/GexIntelligence.tsx` | gex_core, gex_universes, gex_sign_scenarios, gamma_density, gex_dynamics, gex_divergence |
| Market Structure (regime, evidence, snapshot, volatility, positioning, gamma, data-quality warnings) | none (reads the sections above) | `lib/regime.ts`, `components/MarketStructure.tsx` | regime_classifier |
| Signal Backtest (6 tests, chronological out-of-sample) | `app/intraday/backtest.py`, `GET /api/intraday/backtest` | `components/SignalBacktest.tsx` | backtest_construction, backtest_metrics |

The registry is `frontend/src/lib/metricRegistry.ts`; each panel is generated from the entry of its metric, and worked examples are produced by the same function that computes the figure on screen. The server's `skew_metrics`, `iv_term_structure`, `momentum`, `strike_positioning` and `backtest` are pinned to hand-calculated cases in `backend/tests/unit`, and the browser formulas to the same arithmetic in `frontend/src/test`.

## Existing calculations modified

* 25Δ / 10Δ wing IVs: nearest contract within a tolerance → linear interpolation in delta between the bracketing contracts, no extrapolation (server and browser). `surface()`'s own 25Δ skew (used by the command center and the IV series) now uses the same function, which removed a second, different definition of the same number. `_surface_of` now spans ±15 strikes by default so 25Δ is reachable.
* Term slope excludes expiries with under half a day left (expiry-day IV), lists them as left out, and adds a contango / backwardation / flat label (±0.5 pt per 30 days, our threshold) and neighbour-pair slopes.
* The "previous session close" lookups used the same-day open sample when the day had one; they now take strictly earlier sessions only (found by the new service tests).

## Mathematical notes

* GEX = gamma × OI × spot² × 0.01 / 10⁷ (₹ crore per 1 % move). OI is stored in **units** (contracts × 65), so the lot size is not multiplied in again; multiplying by 65 would overstate every figure 65-fold. Sign (calls +, puts −) is a model assumption; four alternatives are tabulated.
* Skew sign: put − call (positive: puts richer). Call − put is its negation and is shown beside it.
* IV Rank uses India VIX closes over 3M / 6M / 1Y windows (1Y matches the requested definition); India VIX is a 30-day index measure and is never presented as a single expiry's ATM IV.

## Data still unavailable

* Bid/ask trade direction (never stored): every demand label is "consistent with", and INSUFFICIENT EVIDENCE is the normal outcome of small or mixed moves.
* A server-side history of GEX, flip and walls: GEX backtests (GEX vs realised volatility, flip crossings, migration) are listed as not testable. Intraday GEX uses the 21 strikes the stored strike-series holds (41 around the current ATM for the dynamic universe).
* Term-slope backtest needs several expiries sampled together across many sessions.
* Historical comparison overlays on the smile (previous session) and 10Δ/25Δ term structure beyond the per-expiry table.

## Validation and performance

* Tests added: backend `test_iv_momentum`, `test_term_structure`, `test_strike_positioning`, `test_backtest`, service smoke tests in `test_iv_hv_tools`; frontend `skew-lib`, `metric-registry`, `iv-momentum`, `iv-chart` (worked example), `strike-positioning`, `gex-intel`, `gex-universes-section`, `regime`, `market-structure`, `signal-backtest`.
* The backtest reads every stored chain of the chosen sessions (5-minute snapshots, ~100 IV solves each): expect seconds for 5 sessions and longer for 60; results are cached per newest sample. The first request on the server is the performance check to make before relying on it.
* Backtest numbers on the server will say "insufficient out-of-sample sample" until enough sessions (20+ events out-of-sample per hypothesis) are stored. That is the correct output, not an error.

## How to verify each section

Open Options → the section, expand its **Calculation Methodology & Formulas** panel, and compare the worked example with the figures above it (it is computed from the same data). Closed by default; on a phone the formulas wrap instead of scrolling sideways.

---

# Update 2 (10 Nov 2026): GEX history, smile comparison, term structure, regime divergence, premium charts, performance

## Task 1 — GEX and gamma-flip history (reconstructed, not stored)
`app/intraday/gex_history.py` rebuilds, for each 5-minute stored snapshot, the CE, PE, net, absolute GEX, gamma flip, call wall, put wall, peak gamma and near-ATM (ATM ±5) GEX for three universes: fixed opening ATM ±10 (the session's first snapshot), dynamic current ATM ±10, full chain. Same definitions as the gamma page (`gammaAnalysis.ts`): GEX = gamma × OI × spot² × 0.01 / 10⁷ (OI in units, no lot factor), calls +, puts −, net/absolute over strikes with both sides, flip = sign change of the aggregate re-priced at 33 spot levels within ±8 % then bisected. A contract with no solved IV or OI is counted missing; a snapshot that cannot be solved is skipped and listed. `GET /api/intraday/gex-history` returns the series; the Signal Backtest page charts it with the missing-data report.

Backtests (one universe throughout, chosen on the page; chronological split, fixed thresholds, thinned events, 5 bps default cost for directional ones): net GEX ÷ absolute GEX versus next-30-minute realised volatility (Pearson r, Fisher-z interval); negative versus positive gamma versus volatility; flip crossing up/down; flip migration up/down (≥ 0.1 % of spot in 15 min); GEX-price divergence amplifying/stabilising up/down. Look-ahead is excluded structurally (features read only earlier snapshots; targets only later ones in the same session) and tested by changing future values.

## Task 2 — Smile overlay
`GET /api/intraday/iv-skew?session=` returns a chosen session's last in-session chain and the sessions available for that expiry. The smile chart overlays the comparison session (dashed), and a table compares ATM IV, 25Δ/10Δ call and put IV and the skews (each interpolated on its own smile), with every strike's delta and IV from both sessions side by side. Same expiry on both sides (no cross-expiry matching).

## Task 3 — Term structure
`iv_term_structure` now returns a slope series for ATM, 25Δ call/put and 10Δ call/put IV and the two skews: slope = (far − near) / (DTE_far − DTE_near) × 30 (points per 30 days), expiries under half a day left excluded and listed, missing values left out of that series only. Charts for the five IV series and the skews, a near/far/difference/slope/shape table, and a methodology panel.

## Task 4 — Regime and GEX-price relationship
Inputs added: NIFTY % change, net GEX change and %, gamma regime, relationship (amplifying/stabilising), flip distance, near-ATM net GEX, all from the server rebuild of one universe (dynamic ATM ±10, stated on the page). Conditions added: amplifying relationship, stabilising relationship, near-ATM net GEX negative/positive. All 21 conditions carry an explicit weight (`WEIGHTS` in `lib/regime.ts`, all 1 because none is calibrated); direction gap, scores and confidence use weighted counts. The amplification regime fires when NIFTY moves ≥ 0.1 % with negative net GEX or an amplifying relationship. Labels say "potentially"; none is presented as dealer hedging.

## Task 5 — Aggregate premium charts
The existing Total premium and Premium decay widgets are untouched. New: `GET /api/intraday/premium-baskets` and a chart on Strike Positioning with CE and PE premium, NIFTY overlay, absolute / normalised (open = 100) / change / % change views, ATM ±5/10/20/full chain, fixed (opening strikes) or dynamic (recentred) baskets with the basket type stated, strikes priced, and the PE/CE asymmetry. The normalised view of a dynamic basket uses the mean premium per strike so re-centring does not look like a price change.

## Task 6 — Performance (synthetic store of the real captured chain, 376 samples a session; Windows laptop, one process)
Before (old backtest, no GEX): 76 snapshots 2.28 s, 380 → 10.7 s, 1,520 → 43.7 s (about 29 ms a snapshot, linear; 60 sessions would have been about 130 s, extrapolated, not measured).

| Sessions | Snapshots | First answer | Total (cold) | CPU s | Peak memory | Payload | Stored-sample query | Contract reads | IV solve | GEX rebuild |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 76 | 17 ms | 0.91 s | 0.56 | 83 MB | 13.8 KB | 16 ms | 66 ms | 249 ms | 243 ms |
| 5 | 380 | 27 ms | 3.7 s | 3.2 | 87 MB | 14.7 KB | 26 ms | 573 ms | 1.2 s | 1.2 s |
| 20 | 1,520 | 77 ms | 17.0 s | 15.1 | 101 MB | 18.6 KB | 76 ms | 5.0 s | 4.7 s | 4.8 s |
| 60 | 4,560 | 148 ms | 56.4 s | 50.8 | 126 MB | 28.8 KB | 146 ms | 20.3 s | 14.4 s | 14.5 s |

Memory includes about 80 MB of the benchmark's own store. Each row is a cold start; "first answer" is what the browser waits for (a result, or the progress reply). A repeat of the same request takes 14 to 155 ms. The same sessions with another cost or universe (features cached) take 20 ms to 0.77 s (it was 13.7 s before the look-back fix). Reproduce with `PYTHONPATH=. python -u scripts/bench_backtest.py 1 5 20 60` from `backend`.

Done: safeguarded-Newton IV solver (same roots as bisection, tested); GEX flip with per-contract constants (63 → 21 ms a snapshot); one pass per snapshot shared by every test; per-sample feature cache (bounded at 15,000 entries, keyed by sample id, feature version, rate and opening ATM, so it needs no invalidation because stored samples never change); result cache keyed by the newest sample; runs with more than 60 uncomputed snapshots become one background job with progress (one at a time, yielding to API threads), and polls of the same request answer from the job; sessions limited to 3 to 60, cost 0 to 100 bps; the stored-sample query is filtered by expiry and time before any calculation, with `EXPLAIN QUERY PLAN` tests showing the existing `ix_samples_lookup` and the contracts primary key are used (no index added).

Not implemented, by decision: a persistent derived-metric table. Proposal if cold starts after a server restart become a problem (60 sessions cold is about one minute in the background): table `derived_metrics(sample_id, version, ~40 REAL columns)` in its own SQLite file, about 330 bytes a row, 75 rows a session per expiry, roughly 19 k rows (6 MB) per expiry-year, about 12 MB a year for weekly and monthly. It would make a restart cost no recomputation. Not worth the extra file until measured on the server.

## Known limitations
* Benchmarks are from a laptop with one real chain repeated synthetically: relative costs are reliable, absolute server numbers are not; the 1 GB server will be slower. The first real 60-session request on the server is the check.
* The local store holds one real session, so no GEX or flip backtest has been run on real history: results will read "insufficient out-of-sample sample" until enough sessions are stored.
* GEX history is rebuilt for one expiry at a time; the term-slope backtest still needs several expiries sampled together.
* Smile comparison needs a second stored session of the same expiry; a weekly expiry may have only a few.
