---
paths:
  - "tests/**"
  - "backend/**"
  - "frontend/**"
---
# Testing rules
- **Layers:** unit (pure logic), integration (components with mocked services), live integration (real broker, opt-in via marker/env, never in default runs), end-to-end (UI + backend with mocked feed).
- **External services:** mock broker/SDK in unit and integration tests; mocked tests never count as evidence the live integration works.
- **Isolation:** no shared mutable state, no network, no wall-clock dependence (inject clocks), temp dirs for files.
- **Financial tests:** known examples with hand-computed or authoritative expected values, boundary cases (zero/missing, expiry day, deep ITM/OTM), tolerance stated.
- **Frontend:** component tests for tables/states; type-check (`tsc --noEmit`) and build must pass.
- **Backend:** lint, type-check and test suite must pass before claiming completion.
- **Reporting:** state exactly which commands were run and results; list skipped/unrun tests and why. Never fabricate results.
- **Integrity:** fix the cause; never delete/loosen/skip tests merely to get green.
