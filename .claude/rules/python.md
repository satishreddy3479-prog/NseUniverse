---
paths:
  - "backend/**/*.py"
  - "tests/**/*.py"
  - "scripts/**/*.py"
---
# Python rules
- **Versions:** target Python 3.11+ (open question: confirm server version in [decisions](../../docs/decisions.md)); avoid features unavailable on the production server.
- **Style:** type hints on all public functions; PEP 8; one formatter + linter (proposed: ruff) configured in `pyproject.toml`; run mypy/pyright if adopted.
- **Design:** small focused modules; I/O (broker, DB, network) behind interfaces so logic is testable; typed models (e.g. pydantic/dataclasses) for data contracts; no duplicated logic.
- **Errors:** raise specific exceptions with context; never swallow exceptions; no bare `except`; do not return fake defaults on failure.
- **Logging:** `logging` with structured fields; never log secrets or full auth payloads; log reconnects, subscription state, data gaps.
- **Config:** read from environment/config objects at startup; no hard-coded credentials or paths; provide `.env.example` with placeholders only.
- **Dependencies:** pin versions; add only when justified; record the reason in the PR/decisions.
- **Async/concurrency:** one clear owner per connection/task; handle cancellation and shutdown.
- **Resources:** production server is low-resource — bound queues/buffers, avoid loading large datasets in memory, avoid busy loops.
- **Tests:** every new module gets unit tests; see [testing](testing.md).
