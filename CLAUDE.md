# NSE Universe

## Project identity
- **Name:** NSE Universe — long-term Indian financial-market research platform.
- **Vision:** reliable broker connectivity → live option-chain data → professional dashboard → OI/Greeks/IV analysis → historical research → more NSE instruments. See [roadmap](docs/roadmap.md).
- **Current phase:** Phase 1. Live option chain, streaming overlay, Intraday analysis page (rules-based command center + widgets, [intraday](docs/intraday.md)) and market-hours sampler built and tested on real captured payloads; live stream not yet verified in market hours. Status: [current-state](docs/current-state.md). Setup/run: [setup-windows](docs/setup-windows.md).
- **Current priority:** Kotak Neo API integration + live NIFTY 50 option-chain streaming (weekly + current-monthly expiries).
- **Requested 29 Oct 2026 (phased, see [intraday-engine-status](docs/intraday-engine-status.md)):** price structure, breakout intelligence, IV/Greeks, prediction engine, setup/risk (read-only), backtesting. **Still out of scope:** order placement, instruments other than NIFTY 50. (Already built: OI/volume/PCR/max-pain/straddle analytics on stored snapshots.)

## Architecture principles
- Separate backend, frontend, market-data services, storage, analytics. Details: [architecture](docs/architecture.md).
- Backend owns broker credentials and connectivity; frontend consumes normalized backend data only.
- Server-first: GitHub stores source; the Linux server runs production and auto-deploys approved commits by pulling (proposed, see [architecture](docs/architecture.md)). Merging to the approved branch is a production-impacting act.
- Modular, testable components with explicit data contracts (typed models/schemas).
- No unnecessary dependencies or abstractions.
- Must work on Windows 11, GitHub Codespaces and the Linux server; no OS-specific code without need.

## Engineering standards
- Python: type hints, clear interfaces. Frontend: TypeScript. Rules: [python](.claude/rules/python.md), [frontend-ui](.claude/rules/frontend-ui.md).
- Consistent formatting/naming, focused modules, reusable components.
- Meaningful errors, structured logging.
- Tests for important functionality: [testing](.claude/rules/testing.md).

## Financial-data integrity
Full rules: [financial-data](.claude/rules/financial-data.md). Non-negotiables:
- Never fabricate live data. There is no mock or demo mode; tests replay real captured Kotak payloads (`backend/tests/fixtures`).
- OI change = current OI minus previous-day OI, computed locally (Kotak's own change field is a price change). OI and volume are in units; lot size 65.
- Missing stays missing (no silent zero-fill).
- Record timestamps and provenance; keep exchange time and local receipt time separate.
- Verify formulas; never call an unverified calculation "validated".
- Flag stale or incomplete data.

## UI standards
Full rules: [frontend-ui](.claude/rules/frontend-ui.md).
- Professional dashboard, one design system, responsive desktop + mobile.
- Working interactive charts/tables; accessible navigation; clear status indicators.
- Explicit loading, empty, error and stale-data states.
- No fake functionality or inert controls. No market-data credentials in browser code.

## Security
Full rules: [security](.claude/rules/security.md).
- No secrets in source or commits; use environment variables/secure config; redact logs.
- No unauthorized external actions. No order placement unless separately authorized in a future scope.

## Adding an analysis module
Pure function in `frontend/src/lib/analytics.ts` (missing values skipped and counted, never zero) -> option builder in `chartOptions.ts` -> widget in `components/dashboard/widgets.tsx` (register in `WIDGETS`; show source, expiry and empty states) -> tests built from real captured data, with an independent hand calculation. Time series use stored snapshots only (`/api/history/observations`).

## Storage
Snapshots are gzip files plus a SQLite index; the sampler stores every 60 s in market hours, skips unchanged chains, and pauses below 2 GB free. Measure before changing sampling or formats; never delete stored data without approval. Plan, sizes and approvals: [storage-plan](docs/storage-plan.md). Server rules: skills `nse-universe-project-rules`, `nse-trading-desk-master`.
- Control endpoints trust loopback clients: do not put the backend behind a reverse proxy until they are authenticated.

## Prediction work
T+1/T+5 research system: read `docs/prediction/overview.md` first. Never use information published after a forecast cutoff, never fabricate history or news, never rewrite a stored forecast, never add a paid or account-based source without approval. Not a trading system.

## Testing and verification
- Test before claiming completion; unit tests separate from live integration tests.
- Never weaken tests to pass; report tests not run.
- Never claim an external integration works without evidence.

## Working protocol
- Inspect relevant code before editing; state a concise plan for substantial changes.
- Implement incrementally; validate each meaningful change.
- Update [current-state](docs/current-state.md) after meaningful work.
- Do not commit, push, deploy or run destructive commands without authorization.
- Workflow across laptop/Codespaces: [development-workflow](docs/development-workflow.md). Decisions: [decisions](docs/decisions.md).

## Commands (Windows, from repo root)
- Open the app: double-click `NSE Universe.cmd` (starts it if needed). Dev mode is on: backend auto-restarts on code changes, Vite hot-updates, `scripts\watch.ps1` installs new packages. After any change tell the user to just refresh the browser; never ask them to stop/start.
- Live stream check (market hours): `scripts\stream-check.ps1`.
- Setup `scripts\setup.ps1` · run `scripts\dev.ps1` · offline checks `scripts\check.ps1` · live read-only check `scripts\live-check.ps1` (user runs; needs `backend\.env`).
- Never read or print `backend/.env`. Live tests are opt-in (`-m live`, `NSE_LIVE_TESTS=1`).

## Skills (load when relevant)
[implement-feature](.claude/skills/implement-feature/SKILL.md) · [debug-system](.claude/skills/debug-system/SKILL.md) · [review-code](.claude/skills/review-code/SKILL.md) · [validate-financial-math](.claude/skills/validate-financial-math/SKILL.md) · [verify-market-data](.claude/skills/verify-market-data/SKILL.md) · [build-widget](.claude/skills/build-widget/SKILL.md) · [verify-quant](.claude/skills/verify-quant/SKILL.md) · [test-dashboard](.claude/skills/test-dashboard/SKILL.md) · [debug-live-data](.claude/skills/debug-live-data/SKILL.md)

## Context efficiency
- Read only relevant files; resume from `docs/current-state.md`, not by rereading the repo.
- Keep reports concise; don't duplicate rules stored in specialized files; no agents for simple tasks.

## Definition of done
Acceptance criteria met, relevant tests run (or explicitly reported as not run), documentation and current-state updated, known limitations stated.
