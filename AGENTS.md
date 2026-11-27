# Instructions for AI coding agents

This file is for any AI tool (Claude Code, Codex, Cursor, Copilot and others). The single source of truth is [CLAUDE.md](CLAUDE.md): read it first, it is one page. Do not copy its rules here; follow it.

## Read in this order

1. [CLAUDE.md](CLAUDE.md): identity, architecture principles, the financial-data rules, commands, definition of done.
2. [docs/requirements.md](docs/requirements.md): what the owner wants, what is out of scope, and how the owner wants you to work (when to commit, push, deploy; how to report).
3. [docs/current-state.md](docs/current-state.md): what is built, live and unverified (newest section first). Resume from here; do not re-read the whole repository.
4. [docs/code-map.md](docs/code-map.md) and [docs/glossary.md](docs/glossary.md): which folder or file to open for a change, and what the project's terms mean.
5. [.claude/rules/](.claude/rules/): `financial-data.md`, `security.md`, `testing.md`, `python.md`, `frontend-ui.md`.
6. [docs/decisions.md](docs/decisions.md): search it (`D###`) before changing behaviour that looks odd; it usually says why.
7. [.claude/skills/](.claude/skills/): step-by-step recipes (implement a feature, debug live data, verify a calculation, build a widget, review code, test the dashboard). Each folder has a `SKILL.md`.

## Never, without the owner's explicit say-so

- Place or simulate sending an order to a broker, or add a broker call that changes anything. The product is read-only.
- Read, print, log or commit `backend/.env` or any credential.
- Commit, push or deploy. The server deploys whatever reaches `main` within about a minute, so a push is a production release (the deploy guard holds it during market hours).
- Delete stored data, or run a destructive command.
- Invent market data, add a mock or demo mode, or fill a missing value with zero.

## Working rules

- Read the code you will change before changing it. Small, focused changes; no new dependency or abstraction without a reason.
- Every formula gets a test built from real captured data with an independent hand calculation (see `testing.md` and `backend/tests/fixtures`). Never weaken a test to make it pass.
- Run the checks before saying a change is done (commands are in the README): backend `pytest`, `ruff`, `mypy`; frontend `vitest`, `tsc -b`, `vite build`. If something was not run, say so.
- Say plainly what is not verified. A calculation is "validated" only when an independent check exists.
- After meaningful work, update `docs/current-state.md` and add a `D###` entry to `docs/decisions.md` (the last entry shows the format and the next number). Record unpushed work in `docs/pending-push.md`.
- The development machine is Windows 11, the production server is Linux: no OS-specific code without need, and mind CRLF line endings in existing files.
