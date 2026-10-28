# Development workflow (laptop ↔ Codespaces)
**Current stage: local-only.** Build on the laptop first. Do not create a GitHub remote, push, or use Codespaces/server deploy until the user says the local build is complete (see decisions #13). The sections below describe the workflow for after that point.

GitHub is the source of truth. Laptop and Codespaces do **not** sync files, env vars, terminals or dependencies automatically.

## Start work
1. `git status` — see uncommitted changes and branch.
2. `git fetch` then `git pull --ff-only` (or rebase after review) to update from GitHub.
3. Read `docs/current-state.md`.
4. Create/switch to a feature branch.

## Before committing
Run lint, type-check and tests (see [testing rules](../.claude/rules/testing.md)); check `git diff --staged` for secrets; update `docs/current-state.md`.

## Commit and push
`git add <specific files>`, `git commit`, `git push`. Only when you (the user) have authorized it.

## Switching environments
Before leaving an environment, commit (or `git stash`) and push your branch. In the other environment, pull the branch. Never leave important work only uncommitted on one machine.

## Environment-specific setup
Each environment needs its own `.env` (copy from `.env.example`) and dependency install. Secrets are never committed; in Codespaces use Codespaces secrets.

## Avoid
Force-push, `reset --hard`, and other destructive commands as routine; separate divergent implementations per environment.

## Production (server-first, proposed)
GitHub holds source only. The Linux server pulls and deploys **approved** commits automatically (see [architecture](architecture.md#server-first-deployment-model-proposed--not-built-server-not-modified)). Consequences for development:
- Merging to the approved branch (or tagging a release) **is** the deploy action — treat it as production-impacting; run all checks first.
- Work on feature branches; nothing on a feature branch is deployed.
- Claude Code never deploys, SSHes to, or changes the server unless the user explicitly asks; Claude only changes repo files.
- Never edit production directly; hotfix through the same branch → approval → auto-deploy path.
