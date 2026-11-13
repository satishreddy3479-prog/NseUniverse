# Server deployment (RackNerd VPS, 1 GB RAM / 1 CPU / 20 GB SSD)

The VPS is the production runtime. GitHub only supplies source; the server pulls it, builds it, checks it and rolls back by itself. Nothing depends on GitHub Actions or on a developer's computer being on.

## One-time setup (you, on the server)
1. **DuckDNS (needs your own login at duckdns.org):** add the domain `nseuniverse`, set its current ip to the server's public IPv4, press *update*. (A static IP needs no updater.)
2. **SSH in** (use a key rather than the root password once it works; change the password you shared in chat), then:
   ```bash
   curl -fsSLO https://raw.githubusercontent.com/satishreddy3479-prog/NseUniverse/main/deploy/bootstrap.sh
   sudo bash bootstrap.sh nseuniverse.duckdns.org
   ```
   It asks you to fill the five `KOTAK_*` values in an editor on the server (never sent anywhere) and to choose a website login.
3. Open `https://nseuniverse.duckdns.org` and sign in.

## What gets installed
| Item | Where | Notes |
|---|---|---|
| App releases | `/opt/nse-universe/releases/<commit>`, `current` symlink | newest 3 kept (source only) |
| Python venv | `/opt/nse-universe/venv` | reinstalled only when requirements change |
| Data (databases, snapshots) | `/var/lib/nse-universe/data` | never touched by deploys |
| Logs | `/var/log/nse-universe` + journald (capped 200 MB) | rotated daily, 14 kept |
| Backups | `/var/backups/nse-universe/<date>` | nightly SQLite `.backup`, integrity-checked, gzip; copies older than 14 days are the only thing the scripts ever delete |
| Settings/credentials | `/etc/nse-universe/backend.env` (0640 root:nseuniverse) | edit with nano; restart the service |
| Service | `nse-universe.service` on `127.0.0.1:8010` | user `nseuniverse`, `MemoryHigh=650M`, `MemoryMax=850M`, sandboxed |
| HTTPS + login | Caddy, ports 80/443 | every path requires the website login; backend is not reachable otherwise |
| Updates | `nse-universe-update.timer` (every minute) | `git ls-remote` only; a new commit is built beside the running release, health-checked, rolled back if unhealthy; a failing commit is retried at most every 30 min |
| Storage report | `nse-universe-monitor.timer` (6 h) | warns at 70/80/90 % disk; deletes nothing |
| Watchdog | `nse-universe-watchdog.timer` (5 min), `deploy/watchdog.sh` | reads only. Checks: backend answers, broker login, live feed during the F&O session, a sample stored within 5 min after 09:25 IST, disk free, newest backup under 36 h, last deploy not failed, end-of-day pending. Result in `/opt/nse-universe/state/alerts.json`, shown as a strip on every page and under System > Connection diagnostics; optional phone push (below) |

Swap: a 1 GB `/swapfile-nse` (priority 10) with `vm.swappiness=20`, so RAM is used first and the swap is a safety net.

## Database and storage rules in force
- SQLite databases run in WAL mode with busy timeouts; the stored-bar and forecast tables reject UPDATE/DELETE by trigger.
- The sampler pauses below 2 GB free disk; updates are skipped below 1.5 GB free; backups below 3 GB free.
- Backups use SQLite's online `.backup` plus `PRAGMA quick_check`; WAL files are never deleted by hand and `VACUUM` is never run automatically.
- Raw snapshot files are immutable gzip files (about 13 MB per trading day); they are not part of the nightly database backup. Keep an occasional off-server copy.
- No data is deleted without your approval. The only automatic deletion is backup copies past 14 days and old release source folders.

## Alerts to your phone (optional, off until you choose a channel)
The watchdog always writes `alerts.json` and the app shows it. To also get a push, create `/etc/nse-universe/notify.env` (root, 0600) with one of:
- ntfy (free, no account; install the ntfy app and subscribe to a long random topic): `NOTIFY_URL=https://ntfy.sh/<your-private-topic>`
- Telegram: `NOTIFY_URL=https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>` and `NOTIFY_FIELD=text`
A message goes out when an alert appears and once more when it clears. The text sent is the alert sentence only (no credentials or positions). Nothing is sent until the file exists.

## Backups: three layers
1. **Nightly database copies** on the server (`/var/backups/nse-universe`, 14 days). Each is integrity-checked and gzip-tested when made.
2. **Restore proof:** `sudo bash deploy/restore-check.sh [YYYY-MM-DD]` decompresses every database of a backup day to a temporary folder and runs `PRAGMA integrity_check` plus row counts, touching nothing else. Verified on 13 Nov 2026: all 12 databases of the 12 Nov backup restore cleanly.
3. **Off-server copy** (the server is one disk): `scripts\pull-backups.ps1` on your PC copies the snapshots, end-of-day archives, manifests and the database backups to `S:\NseUniverse-backups`, adding only what is new and never deleting. Run it weekly (or add it to Task Scheduler). First copy made 13 Nov 2026 (241 MB, 11,479 files, verified by size).

## Hardening the SSH door (not applied automatically)
On 13 Nov 2026 the server allowed SSH password login and root login, with no firewall and no fail2ban. `deploy/harden.sh` reports this and, with `--apply`, turns passwords off (keys only), allows only ports 22/80/443 and installs fail2ban. It refuses without a key in `authorized_keys` and must be run with a second terminal ready, so it is left for you to run; see the header of the file.

## Day-to-day
- Push to `main` on GitHub: within about a minute the server notices, builds and switches. Watch: `journalctl -u nse-universe-update -f`.
- Status: `systemctl status nse-universe caddy`; health: `curl -s http://127.0.0.1:8010/api/health` (it names the running release); checks: `journalctl -u nse-universe-watchdog -n 20`.
- Manual rollback: `ln -sfn /opt/nse-universe/releases/<older> /opt/nse-universe/current && systemctl restart nse-universe` (and write that commit id to `/opt/nse-universe/state/deployed_sha`, or the timer will redeploy the newest one).
- Restore a database: stop the service, `gunzip -c /var/backups/nse-universe/<date>/<name>.sqlite3.gz > <name>.sqlite3` into the data folder (remove the matching `-wal`/`-shm` files first), start the service.

## Limits to know
- This host may already run another project; nothing here stops or modifies it. With about 1 GB of RAM the two together will use swap: check `free -m`.
- The backend's control endpoints trust local connections, and the proxy is local, so the website login is what protects them. Keep the login password strong; do not expose port 8010.
- The Yahoo/NSE downloads (daily history, institutional flows) run on the server; on 1 GB they are slow but bounded by the service memory limits.
