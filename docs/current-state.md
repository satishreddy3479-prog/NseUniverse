# Current state
_Last updated: 2026-10-29_

- **Objective:** NSE Universe — Indian market research platform; see [roadmap](roadmap.md).
- **Phase:** Phase 1 (Kotak Neo + NIFTY option chain + dashboard). **Milestone:** Checkpoint 1 built; awaiting the user's Windows setup and live check.
- **Stage:** local-only; no Git repo, no GitHub, no deploy (decision #13).

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
