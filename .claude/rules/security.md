---
paths:
  - "**/*"
---
# Security rules
- **Secrets:** only in environment variables or a secrets manager; never in source, docs, logs, tests, or commits. Provide `.env.example` with placeholders.
- **Git:** `.env`, token/session files and credentials are git-ignored; check `git diff --staged` for secrets before any commit; if a secret is committed, stop and tell the user to rotate it.
- **Auth:** backend authenticates users/clients before exposing data or WebSocket; broker session tokens stay server-side.
- **Logging:** redact tokens, passwords, TOTP/OTP, API keys, account identifiers.
- **Input validation:** validate all API/WebSocket input (types, ranges, allowed values) at the boundary.
- **CORS/WebSocket:** explicit allowed origins; no wildcard in production; validate Origin on WebSocket upgrade.
- **Errors:** safe messages to clients; details in server logs only.
- **Dependencies:** pin, review before adding, run audit tools (pip-audit / npm audit) periodically.
- **Production:** server pulls approved commits (server-first model); Claude never deploys, SSHes to, or alters the server without explicit user request; no dev tooling or debug mode in production.
- **Auto-deploy:** server uses a read-only deploy key/token, non-root deploy user, deploys only approved refs (reviewed `main` merge or owner tag), verifies before switching, and rolls back on failed health check. Production secrets live on the server only, never in the repo.
- **Frontend:** no credentials in bundles.
- **Trading:** no order placement/modification code unless separately authorized.
