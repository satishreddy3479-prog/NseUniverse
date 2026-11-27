# Code map: "to change X, look in Y"

Read this before searching the repository. Paths are from the repo root. Module descriptions are the first line of each module's own docstring, so `Read` the top of a file to confirm before editing it.

## The shape of the running system

- **One backend process** (`backend/app`, started by `python -m app`), one asyncio event loop. It holds the single Kotak login and the single live feed (`stream/manager.py`), fans the feed out to browsers over one WebSocket (`stream/hub.py`, `api/ws.py`), and serves a REST API under `/api` (`api/routes.py` plus `api/library_routes.py`, `api/risk_routes.py`, `servermgmt/api.py`).
- **Everything heavy runs off the loop.** Short blocking calls use `asyncio.to_thread`. CPU-heavy computations and cache refreshes run on one low-priority worker (`stream/heavy.py`, `api/readcache.py`), because the production server has one core. Read-only SQLite reads use a small connection pool (`storage/readers.py`). `stream/loopwatch.py` logs every loop stall and names the threads that caused it.
- **Storage** is files plus SQLite under the data directory (`/var/lib/nse-universe/data` on the server): gzip chain snapshots with an index (`storage/store.py`), one-minute observations (`storage/observations.py`), and one small database per feature (`intelligence.sqlite3`, `straddle.sqlite3`, `market.sqlite3`, `runtime.sqlite3`, `swing_paper.sqlite3`, and others). Never delete stored data without the owner's approval.
- **Production**: Caddy (login and TLS) in front of the backend on `127.0.0.1:8010`; systemd units in `deploy/systemd`; the server pulls `main` about once a minute (`deploy/update.sh`), the deploy guard holds releases from 08:55 to 15:50 IST on weekdays (`deploy/deploy-guard.sh`), and a watchdog raises alerts (`deploy/watchdog.sh`).
- **The frontend** (`frontend/src`) gets normalized data from `/api` and the WebSocket only. Pure calculation lives in `frontend/src/lib`; pages in `pages/`; widgets and panels in `components/`.

## Backend: which folder does what (`backend/app`)

| Folder | What is in it |
|---|---|
| `main.py`, `config.py`, `logging_setup.py` | Wiring of every service at start-up and shut-down (the order matters: the broker feed is closed first), settings from `backend/.env`, structured JSON logging. |
| `broker/` | The only code that talks to Kotak: `kotak.py` (login, option chain, expiries), `base.py` (the interface the services use). |
| `domain/` | Typed data contracts and pure rules: `models.py` (snapshot, quote, row), `normalize.py` (Kotak payload to snapshot), `session.py` (the NSE session, closing-auction schedule, close time), `expiry.py`, `chain_quality.py`, `spot_check.py`, `overrides.py`. |
| `stream/` | The live feed: `manager.py` (supervision, reconnect, silence watchdog), `feed.py` (the only module that touches the SDK), `book.py` (latest tick per instrument), `hub.py`, `index_close.py` (the kept closing value), `runtime_metrics.py`, `loopwatch.py`, `heavy.py`, `procstats.py`. |
| `services/` | Scheduled work around the feed: `snapshot_service.py` (expiries, chain capture), `sampler.py` (one stored sample per minute in market hours), `universe.py` (what to subscribe), `daily_login.py`, `shadow.py` (live vs stored check), `history.py`. |
| `storage/` | `store.py` (snapshot files and index), `observations.py`, `readers.py`, `strategies.py` (saved and running strategies, kept on the server), `preferences.py`. |
| `intelligence/` | The market-intelligence layer: `service.py` (aggregation, per-minute timeline recorder), `fusion.py` (the fused verdict), `outlook.py`, `trend_engine.py`, `turn.py`, `pullback.py`; and the straddle engine: `straddle.py` (pure analysis, including the managed straddle book), `straddle_service.py` (reads stored samples, serves the analysis and the managed history), `straddle_env.py` (buyer and seller environments), `straddle_watch.py` (alerts). |
| `intraday/` | Features and rules-based sentiment from stored observations: `volatility.py`, `positioning.py`, `gex_history.py`, `price_structure.py`, `service.py` (the Command Center payload), plus paper-trading and evaluation helpers. |
| `market/` | Breadth, heavyweights, futures, index one-minute bars and their cross-check, order-flow estimates (`service.py`, `store.py`, `index_bars.py`, `flow.py`, ...). |
| `risk/` | The Greeks and What-If engine (Black-76 pricing, IV solve, SVI surface, portfolio Greeks, scenarios); routes in `api/risk_routes.py`. |
| `strategy/` | `automation.py`: the paper strategy that runs on the server every second: stops, targets, trailing, re-entry, holding-period close, strategy-level rules, and the managed-straddle re-strike. No order is ever sent. |
| `swing/` | The swing paper-trading engine and its stores. |
| `edge/`, `forward/` | The nightly "does an indicator have an edge" scoring, and the forward test of simulated short options. |
| `prediction/` | Only data collection remains (flows, daily history, calendars, events); the prediction models were removed (D148). |
| `globalmkts/` | Global markets board, news and calendar feeds (Yahoo, RSS, GIFT Nifty). |
| `lifecycle/` | End-of-day pipeline: validate, archive, back up, tidy; session-close tracking; storage reports. |
| `library/` | Zip bundles of data that ages out of the server. |
| `servermgmt/` | The Server Management Centre (storage scan, metrics, restart helper hand-off). |
| `analytics/` | `oi.py`: open-interest analytics over stored observations. |
| `api/` | `routes.py` (the REST API), `ws.py`, `readcache.py` and `coalesce.py` (one computation shared by callers), `security.py` (loopback and login checks for state-changing endpoints). |

## Frontend (`frontend/src`)

- `App.tsx`: the routes (`/market-intelligence`, `/market-intelligence/straddle`, `/strategy`, `/analysis`, `/option-chain`, `/portfolio`, `/server`, `/diagnostics`, `/settings` and others). `pages/`: one file per page.
- `lib/`: pure functions and types, no UI. `api.ts` (every request), `analytics.ts` and `chartOptions.ts` (the analysis modules and their chart builders), `strategy.ts` (legs, payoff, templates, the browser-side automation rules), `straddleDecay.ts` (straddle engine types), `useLive.ts` and `liveSocket.ts` (the live stream), `session.ts` (session and close times), `format.ts`.
- `components/`: `dashboard/widgets.tsx` (the registry of dashboard widgets), `intelligence/` (market-intelligence and straddle-engine panels, including `StraddleRestrikeLog.tsx`), `risk/`, `swing/`, `servermgmt/`, `eagle/`, plus shared pieces (`EChart.tsx`, `AppShell.tsx`, `SpotBadge.tsx`).
- `test/`: Vitest tests, mostly one file per feature, with fixtures built from real captured data.

## Where to look for a given change

| If you want to... | Open |
|---|---|
| Add an analysis widget | The `build-widget` skill; `lib/analytics.ts`, `lib/chartOptions.ts`, `components/dashboard/widgets.tsx`, a test with a hand calculation. |
| Add a ready-made strategy | `TEMPLATES` and `TEMPLATE_BIAS` in `frontend/src/lib/strategy.ts`; its page in `pages/StrategyBuilder.tsx`. |
| Change a server-side strategy rule (stop, target, hold, re-strike) | `backend/app/strategy/automation.py` and its tests (`tests/unit/test_strategy_automation.py`, `test_strategy_hold.py`, `test_restrike.py`). The browser has a mirror of some rules in `lib/strategy.ts`; keep both in step (`test_strategy_parity.py`). |
| Change the straddle engine or its managed book | `intelligence/straddle.py` (pure), `straddle_service.py`; page `components/intelligence/StraddleDecay.tsx`, `StraddleGlance.tsx`, `StraddleRestrikeLog.tsx`. |
| Change the live feed behaviour (reconnect, silence) | `stream/manager.py` and `tests/unit/test_stream.py`; read D337 and D338 in `docs/decisions.md` first. |
| Add an API endpoint | `api/routes.py`; use `_shared` or `_cached` and `run_heavy` for anything slow, `asyncio.to_thread` for short blocking calls. Add a test with `TestClient` (see `tests/unit/test_straddle_scores.py`). |
| Change what is stored or for how long | The Storage section of `CLAUDE.md`, `docs/storage-plan.md`, `lifecycle/`. Measure first; never delete stored data without approval. |
| Change the session or closing times | `domain/session.py` only; everything else reads it from there. |
| Change deployment or the server | `deploy/` and `docs/deployment-server.md`; never during market hours. |
| Find out why something is the way it is | `grep` the feature in `docs/decisions.md`, then the plan or audit named there. |

## Tests

- Backend: `backend/tests/unit` (about 130 files, no network), `backend/tests/live` (opt-in, real broker), `backend/tests/fixtures` (real captured Kotak payloads and stored sessions), `backend/tests/replay.py` (replays a captured chain as a fake broker).
- Frontend: `frontend/src/test`.
- Run everything offline with `scripts\check.ps1` before a push.

## Conventions that are easy to miss

- Times are stored in UTC; the market clock is IST (`Asia/Kolkata`). Keep exchange time and local receipt time separate.
- A missing value is `None`/`null`, never `0`; analysis functions skip and count missing values.
- Existing files use CRLF line endings on the Windows checkout; keep them when editing.
- A new decision gets the next `D###` in `docs/decisions.md`; unpushed work is listed in `docs/pending-push.md`.
