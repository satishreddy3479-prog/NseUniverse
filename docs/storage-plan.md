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


## Server audit of 29 Oct 2026 and the plan from it

Source: the owner's read-only audit of the server (Claude cannot reach it: SSH is blocked from its environment). Disk 19 GB, 5.9 GB used,
12 GB free (33 %); RAM 969 MB, 539 MB available; swap 1 GB unused. Application data is 180 MB: `observations.sqlite3` 3.5 MB,
`market.sqlite3` 3 MB (+1.1 MB WAL), snapshots and archives 18 MB, user caches 136 MB. Everything else is operating system,
packages and build tooling (about 5.7 GB) that the app does not control.

### What grows (per trading day; per-component estimates, to be re-measured on the server after a week)
| Component | Per day | Per year | Rule |
|---|---|---|---|
| Observation DB (`observations.sqlite3`) | 5.5 MB | 1.4 GB | kept forever; replay, paper trading and research read it |
| Verified archive (`archive/`, `manifests/`) | 1.4 MB | 0.35 GB | kept forever; the only off-DB copy of each day |
| `intraday.sqlite3` (scores, daily summaries, `if-2` feature rows) | ~1.7 MB | ~0.45 GB | immutable, kept |
| `market.sqlite3` (minute breadth/flow/futures recordings, lists, weights, daily bars) | ~1.3 MB | ~0.4 GB | append-only, kept |
| Snapshot files (raw + normalized) | 16 MB | 0 net | **pruned**: raw 7 days, normalized 14 days, verified-archive days only; steady state about 0.2 GB |
| Other databases (prices, flows, forecasts, news) | <0.1 MB | <50 MB | kept |
| Backups (`/var/backups/nse-universe`, 14 daily folders, observation DB weekly) | grows with the DBs | about 2.5 GB per year of data held | **the next real risk**, see below |

Permanent data grows about 2.6 GB a year. The backups keep 14 daily gzip copies of every database except the observation DB (weekly), so
they grow in step with the databases and, at today's rule, would match the data itself within a year (rough estimate: 2.5 GB per year of
history). Usable space is 12 GB minus the 2 GB where the sampler pauses, so the current rules last about 1.8 years, not 3.

### Plan (owner approval needed only where marked)
1. **Now:** nothing to delete. Retention for snapshot files is already on (D58). Keep observations, archives and the ledgers forever.
2. **Verify the backups exist** (the audit does not list `/var/backups/nse-universe`): run `ls -la /var/backups/nse-universe` and `systemctl list-timers | grep -i nse`. If missing, backups are not running.
3. **Change backup retention (approval):** daily copies for 7 days plus one weekly copy for 4 weeks plus one monthly copy for 6 months instead of 14 daily folders; observation DB stays weekly with 2 copies. This roughly halves backup growth. Only backup copies are removed, never stored market data.
4. **Off-server copy (approval, your PC or any storage you control):** copy `archive/`, `manifests/` and the newest backup monthly. The raw payloads are not backed up anywhere, and a single disk is the only copy of the research data.
5. **Do not trim the observation DB:** the replay, paper-trading and research views read it directly, so deleting old rows would break them for those sessions. At 1.4 GB a year it is affordable.
6. **Reserve for later (approval, only if free space < 5 GB):** compact the `if-2` feature rows of sessions older than 90 days to every 5th sample; move the oldest `market.sqlite3` minute recordings into the verified archive format.
7. **Thresholds:** `/api/storage/status` pressure: watch below 6 GB free, low below 4 GB, critical below 2.5 GB; the sampler pauses at 2 GB. Check the storage card after the first full week and re-measure the table above.
8. **Housekeeping the app does not own (optional, owner decides, about 0.6 GB):** `apt clean` (153 MB), old disabled snap revisions (174 MB), journal size cap (81 MB), `/opt/nse-universe/cache` build cache (253 MB) and user caches (136 MB). None is needed today.
9. **Pending security reboot:** the running kernel (5.15.0-46) is older than the installed one (-198); reboot after 16:00 on a trading day and confirm the service returns.

## Intraday data handling plan (30 Oct 2026) - keep what the ML needs, drop the rest after the nightly job

Trigger: charts showed yesterday's data and two corrupt contract values (22100 CE OI 2.23e17, 24800 CE OI 8.4e18) that broke PCR and OI-change charts.
**Nothing below is deleted without owner approval; code changes in this step only change how stored values are read.**

### Three phases of the day

| Phase | What is kept | Why |
|---|---|---|
| Market hours (09:15-15:30) | Snapshots every 60 s to the observation DB (needed for live charts and the intraday model's features) | Intraday ML and the dashboard read these |
| 15:50 EOD job | Verified daily archive of the day; intraday model trains on the day's feature rows, labels from the 1-minute spot path; scores and summary appended | Training is done once, after close |
| After the job (approval needed) | Keep: feature rows, labels, 1-min spot path, scores, daily summary, verified archive. Drop (after archive verified): raw payloads, normalized snapshots, per-contract observation rows older than the chart window | These are re-derivable from the archive or no longer read |

### What each consumer needs

| Consumer | Needs | Retain |
|---|---|---|
| Intraday ML training | feature rows (append-only), labels, 1-min spot path | forever (small) |
| Forward test / audit | scores, forecast ledger | forever (append-only) |
| Dashboard charts | today's per-contract rows | today + previous session only |
| Research / backtests | verified daily archive | forever (about 2.6 GB a year) |

### Integrity rules added today
- Ingest: any price/OI/volume value of 2**53 or more is flagged invalid and stored as missing (`parse_number`).
- Read: already-stored values of 2**53 or more read as missing (`ObservationStore.contracts`); stored rows are not modified. Tests use the two real cases.
- Premium decay is measured from the first sample of each IST day, never across the overnight gap.

### Approvals needed
1. Delete per-contract rows older than 2 sessions once their daily archive is verified (est. saves ~5 MB/day of growth).
2. Backup retention change already listed above.
Measured on the server: data 47-50 MB, growth about 7.5 MB/day, 12 GB free; at this rate the full-keep policy still has years of room, so approvals 1-2 are optional tidy-ups, not urgent.
