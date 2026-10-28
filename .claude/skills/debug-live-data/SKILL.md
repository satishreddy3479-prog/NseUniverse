---
name: debug-live-data
description: Diagnose wrong, missing or stale option-chain and market data in NSE Universe from the Kotak provider through backend, storage, API and UI. Use when numbers are missing, stale, mismatched or the live stream or sampler misbehaves.
---
# Debug market data, source to screen
General method is in `debug-system`; source and mapping checks are in `verify-market-data`. This skill is the data-path checklist.

1. **Reproduce and name the symptom** (which widget/field, which expiry, what time, live or snapshot). Check the header signals first: Broker, Snapshot, Stream, Market, Data.
2. **Trace the path:** Kotak SDK (`broker/kotak.py`) -> `domain/normalize.py` -> `storage/store.py` (gzip JSON + `data/index.sqlite3`) -> `services/` (snapshot, history, sampler) -> `api/routes.py` / `ws.py` -> `lib/api.ts`, `liveStore.ts` -> `DashContext`/components. Find the first stage where the value is wrong, comparing the stored raw payload (`data/snapshots/<date>/*.raw.json.gz`) with the normalised snapshot and the screen.
3. **Check the usual suspects:** expiry selection (weekly vs monthly, roll to next month); time zones (stored UTC, shown IST, session 09:15-15:30 IST); values arriving as strings; missing fields (stay `None`, never 0); OI change = current - previous-day OI; units (OI/volume in units, lot 65); ATM from live spot vs broker label; snapshot age vs stale threshold; live overlay applied only while the stream is `streaming`; throttled aggregate refresh (400 ms).
4. **Logs and status:** `logs/` (redacted JSON), `GET /api/status`, `/api/stream/status`, `/api/sampler/status`, `/api/errors`. Never print `.env` or tokens.
5. **Provider vs application:** reproduce with a stored real payload (replay). If the raw payload is already wrong or empty, it is the provider or session; if raw is right and output wrong, it is our bug. Market closed means the stream cannot be tested; say so.
6. **Caching/refresh:** expiry cache (10 min), history cache per snapshot id, React Query refetch intervals, sampler skips unchanged chains.
7. **Never fill gaps with invented numbers.** If something must be simulated for a test, label it and keep it out of the app; prefer real captured fixtures.
8. **Fix the root cause**, add a regression test using a real fixture, rerun the reproduction and the suites (`test-dashboard`).

Done when the original symptom is reproduced, explained at a specific stage, fixed, covered by a test, and verified; unverifiable parts (live market hours) are stated.
