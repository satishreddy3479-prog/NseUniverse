---
name: debug-system
description: Disciplined debugging workflow for NSE Universe failures, including broker API, streaming, data, and UI issues. Use when something is broken or behaves unexpectedly.
---
# Debug a failure
1. **Reproduce** — exact steps, inputs, environment (laptop/Codespaces/server). Note if it is intermittent.
2. **Collect evidence** — relevant logs, messages, timestamps (redact secrets).
3. **Find the failing boundary** — UI ↔ backend ↔ broker SDK ↔ network ↔ storage; bisect which side is wrong.
4. **Hypotheses** — list candidates; test each with a minimal experiment; discard with evidence.
5. **Check SDK/API documentation** before assuming external behavior; record what the docs say and what was observed.
6. **Fix the root cause**, not the symptom.
7. **Add a regression test** that fails before and passes after.
8. **Verify** — rerun the reproduction and relevant tests; state what was not verified.
9. **Document** remaining uncertainty and update `docs/current-state.md` if relevant.
