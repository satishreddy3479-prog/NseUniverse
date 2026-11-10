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
