# Data and storage plan

Applies to the Linux server (15 GB SSD, 1 GB RAM) first and to the Windows PC second. The server is the
production collector; the PC is for development. Nothing in this plan deletes data that cannot be
rebuilt unless the owner has approved that exact rule (see "Approvals").

## What a trading day produces (measured 2026-10-29, scaled to a full 09:15-15:30 session)

| Item | Per sample | Per day (~750 samples, 2 expiries) | Per year (250 days) |
|---|---|---|---|
| Snapshot files (verbatim broker payload ~31 KB + normalized ~10 KB per fetch, gzip) | ~22 KB | ~16 MB | ~4 GB |
| Observation database (SQLite, per-contract LTP/OI/volume) | ~7 KB | ~5.5 MB | ~1.4 GB |
| Verified compressed archive of the same observations | ~1.8 KB | ~1.4 MB | ~0.35 GB |
| Daily summary + close-of-day chain (permanent, per expiry) | - | ~15 KB | ~4 MB |
| Everything else (prices, flows, forecasts, news, scores, manifests) | - | < 0.1 MB | < 50 MB |

About 80 % of growth is the raw snapshot files. The compressed archive holds the same research values
(spot, previous close, LTP, OI, previous-day OI, volume per contract per sample) at about 7 % of the size.

## Server budget (15 GB)

Roughly: operating system and packages 4-5 GB, application (virtual environment, one node-modules cache,
a few releases) about 1.5 GB, 1 GB swap file, leaving about 7 GB. The sampler pauses below 2 GB free, so
about 5 GB is usable for data.

| Policy | Data on disk after 1 year | After 3 years |
|---|---|---|
| Keep everything (today's behaviour) | ~6 GB | full disk |
| Keep raw payloads 14 days, normalized 30 days; observations DB and archive forever | ~2.2 GB | ~4 GB |
| Same, observation DB trimmed to 120 days live (archive keeps the rest) | ~1.2 GB | ~1.5 GB |

## Tiers by value

1. **Permanent and tiny - never deleted:** forecast ledger, score ledger, daily summaries with the close-of-day
   option chain, session manifests, daily price history, news, flows (rolling windows by approved policy).
2. **Permanent and compact:** the observation database and the verified daily archive. These are the
   irreplaceable intraday research data: Kotak does not provide historical option chains.
3. **Short-lived and bulky:** verbatim broker payloads (`*.raw.json.gz`) and normalized snapshot files.
   They duplicate tier 2 except for fields the archive does not carry (per-contract day OHLC, moneyness
   label, the original response text). Retention is configurable and **off by default**.
4. **Disposable:** old backup folders, files in `exports/` older than 14 days, stray `*.tmp`.

## Daily timeline (IST)

| Time | Job | Writes | Deletes |
|---|---|---|---|
| 08:30 | broker sign-in | session | - |
| 08:35-09:10 | T+1/T+5 forecasts recorded | forecast ledger | - |
| 09:15-15:30 | sampler, scores each minute | observations, snapshots, scores | - |
| 09:15-15:45 | **no model training or evaluation** | - | - |
| after 15:45 | validate day, archive (verified), summaries, manifest | archive, summaries, manifest | - |
| after 15:45 | optional pruning of old snapshot day folders | - | only what the approved limits allow, after the archive is re-verified |
| after 18:30 | daily prices, then T+1/T+5 retrain on the new final bar | prices, report cache | - |
| after 19:00 | WAL checkpoint, backup (PC) or server timer (`deploy/backup.sh`), tidy | backups | old backups, old exports, `*.tmp` |

A day missed because the machine was off is caught up, oldest first, at the next run.

## Safety rules the code enforces

- A day gets a manifest only when its archive was written to a temporary file, flushed, renamed, read back,
  checksummed and compared with the database row counts. Otherwise nothing is recorded and it is retried.
- The archive is a copy: no row is removed from the observation database by this plan.
- Pruning (when enabled) removes whole snapshot day folders only if the manifest exists, the archive is
  re-verified at that moment, and every snapshot in the folder is present in the observation store; index
  rows stay and a missing file reads as "removed by retention", not as an error.
- Backups: online SQLite backup, `quick_check`, gzip, checksums; older folders are removed only after the
  newest backup verified and only dated backup folders are ever touched. The observation database is copied
  weekly on the server because its content is also in the archive.
- The model code cannot import any of this (`tests/unit/test_no_intraday_leak.py`).

## Approvals

| Rule | State |
|---|---|
| Remove expired backup folders, old `exports/` files, stray `*.tmp` | in force (regenerable) |
| Remove raw payloads / normalized snapshot files after N days | **enabled 29 Oct (D58)**: raw 7 days, normalized 14 days, only days with a verified archive; set the env vars to 0 to disable |
| Trim the observation database | **not enabled, not implemented** |

## Status and restore

`GET /api/storage/status` and Settings -> Storage show sizes per category, growth, runway, backups, the last
end-of-day run and the pruning dry run. Restore: stop the app, decompress the wanted backup
(`gunzip observations.sqlite3.gz`), place it in the data directory, start the app; archives can be
re-imported by reading the JSONL lines (`t=sample` rows, then their `t=c` contract rows).

## Not built yet

Daily research report, Parquet format (not needed at this size), intraday ML targets and training (needs 60
complete sessions), automatic off-server copy of the archive (recommended: copy `archive/` and `manifests/`
off the server weekly).
