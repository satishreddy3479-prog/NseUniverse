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

## Sentiment fusion (revised 10 Nov 2026: five evidence groups, see "Sentiment architecture v2" below)
The first design used six engines and reused the command-centre score inside the structure engine. That double counted price and breadth evidence; it was replaced by the architecture documented in the next section. The original text is not kept here so that the page cannot be read two ways.

## Implementation status (10 Nov 2026)
| Item | Status | Where |
|---|---|---|
| Aggregation service (in-process, per-input cache and guard, 5 s summary cache) | Built and tested | `backend/app/intelligence/service.py`, `wiring.py` |
| Sentiment fusion over five evidence groups, confidence, regime, scenarios, divergences, interpretation, capabilities (AVAILABLE / PARTIAL / UNAVAILABLE) | Built and tested on hand-calculated cases | `backend/app/intelligence/fusion.py`, `tests/unit/test_intelligence.py` |
| Rolling 5/15/30-minute CVD from stored per-minute flow | Built and tested | `backend/app/intelligence/rolling.py` |
| Walk-forward validation of stored snapshots | Built and tested on synthetic series; no real history yet | `backend/app/intelligence/validation.py`, `tests/unit/test_intelligence_validation.py` |
| Timeline (one compact row per recorded minute) and de-duplicated alerts | Built; never back-filled | `backend/app/intelligence/store.py` → `data/intelligence.sqlite3` |
| API | `GET /api/intelligence/summary?expiry=`, `GET /api/intelligence/timeline?session=`, `GET /api/intelligence/validation?sessions=` | `backend/app/api/routes.py` |
| Page `/market-intelligence`, new first menu item, new Home (command strip, start links, searchable tool list) | Built; 16 component tests | `frontend/src/pages/MarketIntelligence.tsx`, `pages/Home.tsx`, `components/intelligence/*` |
| Existing pages and tools | Untouched; every card links to them | |
| Not seen with live data, in market hours, or visually on a phone | **Not verified** | |

**Storage:** the timeline is about 0.6 KB per recorded minute (a 375-minute session is about 0.2 MB, roughly 55 MB a year). It is a new SQLite file because the fused score has no earlier history to read. Proposed retention if it matters: keep 90 sessions in full and thin older ones to every fifth minute; nothing is deleted without approval.

**Settings:** `intelligence_enabled` (default on) and `intelligence_weights` (JSON, e.g. `{"positioning": 35}`; invalid entries keep the default). Thresholds are constants in `fusion.py` and are listed in the response `config`.

**Divergence checks implemented:** price vs futures CVD, price vs futures OI, price vs GEX, price vs call/put IV momentum, futures vs options, NIFTY vs heavyweight CVD, VWAP vs CVD, volatility expansion without price, volatility contraction during a move. **Not implemented, said on the page:** OI migration vs price (no stored migration series).

**Alert kinds:** regime transition, sentiment reversal, strong bullish/bearish confirmation, gamma flip crossing, significant GEX migration, Smart OI shift, futures CVD divergence, heavyweight buying/selling, IV expansion, skew shock, VWAP breakdown/reclaim; 10-minute cooldown per kind and direction.

**Honest limits**
* CVD (futures and heavyweights) is an estimate by the quote and tick rule, labelled "Futures CVD (Proxy)" / "Heavyweight CVD (Proxy)" with a tooltip wherever it is shown; rollover data, stock futures and options aggressor data do not exist. Rolling 5/15/30-minute CVD is derived from the stored per-minute flow.
* The GEX figures are modelled exposure with an assumed sign, labelled so on every GEX figure.
* India VIX is the last daily close, labelled "India VIX – Last Daily Close" with its date, and is never an intraday signal.
* The fused weights are provisional and not statistically calibrated ("Provisional weights – not yet statistically calibrated." is shown with the score); confidence is coverage x agreement x freshness shown as three numbers, not a probability; scenario scores are heuristic and sum to 100 without being probabilities.

## Sentiment architecture v2: evidence overlap correction (10 Nov 2026)

### Audit: what overlapped
The structure engine contained the aggregate command-centre score as a term (`Term("Existing command-centre score", ...)`). That score is itself built from price, VWAP, breadth, PCR and open-interest inputs, so the same evidence entered the fusion more than once. Every overlap found:

| Input | Where it appeared | Correction |
|---|---|---|
| Aggregate command-centre score | structure engine term | **Removed.** An aggregate is never an independent engine. |
| Advance/decline, stocks above VWAP, opening-range share | structure engine and, again, inside the command-centre score | Owned by group E only, one family (three views of the same 50 stocks). |
| Future's VWAP, position in the day's range | futures engine, structure engine, command-centre score | Owned by group D only, one family. |
| PCR change and OI added (puts minus calls) | two terms of the options engine from the same OI changes | One family; the OI-added reading is scored, the PCR change is displayed but not scored. |
| Options OI and Smart OI labels | two terms from option OI changes | One family in group A. |
| Session CVD and rolling 15-minute CVD | two terms of one series (the window is a slice of the session) | One family in group B. |
| Heavyweight CVD session and rolling | two terms of the same five stocks | One family in group B; heavyweight prices live in group E and never use CVD. |
| Index price inside futures buildup, GEX spot-versus-flip, GEX walls, heavyweight points and advancing weight | each also reads price, which group D reads | Kept with an explicit weight of 0.5 each (the "overlap adjustment" shown on the term). |
| India VIX, IV rank and percentile | daily closes beside live volatility | Context only, never scored. |

The same list is returned by the API (`overlap_audit.findings`, plus every term with its family and weight) and shown on the page.

### The five groups (each input has one owner)
| Group | Evidence (families) | Default weight |
|---|---|---|
| A. Derivatives positioning | options OI added + Smart OI labels (one family, weight 1); futures price and OI buildup (0.5, shares price); GEX flip distance + wall room (0.5, shares price). Vega is PARTIAL and not scored. | 30 |
| B. Order-flow proxies | futures CVD session + rolling 15 min (one family); order-book depth imbalance; heavyweight CVD session + rolling (one family). All proxies. | 20 |
| C. Volatility | live ATM IV change against price (expiry specific); 25-delta call-versus-put IV momentum. India VIX, IV rank/percentile, IV-RV are shown as context, not scored. | 10 |
| D. Market structure | future versus its VWAP + position in the day's range (one family); position against the previous day's range. Index price only. | 20 |
| E. Participation | advance/decline + above-VWAP share + opening-range share (one family); heavyweights advancing versus declining by weight and their index points (0.5, shares price). No CVD, so independent of B. | 20 |

Weights are configurable (`intelligence_weights`, JSON over those five keys; unknown keys such as the retired `futures`/`options` are ignored). They are **provisional and not statistically calibrated**; the page says so beside the score.

### Arithmetic
    family score   = sum(term score x term weight) / sum(term weight)               over the terms available
    group score    = sum(family score x family weight) / sum(family weight)         (family weight = mean weight of its available terms)
    group fraction = available term weight / listed term weight                    (PARTIAL when below 1)
    effective weight = configured weight x fraction
    Overall   = sum(group score x effective weight) / sum(effective weight)
    coverage  = sum(effective weight) / sum(configured weight of the groups passed in)

Minimum coverage 0.55 and three groups, else `INSUFFICIENT DATA – SENTIMENT UNRELIABLE`. Classes unchanged. Unavailable terms are left out, never scored neutral.

### Five separate quantities (confidence is not |score|)
* **Directional score**: the arithmetic above.
* **Data coverage**: effective weight / configured weight, with the count of AVAILABLE / PARTIAL / UNAVAILABLE groups.
* **Evidence agreement** = 1 - 2 x min(bullish weight share, bearish weight share), where a group is bullish/bearish at +-15. Neutral groups oppose nobody. It looks at the groups, not at the size of the score: five groups all at +20 and all at +95 have the same agreement; a +40 score made of 70 % bullish against 30 % bearish weight has 0.4.
* **Data freshness**: share of effective weight whose inputs are fresh (live inputs 120 s, stored-chain inputs 420 s).
* **Confidence** = 100 x min(1, coverage / 0.8) x agreement x freshness, **capped at 40 when 25 % or more of the weight opposes the rest**. A strong score from conflicting groups can therefore never read as high confidence. Confidence describes the reliability of the reading, not the probability of the direction.

The old agreement rule returned 1.0 for every group whenever the overall score sat near zero, so a perfectly split set of groups looked unanimous; the new rule fixes that and is tested.

### GEX methodology (documented as modelled exposure)
`GEX_METHOD` in `fusion.py` is returned with the panel and shown on the page. In short: gamma (Black-76 on the stored option price, forward from put-call parity) x open interest in **units** (the chain already reports units, so no lot-size multiplier is applied) x spot^2 x 0.01 / 10^7 = Rs crore per 1 % move; **calls count +, puts count -** (an assumption that dealers are long the calls and short the puts that customers hold; the feed does not say who holds what); net/absolute use strikes that have both sides, CE and PE totals use every strike with exposure on that side; ATM +-10 strikes of **one** expiry, never aggregated across expiries; gamma flip = sign change of the aggregate re-priced at 33 spot levels within +-8 %, located by bisection, none reported when there is no sign change. Server and browser agree to about 1e-6 on one real chain (`test_gex_parity.py`, `gex-parity.test.ts`).

### CVD proxy documentation
Kotak provides no aggressor-side trade tape. Each trade is classified by the quote rule (against the prevailing best bid/ask) and, when the quote is inconclusive, the tick rule (`market/flow.py`). CVD = classified buy volume - classified sell volume. This is an estimate: buyer- and seller-initiated volume are never observed. Every CVD figure is labelled "Futures CVD (Proxy)" or "Heavyweight CVD (Proxy)" with a tooltip saying so. CVD is normalised per stock (tanh of the percentage of classified volume) before the weighted average, so raw volumes of different stocks are never added. Rolling windows are differences of the stored per-minute cumulative figures; a window is unavailable (with its reason) when a stored end is missing, the recording has a gap, or the backend restarted inside it.

### India VIX freshness
The VIX value is the last entry of the daily `iv` series of `/intraday/iv-chart`: a **daily close**. It is displayed as "India VIX – Last Daily Close" with its observation date (`as_of`), `intraday_signal: false`, and is not an input to any engine. The intraday volatility group uses live ATM IV change and the expiry-specific 25-delta momentum. IV rank and percentile are computed from those daily closes and shown as context only.

### Walk-forward validation framework (`app/intelligence/validation.py`, `GET /api/intelligence/validation`)
Chronological test of the stored `timeline` snapshots against what NIFTY did next: 15, 30 and 60 minutes later, at the end of that session, and at the close of the next recorded session. No look-ahead (outcomes are read only from later rows; features are the stored row), expanding walk-forward folds (each fold scored on one session using only earlier sessions; an optional `fit` callable sees only earlier sessions), rows of a different group layout are excluded (`metrics.arch`), a missing outcome is left unlabelled rather than interpolated, a missing group is left out and the rest renormalised (`rescore`, which also lets alternative weights be tested on stored history), flat outcomes (< 0.02 %) and neutral calls (|score| < 15) are counted separately, a hit rate is reported only from 30 decided calls and always with a Wilson 95 % interval, with the correlation of score and forward return and the mean forward return by score bucket and hit rate by confidence band. **Not run on real history yet**: the timeline began recording with this release, so there are no stored sessions to validate; the tests use synthetic series with hand-calculated expectations. It is not a claim of predictive accuracy.

