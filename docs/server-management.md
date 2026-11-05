# Server Management Centre

System menu → **Server Management Centre** (route `/server`, sections as tabs). It replaces the old "Data clean-up" menu entry; the clean-up itself is unchanged and lives inside **Maintenance** (the old `/cleanup` route still works).

Status of this document: written with the code, **before any production deployment**. Everything under "Verified in development" was tested on a Windows development machine with temporary folders; everything under "Needs production verification" has not been run on the Ubuntu server.

## What it does

| Tab | Content | Source |
|---|---|---|
| Overview | CPU, load, memory, swap, disk, uptime, health, NSE sizes, daily change, 7/30-day average growth, forecast, open alerts | live samples + stored snapshots |
| Storage analytics | daily table (sort, search, date range, pagination, CSV), trend and daily-change charts, forecast, snapshot detail, two-date comparison, missing dates | daily snapshots |
| Filesystem | browse the three approved areas, sizes, protected flags, largest files | bounded live walk + last snapshot |
| CPU and RAM | history 1 h to 30 d, load, network and disk rates, top processes | metric samples |
| Processes | name, owner id, state, memory, lifetime CPU | /proc (no command lines) |
| Logs | files of the application log directory, level filter, text search, older lines, secrets masked | log files |
| Services | state of an approved list, application health, helper status, last restart result | `systemctl show` (fixed argv) |
| Jobs | collector runs, daily-price downloader status | module DB, existing service |
| Cache | regenerable items with sizes; the project `cache/` folder is measured only | existing storage rules + snapshots |
| Releases | active release, releases with sizes | `current` link, `releases/` |
| Maintenance | scan now, refresh metrics, retention cleanup (preview, then confirm), restart service (confirm, via helper), diagnostic bundle, CSV export, the existing Data clean-up | see below |
| Alerts, Audit, Configuration | alert history, every action (also refused ones), validated settings | module DB |

## Architecture

* **Backend** `backend/app/servermgmt/`: `config.py` (validated settings), `store.py` (own SQLite file `server_mgmt.sqlite3` in the data directory), `metrics.py` (/proc readers, standard library only), `scan.py` (bounded walk, path rules), `service.py` (snapshots, growth, forecast, alerts, scheduler), `ops.py` (logs, services, health, helper hand-off, releases), `api.py` (`/api/server/...`). Wired in `app/main.py` (`build_servermgmt`).
* **Own database, not the trading stores.** It is bounded by retention and may be pruned; nothing in it is evidence the trading side depends on. Growth: about 290 small sample rows a day and one snapshot (about 600 file rows) a day, a few hundred KB per month; the size is shown on the Overview.
* **Frontend** `pages/ServerManagement.tsx`, `components/servermgmt/*`, client `lib/serverApi.ts`.
* **Scheduler** inside the backend (an asyncio task, started with the app): a metric sample every `sample_interval_s` (default 300), the daily snapshot at `daily_snapshot_hour:minute` IST (default 18:45), with catch-up if the app was down at that time. A browser refresh never starts a scan.

### Areas and double counting

Three approved roots: **project** (`NSE_ROOT`, else `/opt/nse-universe`, else the repository folder), **data** (`DATA_DIR`) and **logs** (`LOG_DIR`). An area nested inside another is skipped when scanning the outer one, so nothing is added twice. The NSE total is the sum of the three. Filesystem used/available come from the operating system and include everything else on the disk; the pages say so.

Measurement method (recorded on every snapshot, and snapshots are only compared when the methods are equal): logical bytes = file size, allocated = blocks × 512 where available, symbolic links and Windows junctions are never followed, hard-linked files are counted once, a scan stops at `scan_timeout_s` and is then marked **partial**.

### Date-wise storage history

* `storage_snapshots` has a unique index on the IST date for daily snapshots: a retry the same day is a no-op. Manual scans and post-clean-up scans are extra rows of other kinds; the table shows the daily row for each date.
* Status is `complete`, `partial` or `failed`. A failed scan is a row with no numbers, never a zero.
* **Daily change** = this day − the previous *calendar* day, only when both are complete and use the same method; otherwise it shows "—". It is the net change, not bytes written.
* `storage_dirs` keeps per-folder sizes (area totals, first-level folders, and each release). `file_inventory` keeps the largest files per snapshot (path relative to the area, size, mtime, class, protected flag; **no contents**), by default 300 files, kept 30 days. Growth of small files shows in the folder totals, not as separate file rows; the page says so.
* **Forecast** uses complete, comparable daily changes only: needs `forecast_min_days` (default 5) observations, uses the 7-day average, and is withheld when growth is zero or negative or when the daily changes are erratic (spread more than twice the average). It names its method and period.
* **Retention** (configurable): metric samples 14 days, file inventories 30 days, daily snapshots 730 days, runs and resolved alerts 730 days. Only this module's own tables are ever pruned; the daily snapshot run prunes, and "Monitoring retention cleanup" previews first.
* History starts when the module first ran; earlier usage is not reconstructed and the page says so.

### Alerts

Disk used (warning/critical) and free space below a floor, rapid growth, memory pressure (on available memory), sustained CPU (5-sample average), failed collection, stale metrics, failed jobs, missing daily snapshot (an hour after its time). One open row per condition; a repeat raises its count; it closes itself when the condition clears. No external notification is configured.

## Security model

* Reads: the existing site login (Caddy) plus the application's loopback binding; responses are `no-store`.
* **Every change** needs `require_local_control` (loopback client, allowed Origin) **and** the custom header `X-NSE-Action: server-mgmt` (a page on another site cannot add it without a CORS pre-flight, which the application does not allow). Destructive operations also need `confirm: true`; they offer a preview (`dry_run`) first.
* No command comes from the browser. Operations are a fixed list (`scan_storage`, `refresh_metrics`, `health_check`, `retention_cleanup`, `restart_service`). `systemctl show` is called with fixed arguments for a fixed list of names. Log files must be named in the directory listing; the search is a plain substring.
* Paths: relative to an approved area only; absolute paths, `..`, NUL, symbolic links and junctions are refused; the real path must stay inside the area. File contents are never shown.
* Secrets: log lines are masked (passwords, tokens, bearer headers, long hex, the application's own secret values); the diagnostic bundle is masked the same way and contains no environment.
* The web process **cannot** restart anything: the service runs as `nseuniverse` with `NoNewPrivileges` and `ProtectSystem=strict`. A restart request is a small file in `<data>/mgmt/`; a separate **root-owned helper** (`/usr/local/sbin/nse-mgmt-helper`, copied from `deploy/mgmt-helper.sh`) checks that the service is exactly `nse-universe` and the id is 12 hex characters, restarts it, waits for `/api/health` and writes `restart-result.json`. It never runs from the application's own release folder (that user could edit it). Without the helper, the read-only dashboard works fully and the restart is refused with a clear message.
* Every action, refused ones included, is written to the audit table with who (the forwarded user if the proxy sets one, else "operator"), target, mode, result and verification.
* Release rollback is **not** offered from the website (it needs a privileged link switch and a restart); the manual procedure is below.

## One-time Ubuntu setup (run as root on the server, after the release containing this module is live)

The read-only parts need nothing. For the restart helper:

```bash
install -o root -g root -m 0755 /opt/nse-universe/current/deploy/mgmt-helper.sh /usr/local/sbin/nse-mgmt-helper
install -d -o nseuniverse -g nseuniverse -m 0755 /var/lib/nse-universe/data/mgmt
for u in nse-universe-mgmt.service nse-universe-mgmt.path nse-universe-mgmt-heartbeat.timer; do
  install -o root -g root -m 0644 /opt/nse-universe/current/deploy/systemd/$u /etc/systemd/system/$u
done
systemctl daemon-reload
systemctl enable --now nse-universe-mgmt.path nse-universe-mgmt-heartbeat.timer
systemctl start nse-universe-mgmt.service            # writes helper-ready so the website sees the helper
```

The helper needs `python3` and `curl` (both present on Ubuntu). After changing `deploy/mgmt-helper.sh`, copy it again (the root copy is deliberately separate from the releases).

## Verification on the server (read-only unless stated)

```bash
curl -s localhost:8010/api/server/overview | python3 -m json.tool | head -40     # live sample, areas exist
curl -s localhost:8010/api/server/metrics?hours=1 | head -c 400                   # samples accumulating
sqlite3 /var/lib/nse-universe/data/server_mgmt.sqlite3 'select snapshot_date,kind,status,nse_bytes,duration_s from storage_snapshots order by id desc limit 5;'
curl -s localhost:8010/api/server/storage/history | python3 -m json.tool | head -30
curl -s localhost:8010/api/server/services | python3 -m json.tool
journalctl -u nse-universe --since "10 min ago" | grep -i servermgmt                # no errors from the scheduler
systemctl status nse-universe-mgmt.path nse-universe-mgmt-heartbeat.timer         # after helper setup
```

On the website: run **Maintenance → Scan storage now** and check the new snapshot, its duration and the collector's own cost (`duration_s`, each sample's `collect_ms`); after 5 days the forecast appears. A restart test (changes the live service, do it outside market hours): **Maintenance → Restart nse-universe → Confirm**, then check Services for the result and `restart-result.json`.

## Rollback

* Code: revert the merge commit on `main`; the server's update timer deploys the previous release. The module's database file is separate and harmless; it can be deleted (`/var/lib/nse-universe/data/server_mgmt.sqlite3*`) only with your approval, as nothing else reads it.
* Helper: `systemctl disable --now nse-universe-mgmt.path nse-universe-mgmt-heartbeat.timer; rm /etc/systemd/system/nse-universe-mgmt.* /etc/systemd/system/nse-universe-mgmt-heartbeat.timer /usr/local/sbin/nse-mgmt-helper; systemctl daemon-reload`.
* Release rollback by hand (not from the website): `ls /opt/nse-universe/releases`, then `ln -sfn /opt/nse-universe/releases/<previous> /opt/nse-universe/current && systemctl restart nse-universe`, then check `/api/health`. State and data live outside the releases and are untouched.

## Verified in development

Backend: 36 tests (`tests/unit/test_servermgmt.py`): scan totals and no double counting, links and junctions not followed, hard links once, time limit gives partial, exclusions and nested areas, path traversal and escape refused, daily idempotency, concurrent scan refused, failed scan is not zero, growth only between complete consecutive days, partial and missing days, comparison, forecast withheld/available/erratic, series gaps, CSV, retention preview versus delete, config validation, alert dedupe/escalate/resolve, missing-snapshot alert, /proc parsing and "unavailable stays None", redaction, log reader, service and restart allowlists, releases, API guards (missing header 403, wrong Origin 403, non-loopback 403), confirmation required, audit, diagnostic bundle, clean-up hook. ruff and mypy are clean for the module. Frontend: 20 tests (`server-management.test.tsx`) plus the existing suites. Pages viewed at desktop and phone width with synthetic data (layout only).

## Needs production verification

* Real /proc and `systemctl` output on the Ubuntu host, the cost and duration of a real scan on the 1 GB server, the scheduler across a restart, read permission of `/opt/nse-universe` and the log directory for user `nseuniverse`.
* Symbolic-link and hard-link tests are skipped on Windows (junctions were tested); run `pytest tests/unit/test_servermgmt.py` on Linux or Codespaces.
* The helper units and a real restart.
* Nothing here has been deployed.

## Known limitations

* Logs: only files in `/var/log/nse-universe`; the systemd journal and other services' logs are not readable by the application user.
* Disk I/O and network are totals since boot turned into rates between samples; per-core CPU is not shown.
* File-level tracking covers the largest files only; "files added/removed" is the net file-count change.
* Process list shows owner as a numeric id, never command lines or environments, and offers no kill.
* Memory-pressure (PSI) is not read; memory use is total minus available.
* Service control is limited to restarting `nse-universe`.
