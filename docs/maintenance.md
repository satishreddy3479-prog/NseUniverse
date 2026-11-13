# Keeping NSE Universe healthy (runbook)

The app is built so most things fail loudly and early instead of quietly: the server watchdog (every 5 minutes) puts any problem in a strip at the top of every page and under System > Connection diagnostics. This page says what each alert means and what has to be done by a person on a schedule, because a few things cannot be automated safely (they need an official source or a decision).

## Scheduled duties
| When | What | How |
|---|---|---|
| **Every December** (before 1 Jan) | Add the next year's NSE holiday list | NSE publishes the trading-holiday circular in December. Add the dates to `backend/app/prediction/reference/nse_cm_holidays.json` (`weekday_holidays`, `special_sessions` such as Muhurat, `coverage.to`, the circular's reference under `sources`). Only dates from the official circular: never guess. **The list currently ends on 31 Dec 2026**; the watchdog warns from 60 days before the end and turns critical 14 days before. After the end date the app falls back to "every weekday is a session", which is wrong on holidays. |
| **Weekly** | Off-server copy | `powershell -ExecutionPolicy Bypass -File scripts\pull-backups.ps1` (adds only what is new, deletes nothing). |
| **Monthly** | Look at System > Connection diagnostics and the watchdog journal | `journalctl -u nse-universe-watchdog --since "30 days ago" \| grep -v "all checks"` |
| **When a reboot is flagged** | Reboot the server on a weekend | `ssh nse-server reboot`. The service, Caddy and all timers start by themselves and the app signs in to the broker at start. Afterwards check `curl -s http://127.0.0.1:8010/api/health` and System > Platform status. |
| **When NSE changes the NIFTY lot size** | Set `COST_LOT_SIZE` | The app compares the stored chain's lot size with the cost model and raises `lot-size`. Set `COST_LOT_SIZE=<new>` in `/etc/nse-universe/backend.env`, `systemctl restart nse-universe`. Strategy P&L already uses the chain's own lot size. |
| **Once a year** | Review upgrades on purpose | See "Upgrading packages" below. |

## What each alert means
| Alert | Meaning | First step |
|---|---|---|
| `backend` | The backend does not answer | `systemctl status nse-universe`; `journalctl -u nse-universe -n 80`. It restarts by itself after a crash; a deploy that fails health rolls back by itself. |
| `broker-login` | Kotak sign-in failed | The daily login uses the five `KOTAK_*` values in `/etc/nse-universe/backend.env`. A wrong TOTP secret or an MPIN change shows here. `systemctl restart nse-universe` retries. |
| `live-feed`, `stream-state` | Market open but no data arriving | Usually a broker-side disconnect: restart the service. If it repeats, run `scripts\stream-check.ps1` and look at the stream log. |
| `sampler`, `sampler-error`, `sampler-paused` | No option-chain sample stored in market hours, or the sampler paused (disk) | Check the live feed alert first; then free disk (below). |
| `disk` | Disk filling | `df -h`; the monitor lists the biggest folders. Nothing is deleted automatically; old snapshot pruning needs your approval (see storage-plan). |
| `backup` | Nightly backup did not run, or none exists | `journalctl -u nse-universe-backup -n 40`; run `/usr/local/sbin/nse-universe-backup` by hand. |
| `deploy` | The newest commit failed to build or was unhealthy and was rolled back | `journalctl -u nse-universe-update -n 60`. The server keeps running the last good release; fix and push again. |
| `eod` | End-of-day processing pending | `journalctl -u nse-universe -n 80 \| grep eod`; it retries by itself. |
| `history`, `history-source` | Daily NIFTY 50 / India VIX bars missing or Yahoo download failed | Yahoo is an unofficial source and sometimes blocks; it retries hourly. If it lasts days, the source changed: see `backend/app/prediction/sources/yahoo.py`. |
| `flows`, `flows-blocked` | NSE institutional-flow files missing or NSE refused the request | NSE publishes about 18:00 IST; a block usually clears; the downloads are low-rate. |
| `holiday-list` | The NSE holiday list is about to end | See "Every December". |
| `lot-size` | NSE changed the lot size | See "When NSE changes the NIFTY lot size". |
| `reboot` | Security updates need a reboot | See "When a reboot is flagged". |

## Upgrading packages (deliberately)
- **Python:** production installs with `backend/requirements.lock` (the exact versions the server was proven with), so a rebuild never pulls an untested release. To upgrade: change the range in `backend/requirements*.txt`, run `scripts\check.ps1` on the PC, push (the server installs, health-checks and rolls back by itself if unhealthy), then refresh the lock from the working server: `ssh nse-server /opt/nse-universe/venv/bin/pip freeze`, and commit it.
- **Frontend:** `package-lock.json` is used with `npm ci`, so builds are reproducible. Upgrade with `npm update`, run `scripts\check.ps1`, push.
- **The Kotak SDK (`kotakneoapi`)** is the most likely thing to change under you. It is pinned; upgrade it only when Kotak announces a change, and run `scripts\live-check.ps1` (read-only) before and after.
- **Server OS:** `unattended-upgrades` installs security updates; reboot when flagged.

## What protects you if you do nothing
Deploys health-check and roll back; databases are backed up nightly, integrity-checked and restore-tested; the watchdog flags problems within 5 minutes; the sampler pauses before the disk fills; every figure shows its source, age and staleness instead of a guess.
