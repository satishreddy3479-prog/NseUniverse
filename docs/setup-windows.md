# Setup and running on Windows 11

## Requirements
- Python 3.11–3.14 (python.org installer; includes the `py` launcher). The Kotak SDK needs ≥3.10; this project targets 3.11+.
- Node.js 22 LTS (includes npm).
- PowerShell (built in). Git is not needed yet (local-only stage, decision #13).

## Quickest path: one launcher
Double-click **`NSE Universe.cmd`** (the only file you need) in the project root (or run
`powershell -ExecutionPolicy Bypass -File scripts\launch.ps1`). It:
reports the environment, picks Python 3.12 (3.11-3.14 accepted) and Node 22, creates
`backend\.venv`, installs pinned packages, runs `npm ci`, creates `backend\.env` from the example
if missing, runs all offline checks, then starts backend and frontend **in the background** on
free loopback ports (8000/5173 by default; never stops other programs, never starts duplicates)
and verifies them over HTTP. The backend signs in to Kotak (read-only), builds the weekly and monthly snapshots, and starts the live stream by itself.
Results: `logs\launch-summary.txt`, `logs\launch-report.json`; per-step logs in `logs\`.
There is nothing to restart after changes: refresh the browser. If you ever want to shut it all down, run `scripts\stop.ps1`; it stops only the processes it started.
The servers keep running after the launcher window closes, until stopped or the PC restarts
(no auto-start on boot is configured).

## One-time setup
From `S:\Nseuniverse`:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```
This creates `backend\.venv`, installs backend packages, runs `npm ci` in `frontend\`, and copies
`backend\.env.example` to `backend\.env` (you then fill in the KOTAK_* values). No broker calls are made by setup.

Manual equivalent:
```powershell
cd backend; py -3 -m venv .venv; .\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt; copy .env.example .env
cd ..\frontend; npm ci
```

## Run
```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
```
- Dashboard: http://127.0.0.1:5173
- API docs (OpenAPI): http://127.0.0.1:8000/docs

Or in two terminals: `cd backend; .\.venv\Scripts\python.exe -m app` and `cd frontend; npm run dev`.

## Kotak credentials (required)
There is no demo mode: the app uses only real Kotak Neo data. Fill in, **yourself, on this machine only**,
`backend\.env`:

| Variable | What it is |
|---|---|
| `KOTAK_CONSUMER_KEY` | Token from Neo app -> Trade API card -> API dashboard |
| `KOTAK_MOBILE_NUMBER` | Registered mobile with country code (+91...) |
| `KOTAK_UCC` | Unique Client Code (Neo app -> Profile) |
| `KOTAK_MPIN` | Trading MPIN |
| `KOTAK_TOTP_SECRET` | Base32 secret from Kotak TOTP registration (decision #15) |

Never paste these into chat, commit them, or copy `.env` elsewhere. If any is missing the backend refuses to
start and names the missing variable (never the values).

## Authenticate and capture snapshots
- The backend signs in automatically at start (TOTP generated from the secret, then MPIN).
  Status: **Connection diagnostics** page; retry with **Sign in again**.
- **Overview → Capture snapshot** fetches the weekly and current-monthly NIFTY chains (one fetch
  if both are the same date). Snapshots are saved under `data\` (git-ignored) and listed in
  **Data & sessions**, where each can be inspected or downloaded as CSV.
- Streaming (start/stop) is not built yet — Checkpoint 2.

## Live streaming
- **Start/stop:** Overview, Live option chain and Connection diagnostics have **Start stream** / **Stop stream**. Streaming is off until you press Start (set `STREAM_AUTOSTART=true` in `backend\.env` to change that).
- The first start makes a small test subscription (NIFTY index + the ATM call and put), then subscribes the weekly and monthly chains (about 325 instruments, limit 3000). If no weekly/monthly snapshot exists yet, it fetches one first.
- The top bar shows **Stream** (connection), **Market** (from the exchange feed; never assumed) and **Data** (fresh, stale or last session) separately.
- On the option chain, LTP and volume update live; OI and OI change stay from the snapshot.
- Outside market hours the feed may send nothing; the page then says so instead of showing the data as live.
- **Verification during market hours:** `powershell -ExecutionPolicy Bypass -File scripts\stream-check.ps1` (read-only; prints counts and field values, no secrets).
- After updating the code, just refresh the browser. The backend restarts itself (and signs in to Kotak again, about a few seconds); new packages are installed by the watcher (`logs\watcher.log`).

## Tests
```powershell
powershell -ExecutionPolicy Bypass -File scripts\check.ps1        # offline: ruff, mypy, pytest, tsc, vitest, build
powershell -ExecutionPolicy Bypass -File scripts\live-check.ps1   # LIVE, read-only: login, expiries, weekly snapshot
```
Live tests never run in the default suite. They print counts and field shapes, not secrets.

## Troubleshooting
| Symptom | Fix |
|---|---|
| `running scripts is disabled` | Use the `powershell -ExecutionPolicy Bypass -File ...` form shown above. |
| Dashboard shows "Backend offline" | Start the backend; check port 8000 is free (`netstat -ano | findstr :8000`). |
| `Configuration error in backend/.env` | The message names the missing/invalid variable. |
| "Refusing to bind to a non-loopback APP_HOST" | Keep `APP_HOST=127.0.0.1` (no auth exists yet). |
| Sign-in failed | Check MPIN/UCC/mobile; TOTP secret must be the base32 key; PC clock must be accurate (TOTP is time-based: Settings → Time → Sync now). |
| `rate_limited` | Wait and retry; the backend spaces broker calls but Kotak enforces its own limits. |
| Capture returns 403 | Control actions are accepted only from this computer via the dashboard origin. |
| `npm ci` fails | Delete `frontend\node_modules` and rerun; requires Node 22. |

Logs: `logs\backend.log` (redacted JSON) and `logs\neo-api-client.log` (SDK, WARNING+). Both git-ignored.
