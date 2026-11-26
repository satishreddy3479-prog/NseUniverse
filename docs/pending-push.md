# Waiting for the owner to push (after 15:40 IST)

- 26 Nov 2026: open-of-day fixes (D321): day board 500 on the first minutes of a session, today as the session from 09:15, one refresh of the whole app at the open. Committed locally in the deploy clone, not pushed (market hours).
- Already pushed and held by the server's market-hours guard until 15:50 IST: `ef42621` (always-latest-build check, Eagles picker add/remove toggle).
- 26 Nov 2026: D322 event-loop stall fixes (SDK per-packet logging, tick compare, market sample in a thread). Committed locally, not pushed (market hours). Safe to push after 15:40; it restarts the backend, so only outside market hours.
- 26 Nov 2026: D323 Strategy Builder what-if sliders (frontend only). Committed locally, not pushed.
- 26 Nov 2026: D324 premium-speed study files and D325 Premium Change tool (frontend only: lib, board, tool entry, Learn lesson, tests). Committed locally, not pushed.
- 26 Nov 2026: D326 global futures live price from Yahoo's chart answer (backend). Committed locally, not pushed.
- 26 Nov 2026: D327 Eagles view saved layout no longer hidden by an untouched working copy (frontend). Committed locally, not pushed.
