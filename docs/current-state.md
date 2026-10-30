# Current state
_Last updated: 2026-10-29_

- **Objective:** NSE Universe — Indian market research platform; see [roadmap](roadmap.md).
- **Phase:** Phase 1 (Kotak Neo + NIFTY option chain + dashboard). **Milestone:** Checkpoint 1 built; awaiting the user's Windows setup and live check.
- **Stage:** local-only; no Git repo, no GitHub, no deploy (decision #13).

## StockMojo comparison, 29 Oct 2026 (read-only check of the server's stored samples)
- Our widgets match our own API to the unit (±10 strikes around ATM 22,950: call OI 6.610 Cr, put OI 6.838 Cr, change +33.11 L / +3.95 Cr). StockMojo showed 6.58 / 6.79 Cr and +29.71 L / +3.9 Cr.
- The gap is in the *current* OI, not the baseline: our OI minus StockMojo's is about 3 L (calls) and 5 L (puts), and the change gap is the same size, so both tools use the same previous-day baseline.
- The same ±10 strikes held 6.466 / 6.820 Cr in the last in-session sample (15:29 IST) and 6.610 / 6.838 Cr in every sample stored after the close (first at 20:21 IST). OI is revised after the close, so any tool is only comparable at the same timestamp. StockMojo's figures sit between those two moments and its capture time is unknown.
- Our totals cover ATM ±10 only (the widget says so). The whole chain is 12.95 Cr calls / 16.96 Cr puts, so a tool that sums all strikes shows different totals.
- Open items: no stored sample at 15:30 itself (sampler's last in-session sample was 15:29); post-close fetches show deep-OTM contracts with OI 0 and LTP 0.0, which is not a real quote.
- New (29 Oct): the PCR widget (ATM strike, strikes in view, whole chain; shown once to saved layouts), dark change segments in the OI explorer, and a Full-view table of every time slot.

## Strategy builder (30 Oct 2026) and the 09:15-15:40 session
- New page `/strategy` (reference: Opstra's public behaviour; see `docs/opstra_public_feature_audit.md`, `nse_universe_integration_plan.md`, `strategy_builder_specification.md`, `options_payoff_engine.md`, `testing_and_validation.md`). Scope cut on 30 Oct to **building a strategy and its payoff graph**: the app's own stored NIFTY option chain sits inside the builder (B/S buttons add legs at the stored quote), 16 editable templates, leg table, exact expiry payoff with max profit/loss/breakevens, save/load in the browser. Greeks, what-if, costs, the backtester (and its two API routes) and multi-expiry templates were built and then removed at the owner's request (git `0bf3ecf`). NIFTY only.
- Session: one constant (`backend/app/domain/session.py`, `frontend/src/lib/session.ts`) now 09:15-15:40 IST because NSE derivatives have closed at 15:40 since 3 Aug 2026 (CAS alignment). Sampler, intraday features/labels, expiry time in the IV maths, EOD job (15:50), ledger close, index-bar completion (16:10) and the charts all read it. If NSE reverts, change both constants. Not yet confirmed that the rule is being removed.

## Daily forward-test log (30 Oct 2026)
- New append-only `prediction_daylog.sqlite3`: after 09:10 IST every session day writes one row per horizon: recorded or not recorded, the reason (late series, report not computed), the number the page showed. A missed day keeps its number only as a preview; it is shown next to what actually happened ("Right/Wrong · not counted") and never enters the ledger or the scoreboard. Shown on the Prediction page ("Daily forward-test log"). The first row will be written for 30 Oct; 29 Oct is not back-filled (no record of what was shown).
- Already in place: append-only ledger with content hashes, outcomes attached after the target closes, scoreboard vs base rate, post-mortem with the inputs that pushed each forecast, retraining when new final bars arrive, Compute now per model.

## Prediction freshness check, 30 Oct 2026 00:58 IST (read-only, server)
- 29 Oct: the models were trained at 08:35 IST (report computed 03:05 UTC) but **no forecast was recorded** (forward ledger: 0 forecasts, 0 outcomes) because the overnight series were not final: SPX, VIX, BRENT, DXY, USDINR, UST10Y bars for 28 Oct had been stored mid-session at 23:16 IST on 28 Oct by the first deployed build, and the 07:33 IST refresh logged them as disagreements instead of replacing them (the current code replaces such partial bars: `bar_corrections`, tested). 14 bars are listed as held back.
- Expected self-heal: the 07:30 IST refresh on 30 Oct (current build) corrects them; the history service then retries every 10 min until 09:10 while overnight bars are missing. New: the model run in the 08:35-09:10 window now waits until the overnight data is final (`morning_ready`, checked every 4 min) instead of running once at 08:35 and giving the day up.
- News (GDELT, display only, not used by the models) fetches automatically (last fetch 29 Oct 19:27 UTC); one theme (US Fed timeline volume) returned HTTP 429.
- Verify on 30 Oct after 09:10 IST: `/api/prediction/summary` should show `fresh: true`, forecasts `recorded: true`, ledger counts above 0, and `partial_bars_held_back` empty.

## NSE flows: missing 29 Oct participant data, schedule, Update now (30 Oct 2026)
- Root causes (read from the server's `/api/prediction/flows/status`): (1) the fetcher asked NSE only for sessions that already had a NIFTY daily bar, and that bar appears after the close is final, so 29 Oct's files were never requested; (2) participant **volume** files were all rejected (NSE writes "Trading Volume", the parser required "Trading Volumes"), so none were ever stored; (3) one attempt per evening, so a file published after the attempt waited a day.
- Fix: candidate sessions = bar sessions plus recent weekdays up to the expected session (holiday calendar when it covers the year); expected session = today after 18:30 IST, else the previous session. Automatic checks: one at start, then every 30 min from 18:30 IST only while an expected file is missing; they stop once it is stored (also after a manual update) and cool down 3 h after an NSE block. Stored values are never overwritten (append-only by policy), so a manual and an automatic run cannot disagree.
- "Update now" (manual run, also fetches cash and NSDL regardless of the hour) on the F&O participant panel, the FII/DII cash panel and Settings; each source shows newest stored session, last successful automatic check and last manual update (`runs` table in the flows store; failures are shown as failed, never as success).
- Prediction: "Compute now" on each model card (T+1 / T+5 retrain only that horizon, allowed in market hours) with last automatic / last manual run (`prediction_runs.json`). Not yet seen with live NSE files: after the next deploy, check `/api/prediction/flows/status` for `fao_participant_vol` rows and the 29 Oct files.

## Total premium and spot fixes (30 Oct 2026)
- Total premium, total OI and volume in `/api/history/observations` summed ATM ±N re-centred on each snapshot, so the lines mixed different strikes as NIFTY moved. They now sum the ATM ±N strikes of the newest snapshot at every point (`observe(..., fixed)`); the ATM straddle still follows each snapshot's own ATM, which is its definition. Test: `TestFixedUniverse`.
- Spot mismatch (29 Oct screenshot): the Analysis page's option-chain query never refetched, so "Spot (snapshot)" showed the snapshot loaded earlier (22,822) while the header and the Command Center showed newer ones (22,869). The chain now refetches every 30 s and the label says which snapshot time it shows. The live stream tick, the last 60-second sample and the page's snapshot can still differ by seconds; each now carries its own time.

## PCR / OI trend widgets (30 Oct 2026)
- New widgets (offered once to saved layouts): "Put-call ratio over time", "OI change over time (call vs put)", "Total OI over time (call vs put)" (NIFTY dotted on the left axis, metric on the right; strike picker defaults to all listed strikes) and "PCR donut: overall and ATM" (outer ring whole chain, inner ring ATM strike), plus the earlier PCR table. Backed by `/api/history/oi-series`: the same strikes at every point, OI change = OI minus the broker's previous-day OI (strikes lacking either are left out and counted). Not yet checked against live data.

## Premium decay fixed (30 Oct 2026)
- The old decay line summed prices over "ATM ±10" re-centred at every sample, so strikes entered and left the sum as NIFTY moved (calls fell while NIFTY rose). `/api/history/premium-decay` now sums the price change of the SAME strikes (ATM ±N of the newest sample) against the first sample in range; a price that is missing or not above zero drops that strike from the point and is counted. Hand-calculated tests in `test_observations.py`. The Total premium widget still shows the sliding-universe total and says so.

## OI explorer, StockMojo-style single screen (30 Oct 2026)
- Time slots count back from the last stored sample of the session (after the close, including past midnight IST: the last sample taken 09:15-15:30 IST) and pass `until` to `/api/oi/change`, so after hours "Last 30 min" shows the final half hour of trading. Full view shows Open Interest Change, Total Open Interest and PCR cards for the chosen slot, next to the strike chart; the table was removed. OI-decrease segments no longer have a border. StockMojo's page (29 Oct 15:40:59 data) shows PCR 1.03, the same as ours. Not yet checked in a live session.

## OI explorer (29 Oct 2026)
- The default Analysis widget "Open interest by strike" now carries the explorer (no separate widget to add): modes OI change + total / OI change / Total OI; windows Last 3/5/10/15/30 min, 1/2/3 hr, All; call/put OI, change and PCR for the window; ⤢ Full. Windows compare the newest stored sample with the one that long ago (`/api/oi/change`, baseline `at`), so they need stored samples (about one a minute in market hours). Not yet checked in a live session. The "Sampled live / Sampling delayed / Stored" chip is removed; time-series widgets show only "last sample HH:MM IST".

## Intraday engine audit (29 Oct 2026)
- Strict audit done (docs/audit-2026-10-29.md): 15 defects fixed with regression tests, backend 508 / frontend 185 tests, ruff and mypy clean. Still never run on live Kotak data: check `/api/market/coverage`, `/api/market/status` and the Command Center in the first market session. No probabilities are shown until 60 labelled sessions pass the gate.

## Market breadth (built 2026-10-29, unverified live)
- Official NIFTY 50 weights loaded (D59): NSE index tracker, 29 Oct close, rolled forward with price; top-5 are now HDFCBANK, ICICIBANK, RELIANCE, BHARTIARTL, LT. Compare with the page's advance/decline (39/11 on 29 Oct) after the next session.
- Added 29 Oct evening (D58): NIFTY futures flow/CVD, depth for the top-5 heavyweights, technical read from daily bars, estimated weights, own intraday volume profile (after 5 sessions), list-change log, snapshot retention enabled (raw 7 d, normalized 14 d, verified-archive days only). Offline-tested; Kotak depth fields and the F&O scrip master are unverified.
- `/api/market/summary|status|coverage`, `POST /api/market/refresh`, `POST /api/market/weights/import`. NIFTY 50/500 breadth, heavyweight contribution, relative volume, sectors in the Command Center. Offline-tested only; needs a market-hours check of token coverage and tick fields. Weights not loaded. See D57.

## Implemented (Checkpoint 1)
- Backend (FastAPI, `backend/`): settings validation, redacted JSON logging, Kotak adapter (TOTP-secret login, `expiries()`, `option_chain()`), labelled mock adapter, expiry selection (weekly / monthly with next-month roll), chain normalization, snapshot storage (JSON + SQLite index + CSV), REST API, local-only control endpoints.
- Frontend (`frontend/`): app shell with signal-chain status bar, Overview, Data & sessions (inspector, CSV), Diagnostics, Settings (theme); **Live option chain** (snapshot-based: weekly / monthly / other expiry, ±N strikes around the broker's ATM label, strike filter, CE/PE toggles, sticky header, refresh per expiry); Expiry comparison shown as Planned. **Analysis** (`/analysis`, auto-sampled every 60 s in market hours, `/charts` redirects): drag/resize widget dashboard (react-grid-layout, layout kept in localStorage) with ECharts: OI / OI change / volume by strike, total CE vs PE bars, option chain table, total premium, premium decay, ATM straddle, spot observations, key levels (PCR, max pain, straddle), strike detail, plus OI intelligence widgets (intraday OI change with selectable baseline, change heatmap, concentration, price and OI) read from the persistent observation store (D39). Built from the stored snapshot; live ticks overlay it while the stream runs. Time-series widgets plot stored snapshot observations only (`GET /api/history/observations`) and say so; flat/insufficient data gets an explicit note, never a fake line.
- Windows (user's PC, 2026-10-28): launcher ran, backend + frontend verified, Kotak Neo live sign-in reported `authenticated`, real expiries retrieved (18 listed; weekly 2026-11-03, monthly 2026-11-23).
- Scripts: `scripts/setup.ps1`, `dev.ps1`, `check.ps1`, `live-check.ps1`. Guide: [setup-windows](setup-windows.md).

## Tested
- On the user's Windows PC (Python 3.14.8, Node 24.21): launcher offline checks all passed (ruff, mypy, pytest 70, tsc, vitest 19, build) before the option-chain page was added.
- In Claude's Linux workspace (Python 3.13, Node 22): (historical, Checkpoint 1) pytest 70, vitest 27. **Latest (2026-10-28):** pytest 127 passed (3 live skipped), ruff + mypy clean, vitest 108 passed, `tsc` clean, build OK, `npm audit` 0 vulnerabilities; Analysis page checked in a real browser against replayed real payloads.

## Not tested
- Anything on the Windows laptop (setup, run, tests) — not yet run by the user.
- Live chain parsing after the fix (decisions #21-23): the user must restart the live launcher and refetch; Superseded: the parser is now tested against two full real responses (81 strikes each); mock mode no longer exists.
- SFeed streaming, live in-place updates, charts, expiry comparison page — not built.

## Blockers / open questions
- User must create `backend/.env` (DATA_MODE=live + KOTAK_*) and run `scripts\live-check.ps1`.
- Live response shapes and SFeed timestamp semantics — see [decisions](decisions.md#open-questions).

## Checkpoint 2 (streaming) — built, awaiting live verification
- **No mock/demo mode anymore (decision 32).** Snapshot is the base; the stream updates everything it can (decision 33); streaming autostarts (34).
- Backend: StreamManager + SFeed adapter + app WebSocket + start/stop API; frontend: live store with row-level subscriptions, reconnecting WebSocket, header signals (broker / snapshot / stream / market / data), live panels on Overview and Diagnostics, LTP and volume overlay on the option chain.
- Tested in Claude's workspace: backend 104 pytest replaying the REAL captured Kotak responses (no invented data), ruff + mypy strict clean; frontend 59 vitest, tsc, production build. The live Kotak stream itself has not been exercised (market closed).
- NOT verified: anything against the real Kotak SFeed (market was closed). Run `scripts\stream-check.ps1` during market hours (09:15-15:30 IST); see decisions open questions.
- Code and package changes show up on a browser refresh (backend auto-restarts, frontend hot-updates, watcher installs new packages). Double-click `NSE Universe.cmd` only to open the app; nothing needs stopping.

## Checkpoint 1 (new brief) — audit done
See [audit-checkpoint1](audit-checkpoint1.md): real snapshot data confirmed, not streaming; 13 findings (F1 market status, F2 OI/volume are units, F3 empty snapshot shadows good one, ...). Findings addressed so far: F3 (empty snapshot no longer hides a good one), F1 partly (market status is read from the exchange feed once streaming; verification pending). Open: F2 units labelling, F4-F6, F8-F10.

## Next action
1. User: `scripts\setup.ps1` → `scripts\check.ps1` → `scripts\dev.ps1` on Windows (or just double-click NSE Universe.cmd).
2. User: fill `backend\.env`, run `scripts\live-check.ps1`, share the (secret-free) output.
3. Claude: fix any live-shape mismatches, then Checkpoint 2 (SFeed streaming, app WebSocket, live state).


## Server deployment (2026-10-28)
Deploy kit written and tested for update/rollback logic and backend startup with server-style settings; **not yet run on the VPS** (see docs/deployment-server.md). T+1 overnight and T+5 broad models, calibration, calls and the forward scoreboard are built; see docs/decisions.md D47.

## Intraday analysis (2026-10-29)
- `/analysis` renamed **Intraday analysis**; Market Sentiment Command Center added above the widgets (D52, [intraday](intraday.md)): overview header, rules-based sentiment with coverage, evidence breakdown (expandable formula/inputs/source), observed regime, qualitative scenarios (no probabilities), decision context, key levels with provenance, options positioning, data coverage and warnings, global/sector/FII-DII context, events, intraday-ML status, stored score history.
- Backend `app/intraday/` + `GET /api/intraday/summary`, `GET /api/intraday/scores`; score ledger `data/intraday.sqlite3` (append-only), recorded each minute in market hours.
- Tested in Claude's workspace: pytest 266 passed (26 new; plus a fix for a wall-clock leak in the history run log that broke a schedule test after 07:30 IST: features, scoring, leakage `until=now`, ledger immutability, API, real captured chain), ruff + mypy clean; vitest 156 passed (12 new), tsc, build; browser check at 1440 px and 390 px (no horizontal overflow) using a payload computed from the PC's real daily history and FII/DII data plus the real captured chain.
- **Not verified live:** no market-hours sample existed before 29 Oct 2026 (0 complete sessions); the first live session is 29 Oct. Breadth, intraday sectors, news headlines, intraday ML, manifests/archive and the daily report are not built (see intraday.md).

## Intraday / prediction separation (2026-10-29, D53)
- Found and fixed a real leak: 12 partial bars (US/Europe, 28 Oct) and 4 Asian bars (29 Oct) had been stored mid-session as final. They are excluded and the 12 were corrected from the final download (the 4 of 29 Oct are corrected after those sessions end). `history/status` lists any held-back bars (`partial_bars_held_back`).
- Models are trained/evaluated only outside market hours (report states "paused" and serves the cache during 09:15-15:45 IST); forecasts are still recorded only 08:35-09:10 IST on overnight data.
- Guard tests: `backend/tests/unit/test_no_intraday_leak.py` (import boundary, completion times, the 28 Oct incident replayed, retry logic, market-hours gate).

## Daily broker sign-in (2026-10-29)
- The backend signs in to Kotak Neo every day at 08:30 IST (`BROKER_DAILY_LOGIN`, `BROKER_LOGIN_TIME`), retries every 5 minutes until 09:10 on failure, and restarts the live stream afterwards if it was running so it uses the new session. Status: `GET /api/broker/daily-login`. Tested with a stand-in broker (schedule, retry, once per day); the first real 08:30 run is 29 Oct.

## Storage and end-of-day lifecycle (2026-10-29, D54)
- Built and tested (pytest 306 passed in Claude's workspace; vitest 168): `backend/app/lifecycle` (verified daily archive, session manifests, daily summaries with the close-of-day chain, verified backups with bounded retention, regenerable-file tidy, snapshot retention with safety checks, storage report), `GET /api/storage/status`, `POST /api/storage/eod/run`, Settings -> Storage panel. Plan and numbers: [storage-plan.md](storage-plan.md).
- **Not enabled until the owner approves limits:** removal of snapshot files. Defaults keep everything.
- **Open finding:** the PC stopped collecting at 09:49 IST on 29 Oct (the log ends there without an error, consistent with the computer sleeping). Only the server should be relied on for full sessions; its first full session has not been checked from here.
- Not verified live: the end-of-day run has not yet executed on a real full session (the first one after deploy is the next trading day).

## Intraday regime and ML plan (2026-10-29, D55)
- Regime measure fixed (z-score of the move + 5-minute path efficiency); scenarios filtered by relevance; nightly labelled dataset (`feature_rows`, version if-1) built by the end-of-day job; page shows the ML stage. Not verified live: the first nightly dataset is built after the next full session; no intraday model exists yet.

## Breadth and sectors (2026-10-29, D56)
- Planned, not built: [market-breadth-plan](market-breadth-plan.md). Breadth and sector evidence groups and two decision-context questions read "Unknown" until phase 1-2 exist. First step: a market-hours capture of stock ticks to verify fields, rates and sources.

## 30 Oct 2026: strategy builder redesigned (StockMojo-style)
New layout, ready-made gallery, POP/Reward:Risk/breakeven % stats, dashed model estimate, ±SD markers, OI bars on the payoff, Positions/Greeks tabs, multiplier, include checkboxes. `optionModel.ts` restored with `contractDelta`, `probabilityOfProfit`, `sdBands`. 270+ frontend tests, tsc and build pass. Live check after deploy still to be done by eye.

## 30 Oct 2026: payoff chart reworked, target and stop-loss per leg
Chart: y-scale fitted to the shape (a runaway side is clipped at 3x the other), x-range out to the 2-sigma band, shaded 1σ/2σ corridors, horizontal spot label, vertical BE/σ labels, OI bars smaller, tooltip shows % from spot and the σ zone. Per leg Target and Stop-loss premium (price or 30/50/80% and 30/50/100% presets; sides swap for sellers; wrong side is flagged). Stats show "If targets hit" / "If stops hit" (exact arithmetic) and the chart marks the NIFTY level where each leg is modelled to reach its target/stop (`spotAtPremium`, a model estimate, Black-76 at the chosen day). Not wired to any order: read-only, no order placement.

## 30 Oct 2026: data-derived blue line and sigma, wider payoff, advanced builder
- **No assumed forward:** the forward is read from put-call parity in the stored chain (median over the 5 strikes nearest spot, spread shown); the carry that reproduces it replaces the assumed rate. The rate (default 6 %, Settings) now only discounts. If fewer than 3 strikes have both prices the page falls back to spot grown at the rate and says so.
- **Blue line (T+0/T+n estimate):** each leg uses the implied volatility of its own strike's stored price (not one backed out of the typed entry premium); at the snapshot spot the model reproduces the stored price (tested).
- **Sigma:** lognormal quantiles ln S = ln spot + carry t - sigma^2 t / 2 +/- k sigma sqrt(t), ATM IV taken at the strike nearest the forward. Markers, scenario rows and POP now use one distribution (tested together: a call struck at +1σ wins 15.9 %). The old linear spot±kσ√t bands are gone. ATM straddle price shown as a model-free cross-check.
- New: what-if sliders (day, IV shift, NIFTY level, with exact expiry P&L next to the model P&L), Scenarios tab (σ rows × dates, expiry column exact), Model inputs panel, strategy analysis panel (`strategyInsights.ts`), stats strip above a full-width chart.

## 30 Oct 2026: why StockMojo and our estimates differ (checked against the server chain)
- Stored weekly 22950 CE/PE LTP is 154.5/125.2 (fetched 02:37 IST 30 Oct, no exchange timestamp); StockMojo at 15:40:59 shows 150.6/128.25. Net credit 279.7 vs 278.85 = 0.85 pt x 65 = ₹55: this alone explains max profit 18,181 vs 18,125, breakevens 22,670 vs 22,671 and expiry P&L 11,031 vs 10,975 at 22,840.
- The blue line is sensitive to the put-call-parity forward (C-P at one strike): each point of forward moves the 22,840 value by ~₹15. Forward 22,979 from our prices vs 22,972 from theirs accounts for most of -215 vs -335.58. Reproduced independently in Python (their prices, parity forward, T=4.99 d gives -335).
- Fixed: model time ran from the fetch (after hours, T=4.54 d); now from the market time the prices belong to (`marketClockMs`, 15:40 of the last session, T=4.99 d). Holidays are not known to it.
- Not fixable from here: last-traded prices of two contracts are not simultaneous, and no in-session snapshot exists for 29 Oct. The first in-session samples (30 Oct from 09:15) will be the real comparison.

## 30 Oct 2026: Greeks everywhere, sigma convention, leg UI
- **Greeks (`contractGreeks`, Black-76, tested against finite differences):** delta = e^((carry-r)t)N(d1); gamma; vega = e^(-rt)Fφ(d1)√t/100 per vol point; theta = price one calendar day later minus now (intrinsic after expiry). One calculation feeds the chain columns (Δ Γ Θ Vega IV, pick in Settings; Wide mode), each leg row, the Greeks tab and the net strip. Rho omitted on purpose (forward comes from the market).
- **Delta vs StockMojo:** compared per strike from the screenshots: put delta 22850 to 23200 ours -0.36 -0.41 -0.46 -0.52 -0.58 -0.64 -0.69 -0.75, theirs -0.36 -0.42 -0.47 -0.53 -0.59 -0.65 -0.70 -0.75. All within 0.01. The offset is the forward: parity from every strike 22400-23450 gives 22,978-22,981 (very consistent), theirs ~22,972 from their prices; 9 forward points = 0.01 delta at 4 days.
- **Sigma levels:** now the market convention, spot x (1 ± kσ√t) centred on spot (was lognormal about the forward, which pushed both sides ~60 pts right of StockMojo's). ATM IV at the strike nearest the forward, t to the 15:40 close. POP stays lognormal about the forward.
- Strategy-analysis panel removed. Legs: coloured edge, strike and lot steppers, per-leg Δ·Θ, summary line. Chain rows holding a leg are tinted, tagged with +/- lots and keep their B/S buttons visible (the ready-made strategies did not highlight before).

## 30 Oct 2026: Exit all and Closed strategies
"Exit all" (positions card, right corner) exits every ticked leg at its stored price, saves name, legs, entry, exit and realised P&L as a closed trade (browser storage, key `nse.closed.v1`) and clears the builder; it refuses, naming the legs, when a leg has no stored price or entry premium. "Closed (n)" beside Saved lists them; clicking one loads its legs and shows a banner with the exits. Chain rows holding a leg have −/+ for one lot fewer/more. Nothing is sent to a broker; exit prices are stored snapshot prices, not fills.

## 30 Oct 2026: payoff graph in the StockMojo layout, OI linked to the chain
Solid blue "on target date" line, SD labels across the top, boxed "Current price", OI bars for every chain strike (call green / put red, same colours as the chain) standing on the zero line with their own right axis, selectable Open interest / Change in OI (bars go below zero) / none; OI strip for the ATM strike; SD fixed/off; Zoom out; NIFTY target with −/+ and level box; date slider with prev/next day and "nD to expiry"; projected P&L badge at the target. **Bug fixed:** `MarkAreaComponent` was never registered in the app's ECharts, so the ±1σ/±2σ shaded corridors had not been drawing (tests registered it themselves); now registered in `EChart.tsx` and in the render test.

## 30 Oct 2026: Intraday analysis page, visual pass
`components/viz.tsx` (Gauge, MiniBar, FillBar, RangeBar, SplitBar, Tile, Ladder) and two chart builders (`ivSmileOption`, `divergingBarOption`). Breakout card: opening-range (or previous-day range when none is stored) bar with the current price; heavyweights and top-5 tables: change bars, RSI bars, trend chips; IV card: smile chart; positioning: PCR bars around 1.0 and top-3 concentration bars; sectors: diverging bar chart beside the table; global/sector rows with bars; setup monitor: decision banner, control chips, status pills; paper trading: KPI tiles; key levels: price ladder; options positioning: PCR gauge and call/put splits; decision context: highlighted answers. All text and test ids kept; a missing value still draws an empty track, never zero.

## 30 Oct 2026: time-series charts are session-only
`rangeObservations` keeps only samples taken on a weekday between 09:15 and the 15:40 close (IST); overnight and weekend fetches hold the last close and drew a flat line across the night. Ranges (30 min, 1 hour) are measured back from the newest in-session sample; Session fixes the x axis to that day's 09:15-15:40; All shows only session samples with a gap (null) between days. `sessionize()` applies the same rule to every time-series chart, including premium decay and the OI series, whose data come from the backend with overnight points. If a stored set has no in-session sample at all, the after-hours samples are shown with a note. Exchange holidays are not known to the frontend, so a manual fetch on a weekday holiday would count as a session sample. The 15:40 close (CAS) lives in `lib/session.ts` and `app/domain/session.py`; change both if NSE reverts.

## 30 Oct 2026: PCR widgets merged
"PCR: ATM and overall" now holds the donut (outer ring overall, inner ring ATM) beside the PCR table; the separate "PCR donut" widget is gone (a saved layout that still lists it simply drops it).

## 30 Oct 2026: Prediction page, visual pass
Compute now is a highlighted accent button in its own strip with the last automatic / manual run as pills. Each forecast has a "Reading of this forecast" written from its own numbers (`readingLines`: distance from the base rate in points, whether the models agree, the call or why none, the historical ranges as prices, event risk; nothing fixed about the market). New graphics (`PredictionViz.tsx`): model dots against the base rate, historical range bar around the last close, holdout gain with 95% intervals per model, reliability plot in the model detail, hit-rate interval in the forward scoreboard.
