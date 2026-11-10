# NIFTY 50 Market Intelligence: integration audit and design (10 Nov 2026)

Phase 1 to 5 of the master brief. Everything below was read from the code in this repository, not assumed. "Status" is Available (exists and is served), Partial (exists with a stated gap) or Unavailable (not stored or not computed today).

## Architecture found
* **Backend:** FastAPI (`backend/app/api/routes.py`, one `/api` router, plus `/ws/market-data` in `api/ws.py`), Python 3.12, services held on `app.state`: `market` (breadth, futures flow, VWAP, participation), `intraday` (option-chain analytics), `stream` (Kotak feed), `swing_*`, `storage`. Control endpoints are guarded by `require_local_control`; analytics GETs are open to the app's own clients.
* **Storage:** SQLite files in `data/` (`observations.sqlite3` = option-chain samples and per-contract rows; `market_history.sqlite3` = daily bars, minute samples of futures and breadth; `intraday.sqlite3` = stored sentiment scores; gz snapshots under `data/snapshots`). No Redis, no Postgres. In-memory caches inside the services.
* **Frontend:** React + TypeScript + Vite, TanStack Query polling (5 to 30 s), one WebSocket for live ticks (`liveSocket.ts`), ECharts via `components/EChart.tsx`, tool registry `lib/tools.ts` (Home, menus and `/tools/:id` pages), routes in `App.tsx`. Gamma and Vega are computed **in the browser** from the chain (`lib/gammaAnalysis.ts`, `lib/vegaAnalysis.ts`).

## Integration map
| Module | Page / route | Endpoint (actual) | Fields used | Refresh | Calculation | Source | Status |
|---|---|---|---|---|---|---|---|
| Intraday command centre (existing rules-based sentiment) | Intraday tool | `GET /api/intraday/summary?expiry=` | `assessment` (score ±1, label, coverage, components with weights), `regime`, `scenarios` (probability null), `narrative`, `price`, `options` (`pcr_oi`, `ce_oi_chg`, `pe_oi_chg`, `max_ce_oi_strike`, `max_pe_oi_strike`, `straddle`), `levels`, `structure`, `vwap`, `volatility`, `positioning`, `stocks`, `institutional`, `health` | page poll 30 s | `intraday/sentiment.py` weights price .35, breadth .15, sectors .10, options .20, global .10, institutional .10, coverage-gated | stored option-chain samples + market service | Available |
| Option chain, CE/PE OI, OI change | Option Chain, OI tools | `GET /api/option-chain`, `/oi/change`, `/oi/heatmap`, `/history/oi-series`, `/history/strike-series` | OI units, OI change = OI minus previous-day OI (local), LTP, volume | 15 s | `analytics/oi.py` | `observations.sqlite3` | Available |
| PCR, near-ATM OI, max OI strikes | Command centre | `/intraday/summary` → `options` | see above (ATM ±10 strikes) | 30 s | `intraday/features.py` | same | Available |
| Smart OI / buildup per strike | Smart OI tool (browser) and Strike Positioning | `/intraday/strike-positioning?expiry=&window=` | per strike premium %, OI %, IV change, volume, delta, class; OTM demand labels with evidence | 30 s | `intraday/strike_positioning.py` (premium × OI rule, labels are "potential") | stored chains | Available |
| Call/put writing, unwinding, short covering | Strike Positioning | same | `demand[].label`, `summary` | 30 s | rule-based, evidence counts, INSUFFICIENT EVIDENCE below the bar | same | Available (OI never identifies buyer or seller) |
| Aggressive buying with trade-side evidence | none | none | bid/ask aggressor not stored for options | | | | **Unavailable** |
| Option Greeks, strike IV | Option Chain, Vega, Gamma | browser `lib/optionTools.ts`; server `volatility.surface` rows | iv, delta, gamma, vega_pt per strike | with chain | Black-76, forward from put-call parity | stored chain | Available |
| Expiry-wise IV, term structure | Volatility Skew | `/intraday/iv-skew?expiry=&session=` | `term`, `term_structure.series` (ATM, 25Δ/10Δ call/put, skews) | 30 s | `volatility.iv_term_structure` | stored chains | Available |
| IV skew, risk reversal, butterfly | Volatility Skew, IV Momentum | `/intraday/iv-skew`, `/intraday/iv-momentum` | `cards.skew_25d/10d`, `call_minus_put_*` (= risk reversal), `butterfly_*`, CE/PE IV change 1 to 60 min | 30 s | interpolated in delta | stored chains | Available |
| ATM IV, IV change | IV Intraday | `/intraday/iv-series`, `/intraday/iv-momentum` | `atm_iv`, momentum table | 30 s | Black-76 | stored chains | Available |
| HV, RV, IV rank/percentile, India VIX | IV and HV tools | `/intraday/iv-chart?hv=`, `/intraday/hv` | daily `iv` (India VIX close), `hv`, `rv`; rank/percentile computed in `lib/ivChart.ts` | 5 min | `intraday/hv.py` | `market_history.sqlite3` | Available. **VIX is a daily close, not live: Partial for "live VIX".** |
| Expected move | Command centre | `/intraday/summary` → `volatility` | `expected_move_iv_1sd_pts`, straddle | 30 s | forward × IV × √t | chain | Available |
| GEX (CE, PE, net, flip, walls, peak, near-ATM) | Gamma Exposure board (browser) | `GET /api/intraday/gex-history?expiry=&universe=` (server rebuild); browser `lib/gammaAnalysis.ts` for the live chain | per snapshot ce, pe, net, abs, flip, call_wall, put_wall, peak, near_net | 120 s cache | `intraday/gex_history.py` = same formula as the browser | stored chains | Available (one expiry per request; calls +, puts − is a model assumption) |
| GEX migration, velocity, divergence | Gamma page | browser `lib/gexIntel.ts`; derivable from `gex-history` points | change, acceleration, divergence kind | | `gexDynamics`, `gexPriceDivergence` | | Partial on the server (series is served; the master computes change from it) |
| Vega (CE, PE, net, change, concentration) | Vega Analysis (browser) | none server-side | average vega per strike window and anchored band change in the browser | | `lib/vegaAnalysis.ts` | stored chain | **Partial: no server endpoint; the master reads `vega_pt` from the surface rows (Σ vega × OI), a documented different measure** |
| Futures price, basis, OI, OI change, volume | Future Dashboard / Price vs OI | `GET /api/futures/series?day=` | `future`, `spot`, `basis`, `basis_pct`, `carry_pct`, `vs_fair`, `oi`, `oi_change`, `oi_per_min`, `volume`, `latest` | 30 s | `market/futures_series.py` | minute `fut` samples in `market_history.sqlite3` | Available |
| Futures buildup (long/short buildup, covering, unwinding) | Future Price vs OI (browser) | none | rule `buildup()` in `lib/analytics.ts` | | price × OI sign | | Partial: browser only; the master applies the same four-way rule to the two series |
| Futures CVD, buy/sell volume, depth imbalance | Future Flow | `GET /api/market/summary` → `flow.futures` | `buy_volume`, `sell_volume`, `cvd`, `cvd_pct`, `classified_share`, `coverage_of_day_volume`, `depth_imbalance`, `divergence`, `relative_volume`, `stale` | tick-driven, 15 s poll | `market/flow.py`: **estimated** by the quote rule then the tick rule (no aggressor tape from Kotak) | live feed, in memory | Available as an **estimate (proxy)** |
| Rolling 5/15/30-minute CVD, CVD momentum | none | none | the tracker keeps session totals only | | | | **Unavailable** (the master shows session CVD and says so) |
| VWAP, deviation, slope | Command centre / Future Flow | `/intraday/summary` → `vwap`; `market/summary` | `vwap`, `distance_pts/pct/atr`, `side`, `slope_pts_per_15m`, `crosses`, `events` | 30 s | `market/vwap.py` (future's ATP, not the index) | feed | Available |
| Rollover data | none | none | | | | | **Unavailable** |
| NIFTY 50 weights, contribution | Market Movers, Future Flow | `/market/summary` → `nifty50.stocks`, `contribution`, `weights` | weight, change %, contribution points, relative volume | 15 s | `market/metrics.py`; weights official or estimated (`approximate` flag) | seed + estimation | Available |
| Heavyweight (top 5 by weight) stock flow | Future Flow & Heavyweights | `/market/summary` → `flow.heavy5.stocks[]` | `weight`, `change_pct`, `relative_volume`, `flow.cvd`, `flow.cvd_pct`, `flow.divergence`, `technical` | 15 s | `market/flow.py` per stock; heavy5 chosen by current weights (`MarketService.heavy`) | feed | Available (estimated CVD) |
| Stock futures, stock futures OI | none | none | only the NIFTY future is subscribed | | | | **Unavailable** |
| Stock VWAP / above VWAP, opening range, breadth, divergence | Command centre, Future Flow | `/market/summary` → `participation`, `nifty50.breadth` | counts above VWAP, OR status, advance/decline balance, momentum, divergence | 15 s | `market/participation.py`, `metrics.py` | feed | Available |
| Aggregate heavyweight CVD, heavyweight participation | none | none | not computed anywhere | | | | **Unavailable today: the master computes it (weight-scaled `cvd_pct`, see below)** |
| Alerts | none master-level | none | | | | | Unavailable: created here |
| Stored sentiment history | Intraday score history | `/intraday/scores` | session scores recorded each minute (existing rules-based score only) | | `intraday/store.py` | `intraday.sqlite3` | Available for the existing score only; **no history of the new fused score exists** |
| Session, calendar | all | `/market/session`, `/expiries` | open/close, holidays, weekly and monthly expiry | | | | Available |
| Live ticks | all live pages | `WS /ws/market-data` | normalized ticks | push | `stream/` | Kotak feed | Available |

## Missing integration points (and what the master does about each)
1. **No server-side GEX/Vega summary for the live minute**: use `gex_history` (stored chains, same formula as the browser); Vega partial as above.
2. **No heavyweight aggregate flow**: computed in the master from `flow.heavy5` (normalised, below).
3. **No rolling CVD, no rollover, no stock futures, no options aggressor data**: shown Unavailable; no proxy is dressed up as the measurement. Estimated CVD is labelled a proxy everywhere.
4. **No history of the fused score**: a compact timeline table is added (documented below) and starts empty; earlier minutes are never reconstructed or invented.
5. **Many endpoints per page**: the browser makes one call to the master endpoint, which reads the services in-process and caches 5 seconds.

## Proposed layout (route `/market-intelligence`, new first item in the menu and the home page)
1. **Command strip**: direction label, score −100 to +100, confidence 0 to 100, coverage, regime, volatility regime, data freshness, last update.
2. **Pulse cards**: spot, change, futures, basis, ATM, expiry, ATM CE/PE, ATM IV, VIX (daily close, labelled), PCR, net GEX, flip, futures OI change, CVD (estimate), VWAP, heavyweight CVD.
3. **Engine matrix**: six fusion engines plus the existing command-centre score, each with score, class, freshness, evidence for and against, link to its detailed page.
4. **Interpretation**, **Divergences**, **Scenarios**, **Timeline** (inspect any recorded minute), **Alerts**, and expandable **Options / Gamma and Vega / Volatility / Futures / Heavyweight** panels.
Existing pages and tools remain untouched and linked.

## Sentiment fusion (documented before coding)
Each engine returns a score in [−100, +100] or `None`; unavailable engines are left out of the sum and coverage is reported.
`Overall = Σ(score_e × weight_e) / Σ(weight_e over engines with a score)`; `coverage = Σ(weight over available) / Σ(all weights)`. Default weights (configurable in settings, validated to sum to anything positive): futures flow 25, options 20, GEX 15, heavyweight 15, volatility 10, structure and breadth 15. Minimum coverage 0.55 and at least three engines, else `INSUFFICIENT DATA – SENTIMENT UNRELIABLE`. Classes: ≥70 strong bullish, 35–69 bullish, 15–34 mild bullish, −14..14 neutral, mirrored for bearish.
Engine rules (each uses only existing outputs, every term listed in the response as evidence):
* **Futures flow**: price-vs-OI buildup sign, CVD % (estimate, tanh scaled at ±25 %), VWAP side and distance in ATR, depth imbalance; sub-terms averaged over those available.
* **Options**: `pcr_oi` change, (PE OI change − CE OI change) / total OI, strike-positioning demand labels (upside speculation and put writing bullish; downside speculation and call writing bearish; INSUFFICIENT EVIDENCE contributes nothing).
* **GEX**: spot relative to the dynamic-universe gamma flip (above bullish, below bearish, scaled by distance, 1 % = full) and call-wall versus put-wall room. A model assumption, not observed dealer positioning; it also sets the gamma regime shown beside the score.
* **Heavyweight**: Σ(weight × clipped CVD %) / Σ(weight) over the top five that have flow, plus their index-point contribution sign; raw CVDs are never summed across stocks.
* **Volatility**: ATM IV change against spot change (IV up with spot down bearish; IV down with spot up bullish), 25Δ skew change (puts richer bearish). Not from IV rank or percentile alone.
* **Structure and breadth**: advance/decline balance, share above VWAP, opening-range status, position in the day's range, and the existing command-centre price score.
**Confidence (separate)** = completeness × agreement × freshness, each shown: agreement = weighted share of engines whose sign matches the overall; freshness = share of weight whose input is fresh; completeness = coverage. Reported with its parts; no probability is shown. Scenarios are heuristic scores (labelled), never probabilities, because no calibrated model exists here.


## Implementation status (10 Nov 2026)
| Item | Status | Where |
|---|---|---|
| Aggregation service (in-process, per-input cache and guard, 5 s summary cache) | Built and tested | `backend/app/intelligence/service.py`, `wiring.py` |
| Sentiment fusion, engines, confidence, regime, scenarios, divergences, interpretation | Built and tested on hand-calculated cases | `backend/app/intelligence/fusion.py`, `tests/unit/test_intelligence.py` (25 tests) |
| Timeline (one compact row per recorded minute) and de-duplicated alerts | Built; never back-filled | `backend/app/intelligence/store.py` → `data/intelligence.sqlite3` |
| API | `GET /api/intelligence/summary?expiry=`, `GET /api/intelligence/timeline?session=` | `backend/app/api/routes.py` |
| Page `/market-intelligence`, new first menu item, new Home (command strip, start links, searchable tool list) | Built; 16 component tests | `frontend/src/pages/MarketIntelligence.tsx`, `pages/Home.tsx`, `components/intelligence/*` |
| Existing pages and tools | Untouched; every card links to them | |
| Not seen with live data, in market hours, or visually on a phone | **Not verified** | |

**Storage:** the timeline is about 0.6 KB per recorded minute (a 375-minute session is about 0.2 MB, roughly 55 MB a year). It is a new SQLite file because the fused score has no earlier history to read. Proposed retention if it matters: keep 90 sessions in full and thin older ones to every fifth minute; nothing is deleted without approval.

**Settings:** `intelligence_enabled` (default on) and `intelligence_weights` (JSON, e.g. `{"futures": 30}`; invalid entries keep the default). Thresholds are constants in `fusion.py` and are listed in the response `config`.

**Divergence checks implemented:** price vs futures CVD, price vs futures OI, price vs GEX, price vs call/put IV momentum, futures vs options, NIFTY vs heavyweight CVD, VWAP vs CVD, volatility expansion without price, volatility contraction during a move. **Not implemented, said on the page:** OI migration vs price (no stored migration series), rolling-CVD divergence (no rolling CVD).

**Alert kinds:** regime transition, sentiment reversal, strong bullish/bearish confirmation, gamma flip crossing, significant GEX migration, Smart OI shift, futures CVD divergence, heavyweight buying/selling, IV expansion, skew shock, VWAP breakdown/reclaim; 10-minute cooldown per kind and direction.

**Honest limits**
* CVD (futures and heavyweights) is an estimate by the quote and tick rule, labelled "proxy" wherever it is shown; rolling 5/15/30-minute CVD, rollover data, stock futures and options aggressor data do not exist.
* The GEX engine is a model with an assumed sign; the dashboard says so on every GEX figure.
* India VIX is a daily close.
* The fused weights are provisional; confidence is completeness × agreement × freshness shown as three numbers, not a probability; scenario scores are heuristic and sum to 100 without being probabilities.
* The existing command-centre score (price, breadth, sectors, options, global, institutional) is reused inside the structure engine, so price and breadth evidence appears in both; the page states it.
