# Architecture

Status legend: **Built (CP1)** = implemented and unit-tested in Phase 1 Checkpoint 1, not yet live-verified; **Proposed** = not built.

| Component | Intended role | Status |
|---|---|---|
| Frontend | React + TS + Vite + Tailwind: app shell, signal-chain status bar, Overview, Data & sessions (snapshot inspector, CSV), Diagnostics, Settings; Live option chain page built (snapshot-based); charts/expiry comparison shown as Planned | Built (CP1) — shell; tables/charts Proposed |
| Backend API | FastAPI REST (`/api/health, status, config/status, errors, expiries, option-chain, snapshots, snapshots/{id}, snapshots/{id}/csv, sessions`; POST `snapshots/capture`, `auth/login` local-only). `GET /api/stream/status`, POST `/api/stream/start|stop` (local-only), WebSocket `/ws/market-data` (hello, batched ticks, status, market) | Built (CP1) |
| Broker integration | `KotakBroker` (kotakneoapi 3.0.x: TOTP+MPIN login, `expiries()`, `option_chain()`) and labelled behind one interface. SFeed streaming Proposed (CP2) | Built (CP1), not live-verified |
| App WebSocket | `/ws/market-data`: loopback + allowed-origin check, hello with full book, 250 ms coalesced tick batches, 1 s status, bounded per-client queues, client limit | Built (CP2) |
| Market-data normalization | `domain/normalize.py`: option chain → typed snapshot; missing stays null, invalid flagged, completeness complete/partial/empty; `domain/expiry.py` weekly/monthly selection | Built (CP1) |
| Live stream | `app/stream/`: StreamManager (state machine, backoff, stale detection), KotakFeed (SDK SFeed adapter), LiveBook (latest tick per instrument, dedupe), Hub | Built (CP2), not live-verified |
| Storage | JSON snapshot + scrubbed raw payload per capture, SQLite index of sessions/snapshots, CSV export; ticks JSONL Proposed (CP2) | Built (CP1) |
| Analytics | OI changes, PCR, IV, Greeks — deferred to Phase 3 | Deferred |
| Testing | pytest (70 unit), vitest (19), opt-in live tests (`-m live`); e2e Proposed | Built (CP1) |

## Data flow (intended)
Kotak Neo → broker adapter → normalizer → (storage, broadcaster) → WebSocket/REST → frontend.

## Layout
`backend/` (app/{api,broker,domain,services,storage}, tests/{unit,live}), `frontend/` (src/{components,lib,pages,test}), `scripts/` (PowerShell setup/dev/check/live-check), `docs/`. Runtime data in `data/`, logs in `logs/` (both git-ignored). Path-scoped rules in `.claude/rules/` match this layout.

## Environments
- Development: Windows 11 laptop and GitHub Codespaces, same GitHub repo. The app uses only real Kotak data; tests replay real captured responses.
- Production: separate low-resource Linux server that runs the application and holds broker credentials. Resource limits drive design (bounded buffers, lean dependencies).

## Server-first deployment model (PROPOSED — not built, server not modified)
- **GitHub stores source code only.** No secrets, no runtime data, no production config.
- **The Linux server runs production** and **pulls** updates (no inbound access from GitHub/CI to the server).
- **Deploy agent (on the server):** a small systemd timer/service polls GitHub for a new *approved* commit, then: fetch → verify approval → build into a new release directory → run checks (tests/health check) → atomically switch the `current` release → restart the app → health check → roll back to the previous release on failure. Logs every deploy.
- **"Approved commit" (proposed rule, to confirm):** a commit on `main` reached only via reviewed PR/merge by the owner, or a release tag created by the owner. Unapproved branches are never deployed.
- **Access:** read-only GitHub deploy key (or fine-grained read-only token) stored only on the server; deploy agent runs as a non-root user.
- **Secrets & state:** broker credentials, `.env`, sessions and market data live on the server outside the repo/release directories and persist across releases.
- **Resource note:** polling must be cheap (`git ls-remote`/fetch on a timer); builds must fit the server's memory or be built elsewhere — open question.


## Prediction subsystem (backend/app/prediction)
Pure, dependency-light modules: `calendar` (exchange sessions), `targets` (labels), `pit` (information-cutoff guard), `ledger` (append-only forecasts in `data/forecasts.sqlite3`), `evaluation` (purged splits, metrics). It reads features through a backend interface (observation store, future feature tables), never from the frontend; training happens off the server.
