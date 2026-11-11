# Straddle Decay Intelligence: audit, reuse plan, methodology

Status: built 11 Nov 2026 (D116 straddle engine, D117 buyer/seller environments). Separate from the fused sentiment score; nothing here changes a weight, group or default.

## Phase 1: audit of existing engines (what is reused, where it lives)

| Need | Existing source (reused in-process, never over HTTP) | Refresh | History |
|---|---|---|---|
| Option chain, strike prices, OI | `ObservationStore` (`storage/observations.py`): samples + contracts, written by the sampler every 60 s in market hours | 60 s | SQLite + gzip, whole days kept (old days' contract rows may be archived: see storage-plan) |
| Pricing, IV, Greeks, forward, delta-interpolated IV | `intraday/volatility.py` (Black-76, parity forward, `surface`, `iv_at_delta`) | on call | none (pure) |
| Skew, risk reversal, butterfly, IV term structure | `intraday.iv_skew(expiry)` via the MI input `skew` (`summary().panels.volatility`) | 30 s | in-memory session |
| ATM IV momentum | `intraday.iv_momentum` (MI input `momentum`) | 30 s | in-memory |
| OI, change in OI, PCR, max OI strikes, additions/unwinding, Smart OI "demand" | `intraday.strike_positioning` (MI input `positioning`) -> `summary().panels.options` | 30 s | stored snapshots |
| GEX, flip, walls, relationship to spot, history | `intraday.gex_history` (MI input `gex`) -> `fusion.gex_state` | 30 s | per-day series |
| Vega analysis | OI-weighted vega is browser-computed on the Vega page; `panels.vega` carries averages only | n/a | none |
| Futures OI, CVD (quote/tick-rule proxy), VWAP | `market.summary`, `futures_series`, `rolling.futures` (MI inputs `market`, `futures`, `flow`) -> `summary().pulse/panels.futures` | 5-15 s | market_store `fut`, `heavy5` per-minute samples |
| Heavyweight CVD | `heavyweights.assess` -> `summary().heavyweights` | 15 s / 5 min meta | market_store `heavy5` |
| Group engines and fused sentiment | `fusion.build_engines` -> `summary().engines`, `.sentiment` (untouched) | 5 s cache | `intelligence.sqlite3` timeline |

Reuse decisions: option prices/IV/Greeks come from the same Black-76 functions the Intraday page uses; everything flow, positioning, GEX and term-structure is read from `MarketIntelligence.summary()` (already cached 5 s), so no new feed, subscription or pricing engine exists. `StraddleDecay` reads those results; it never writes to MI.

Not available (reported as UNAVAILABLE, never zero): spot VWAP (index has no volume), bid/ask (last traded prices only), true aggressor-side trade tape, observed dealer positioning, actual option historical bid/ask for cost modelling, OI-weighted vega series server-side.

## Architecture

- `intelligence/straddle.py`: pure analytics for one session of one expiry (tracker, IV/skew, Shapley attribution incl. vanna and volga, efficiency, realised vs implied, structure, regimes).
- `intelligence/straddle_env.py`: pure buyer and seller environment engines (components, weights, conflicts, invalidation).
- `intelligence/straddle_store.py`: SQLite `straddle.sqlite3`, one compact row per recorded minute (inputs, scores, regime, a +-2 strike premium ladder), and persisted alerts.
- `intelligence/straddle_service.py`: reads stored samples and the MI summary, caches 20 s, records once a minute in market hours, raises alerts, runs validation.
- Endpoints: `GET /api/intelligence/straddle`, `/straddle/alerts`, `/straddle/validation`, `/straddle/history`.
- Frontend: page `/straddle` (lazy) with the twelve sections in the requested order; a compact card on the Market Intelligence page links to it.

## Methodology and limits

See the module docstrings; every proxy and assumption is also printed on the page. In short: prices are last traded; IV and Greeks are Black-76 model values (assumed rate); attribution is Shapley over time, forward and vol with vanna/volga carved out of the cross term; scores are provisional weighted evidence (not trained, not validated); GEX is modelled exposure; validation uses only minutes recorded from the day recording began and says Insufficient until there are enough sessions.

## Formulas (implemented in `straddle.py`, `straddle_env.py`, `straddle_validation.py`)
- Black-76 price, implied vol, Greeks, forward: `intraday/volatility.py` (reused). T = calendar time to the expiry session close in years of 365 days; theta per calendar day; vega per 1 vol point; lot size 65.
- Step attribution (one leg, samples a -> b): theta, forward and vol effects are the Shapley values of the Black-76 price over the three factors (6 orderings). delta = delta(a) x dF. vanna = (dPrice/dF dVol)(a) x dF x dVol; volga = 0.5 x (d2Price/dVol2)(a) x dVol2. vega = Shapley_vol - volga - vanna/2; gamma = Shapley_forward - delta - vanna/2. residual = market change - (theta + vega + delta + gamma + vanna + volga). skew part of vega = vega_raw(a) x (own dVol - mean dVol of CE and PE).
- Decay efficiency = actual decay / theta decay x 100 (theta decay = -sum of theta terms); classes efficient >= 75, slower 20-75, none -10 to 20, expansion < -10 (working thresholds).
- Realised vol = sqrt(sum r^2 / sum dt x 375 x 252) over log returns of stored spot, gaps over 10 minutes skipped, window at least 80% covered; implied vol is quoted (calendar basis); gap = IV - RV in vol points.
- Break-even daily move = sqrt(2 |theta_day| / gamma) for the ATM straddle.
- Score = 50 + 50 x sum(w v) / sum(w) over available components; coverage = available weight / total weight; no score under 50% coverage.
- Validation result (seller) = entry premium - later premium - 4 x half-spread; (buyer) = later - entry - costs; picks do not overlap.

## Endpoints
Reused (in-process): `MarketIntelligence.summary()`, `intraday.gex_history`, `ObservationStore.samples/contracts/day_counts`. New: `GET /api/intelligence/straddle?expiry=&session=`, `/straddle/alerts?session=`, `/straddle/validation?sessions=`. New database: `data/straddle.sqlite3` (tables `obs`, `alerts`).

## Server resource impact
One analysis per minute (cached 20 s for the page): reads up to 240 stored samples of the day and solves implied vols for the strikes needed; `compute_ms` is returned with every response and printed on the page. Storage about 0.45 MB a day (about 110 MB a year); the recorder pauses nothing else. Measured values are in the delivery report.
