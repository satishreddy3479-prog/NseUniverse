# Data library: bundles to download, and temporary restore for backtests (plan, 22 Nov 2026)

**Status: built on 22 Nov 2026 (D246), not yet deployed.** The owner approved the plan, step 5 (pruning waits for the bundle), a scratch store on the server and the automatic bundles; how it was built is at the end of this file. The change made first: the server keeps raw broker responses and normalized snapshot files for **30 days** (was 7 and 14); `SNAPSHOT_RAW_KEEP_DAYS` and `SNAPSHOT_NORMALIZED_KEEP_DAYS` in `/etc/nse-universe/backend.env`, the old file saved as `/var/backups/backend.env.before-retention-2026-11-22`.

## What is hot, what ages out, and what a backtest actually reads
| Data | Where | Aged out? | Read by backtests and research? |
|---|---|---|---|
| Every contract, every minute (`observations.sqlite3`) | server, forever | **No.** Row pruning exists but is a dry run and is not approved | **Yes: this is the research data** |
| Verified daily archive (`archive/`, `manifests/`) | server, forever (23 MB, 1.35 MB a day) | No | Yes (rebuilds the database rows of a session) |
| Scores, summaries, minute breadth, flows, prices, swing book | server databases, forever | No | Yes |
| Raw broker responses, normalized snapshot files | server, **30 days**, then deleted | Yes | **No.** Only a few fields exist nowhere else: per-contract day high/low, the at-the-money label, the original text |

So today **no backtest needs anything restored**: all the research data is on the server for good. A restore is needed only for (a) the snapshot files after 30 days, (b) the observation rows of old sessions if row pruning is ever switched on, and (c) a disaster. The plan below covers all three with one mechanism, so the rule "check that the data is there before a backtest, and restore it temporarily if not" works now and later.

## 1. Data library page (read-only first)
A new tab on the Data page: one row per session (date, expiry, samples, contract rows, archive file and checksum, snapshot files on the server, last exported). A state per row: **hot** (on the server), **exported** (a bundle was downloaded and confirmed), **cold only** (removed from the server, exists only in a bundle). Nothing is deleted by this page.

## 2. Bundles: a zip of aged data, downloaded from the app
- Pick a month or a date range, tick what to include: snapshot files (raw, normalized), the archive files, the manifests. The server builds `nse-universe-bundle-YYYY-MM-DD_to_YYYY-MM-DD.zip` in a scratch folder, streaming file by file (the server has 1 GB of memory: never held in memory), with a `MANIFEST.json` (every file, size, SHA-256, the session and expiry it belongs to, app version, build time). The snapshot files are already gzip, so the zip stores them as they are (no re-compression): about 7 MB per trading day with one expiry (about 150 MB a month), 15 MB with two.
- The browser downloads it from the page (behind the site login, like every page). The page computes the SHA-256 of what it received and sends it back; the server compares it with its own and records "exported" for those days only if they match. That is the proof that a copy exists off the server, and it replaces the guess behind the weekly `pull-backups.ps1`.
- The scratch zip is deleted after the download is confirmed (or after 24 hours). Limits: one bundle at a time, 1 GB at most, refused when free space would fall under 6 GB.
- Optional later: the server builds a monthly bundle by itself on the 1st for the month that has just left the 30-day window, and shows "ready to download" with a reminder until it is confirmed.

## 3. Pruning waits for the export (needs approval, as it changes a deletion rule)
A day's snapshot files are deleted after 30 days **and** after that day is marked exported, with a hard stop at 60 days or when free space is under 6 GB (then they go anyway, with a warning on the page and in the heads-up strip). The weekly `pull-backups.ps1` can write the same marker, so either route counts.

## 4. Temporary restore for a backtest
**The check (before any backtest):** each backtest declares what it needs: instrument, expiry or expiries, session range, and the kind of data (observation rows, snapshot files, minute breadth). The runner compares that with the library: all hot, run as now; something cold or missing, the page lists exactly which sessions and in which bundle (by the manifest), and does not run on a partial range or fill a gap with anything.

**The restore:** "Restore for a backtest" takes the bundle zip (uploaded in the page, streamed to disk in pieces, or placed in `data/restore/inbox/` by `scp`), then:
1. Verifies every file against `MANIFEST.json` (size and SHA-256) and the archive against its own checksums; one bad file stops it and nothing is kept.
2. Checks disk: needs 2 x the unpacked size free above the 6 GB floor; a restore is capped at 1 GB.
3. Unpacks into a **scratch store**, `data/restore/<id>/`, as its own SQLite file. It never writes into the production databases and never overwrites a session that is already hot.
4. The backtest reads the hot data plus the scratch store through one read-only view (the same functions, an extra source), so results match what the live data would have given.
5. Not during market hours (09:15 to 15:45 IST), the same rule as for model work; the restore itself is a low-priority job.
6. The scratch store is deleted when the backtest is closed or after 24 hours (a button keeps it up to 7 days), and the page shows its size and expiry. The audit log records the restore and the removal.

**Disaster restore** (the live data is gone): the same bundles, plus the nightly database backups, rebuild the server; the steps are written down and tried once on a scratch server before they are needed.

## 5. Where bundles live
The bundle on your PC is then the only copy of aged data: keep it in `S:\NseUniverse-backups\bundles\`, and once a month copy that folder and the newest database backup to a second place (cloud drive or USB). The library page lists the bundles it has seen confirmed, so a missing month is visible.

## Build order (each step shippable alone)
1. Library page, read-only (sessions, sizes, states). Small.
2. Bundle build + download + confirm (marker only, no deletion change). Medium.
3. Data-needs declaration and the coverage check on the backtest pages. Small to medium; **useful at once**, since it also guards against a gap in the live data.
4. Temporary restore into a scratch store with the read-only view. Largest; tested on a copy of real sessions and on the server.
5. Pruning waits for the export, with the hard stop. Small, but needs approval.

## Decisions for the owner
1. Bundle contents: snapshot files and archive, or also database exports (scores, breadth)? (I suggest snapshot files + archive + manifests; the databases are in the nightly backups.)
2. Approve step 5 (delete only after export, hard stop at 60 days or 6 GB free).
3. Is a scratch store on the server (up to 1 GB, 24 hours) acceptable, or should restores happen only on the PC?
4. Monthly automatic bundle on the 1st: yes or no.


## As built (D246)
- **Automatic, after the close** (inside the end-of-day run, off market hours): expire restores that ran out, register bundles found on disk, drop downloaded bundles older than 90 days (a bundle never downloaded is never dropped), and zip the snapshot days that are 25 days old (5 days before their files would be deleted) into one verified bundle when 7 days are due or the oldest is within 2 days of deletion (weekly in practice, about 35 MB). The pruning then deletes a day's loose files only when the day is inside a bundle that is on the server with its recorded size; it also deletes at 60 days or when free space is under 6 GB so a failing bundle cannot fill the disk. The manual clean-up page waits for the bundle the same way.
- **Off-server copy, automatic when the PC runs it:** `scripts\pull-backups.ps1` now also copies every bundle that has not been downloaded, compares its SHA-256 with the server's and, only if it matches, confirms it to the server (the same confirmation the Data page's download button makes). To run it every evening: `schtasks /Create /SC DAILY /ST 20:00 /TN "NSE Universe pull" /TR "powershell -NoProfile -ExecutionPolicy Bypass -File S:\Nseuniverse\scripts\pull-backups.ps1"` (needs your PC on and `ssh nse-server` working).
- **Data page, "Data library":** bundles with the copy status, download (checksum verified in the browser before it is saved, then confirmed), restore, remove (only after a confirmed download), make a bundle of chosen days, temporary restores (keep 7 days / remove), restore from a file on your computer (streamed, 1 GB limit), and a table of every stored session saying where its files are.
- **Temporary restore, automatic and manual:** a restore unpacks a verified bundle into `data/restore/<id>/` (never into the live data, never over an existing file, only the three known folders, 1 GB in all, 24 hours). When anything asks for a snapshot file that is not on the server, the reader looks in the active restores and, if a bundle holds that day, restores it by itself. The restore goes when it expires.
- **Backtest check:** the signal backtest answer carries `data_coverage` (sessions with fewer than 300 stored samples, days whose snapshot files are only in a bundle); the page shows a warning when something is missing.
- **Settings** (`backend.env`, all optional): `LIBRARY_ENABLED`, `LIBRARY_MIN_BATCH_DAYS` (7), `LIBRARY_BUNDLE_KEEP_DAYS` (90), `LIBRARY_RESTORE_TTL_HOURS` (24), `LIBRARY_RESTORE_MAX_MB` (1024), `LIBRARY_MIN_FREE_GB` (6), `LIBRARY_HARD_STOP_DAYS` (60).
- **API:** `GET /api/library/status`, `POST /api/library/bundles`, `GET /api/library/bundles/{id}/download`, `POST .../confirm`, `DELETE /api/library/bundles/{id}`, `POST /api/library/restore`, `PUT /api/library/restore/upload`, `DELETE|POST /api/library/restore/{id}[/keep]`, `GET /api/library/coverage`. Changing state is accepted from the local machine only, like the other control endpoints.
