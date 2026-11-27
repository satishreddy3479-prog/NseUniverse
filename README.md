# NSE Universe

A long-term research platform for the Indian options market. It connects to one broker (Kotak Neo), streams the live NIFTY 50 option chain, stores what it sees, and turns it into a dashboard of open-interest, volume, implied-volatility, Greeks, straddle and sentiment analysis, plus a paper-only strategy builder.

**It is read-only.** It never places orders. Paper strategies are simulated on live and stored prices. Market data is never made up: there is no mock or demo mode, and the tests replay real captured broker payloads.

## Where things are

| Part | Folder | What it is |
|---|---|---|
| Backend | `backend/` | Python 3.12, FastAPI. Owns the broker login and the live feed, stores the data (gzip snapshots plus SQLite), computes the analytics, serves the API and the WebSocket. |
| Frontend | `frontend/` | React, TypeScript, Vite, TanStack Query, ECharts. Shows what the backend serves; it never touches broker credentials. |
| Server files | `deploy/` | Caddy, systemd units, the update, watchdog, backup and deploy-guard scripts for the production server. |
| Windows scripts | `scripts/` | `setup.ps1`, `dev.ps1`, `check.ps1`, and other helpers for the laptop. |
| Research | `research/` | Offline studies (swing backtest, premium speed); not part of the running app. |
| Docs | `docs/` | Start with [docs/README.md](docs/README.md). |

## Read this first

1. [CLAUDE.md](CLAUDE.md): the project rules in one page (also read by AI coding tools through [AGENTS.md](AGENTS.md)).
2. [docs/current-state.md](docs/current-state.md): what is built, what is live, what is unverified. Newest section first.
3. [docs/code-map.md](docs/code-map.md): "to change X, look in Y".
4. [docs/decisions.md](docs/decisions.md): why things are the way they are (append-only, newest last).

## Run and test (Windows, from the repo root)

- Set up once: `scripts\setup.ps1`. Needs `backend\.env` with the broker credentials (never commit it).
- Start the app: `NSE Universe.cmd`, or `scripts\dev.ps1`. The backend restarts on code changes and the frontend hot-updates.
- All offline checks before a push: `scripts\check.ps1`.
- By hand, backend (from `backend/`): `python -m pytest tests -q`, `python -m ruff check .`, `python -m mypy app`.
- By hand, frontend (from `frontend/`): `npx vitest run`, `npx tsc -b`, `npx vite build`.
- Tests that call the live broker are opt-in (`-m live`, `NSE_LIVE_TESTS=1`); they are never part of the normal run.

Details: [docs/setup-windows.md](docs/setup-windows.md).

## How it reaches production

The production server (a small Linux VPS) pulls the `main` branch from GitHub about once a minute, checks it, restarts the service and rolls back on failure. A deploy guard holds new releases from 08:55 to 15:50 IST on weekdays, so nothing restarts during the market session unless the owner allows it once. **Merging or pushing to `main` is therefore a production release.** Details: [docs/deployment-server.md](docs/deployment-server.md).

## The rules that matter most

- No secrets in the repository; never read or print `backend/.env`.
- No order placement, and no instrument other than NIFTY 50, unless the owner separately authorises it.
- Missing data stays missing (no silent zero-fill); keep exchange time and receipt time apart; say when data is stale.
- OI change is computed locally (current OI minus previous-day OI); OI and volume are in units; the NIFTY lot size is 65.
- Tests use real captured data, with an independent hand calculation for every formula.

The full rules are in [.claude/rules/](.claude/rules/) (`financial-data.md`, `security.md`, `testing.md`, `python.md`, `frontend-ui.md`).
