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
