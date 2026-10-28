---
name: test-dashboard
description: Run and report the right checks after a frontend or API change in NSE Universe (targeted tests, type check, build, backend suite, UI states). Use after changing dashboard code, widgets, API routes or stored-data handling.
---
# Test a dashboard change
Never say a test passed unless you ran it and saw the result. Report exact commands and outcomes. Live-broker tests (`-m live`) need user authorisation and credentials; never run them yourself.

1. **Look at what exists:** `frontend/package.json` scripts (`typecheck`, `test`, `build`), `backend/pyproject.toml`, `scripts/check.ps1` (the whole offline suite on Windows).
2. **Targeted first.** Frontend: `cd frontend && npx vitest run src/test/<file>`. Backend: `cd backend && python -m pytest -q tests/unit/<file>`. Fix failures before widening.
3. **Then everything relevant:**
   - Frontend: `npx tsc -b`, `npx vitest run`, `npm run build` (watch the chunk sizes).
   - Backend: `python -m ruff check .`, `python -m ruff format --check .`, `python -m mypy app`, `python -m pytest -q`.
   - Windows one-shot: `powershell -ExecutionPolicy Bypass -File scripts\check.ps1`.
4. **Behaviour, not just green tests.** With the app running (or the replay backend of real payloads), open the page and check: loading, no-snapshot, empty/insufficient history, identical-values note, stale vs live labels, API error, CE/PE toggles, strike selection, add/remove/reset widgets, narrow width. Check the API response for the changed route directly.
5. **Regressions:** list components and routes sharing the changed code (ChainTable is used by Option chain, Data & sessions and the dashboard; `liveStore` by everything live) and run their tests.
6. **Distinguish** pre-existing failures from new ones; do not weaken or delete a test to pass.
7. **Report:** commands run, pass/fail counts, what was not run and why, remaining risks.

Done when the relevant suites pass, the UI states were observed, and the report matches what was actually executed.
