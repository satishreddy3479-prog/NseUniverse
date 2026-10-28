---
name: implement-feature
description: Workflow for implementing a feature in NSE Universe from requirements through tests and documentation. Use when asked to build or extend functionality.
---
# Implement a feature
1. **Inspect** `docs/current-state.md`, then only the code relevant to the feature.
2. **Clarify acceptance criteria** — write them down; ask the user if ambiguous. Confirm the feature is in scope (see CLAUDE.md out-of-scope list).
3. **Identify rules** — apply `.claude/rules/*` matching the files you will touch (python, frontend-ui, financial-data, security, testing).
4. **Plan** — short plan (files, data contracts, tests). Get approval for substantial or risky changes.
5. **Implement incrementally** — small steps; keep tests alongside code.
6. **Run tests** — lint, type-check, relevant unit tests. Live integration tests only if the user authorizes.
7. **Review** — self-review the diff (use the review-code skill for large changes); check for secrets.
8. **Update docs** — `docs/current-state.md` (and decisions/architecture if changed).
9. **Report** — what changed, tests run and not run, unresolved issues. Do not commit/push unless authorized.
