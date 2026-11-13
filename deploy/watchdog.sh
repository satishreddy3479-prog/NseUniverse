#!/usr/bin/env bash
# Watchdog: every 5 minutes (nse-universe-watchdog.timer) checks what must be true for the app to be trustworthy and writes the result
# to /opt/nse-universe/state/alerts.json (shown in the app under System > Connection diagnostics) and to the journal.
# It only READS: it never restarts, deletes or changes anything. A phone notification is sent only if /etc/nse-universe/notify.env exists:
#     NOTIFY_URL=https://ntfy.sh/<your-private-topic>          # ntfy: the message is the request body
#     NOTIFY_FIELD=text                                          # optional: send "text=<message>" as a form field (Telegram, Slack-style hooks)
# A notification goes out when an alert appears and again when it clears, never every 5 minutes.
set -Eeuo pipefail
ROOT=${NSE_ROOT:-/opt/nse-universe}
API=${NSE_API:-http://127.0.0.1:8010}
STATE="$ROOT/state"
BACKUPS=${NSE_BACKUP_DIR:-/var/backups/nse-universe}
NOTIFY_ENV=${NSE_NOTIFY_ENV:-/etc/nse-universe/notify.env}
mkdir -p "$STATE"

python3 - "$API" "$STATE" "$BACKUPS" "$NOTIFY_ENV" <<'PY'
import json, os, sys, time, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone

api, state_dir, backups, notify_env = sys.argv[1:5]
IST = timezone(timedelta(hours=5, minutes=30))
now = datetime.fromisoformat(os.environ["NSE_NOW"]) if os.environ.get("NSE_NOW") else datetime.now(timezone.utc)  # NSE_NOW: tests only
ist = now.astimezone(IST)
alerts: list[dict] = []


def add(key: str, level: str, text: str) -> None:
    alerts.append({"key": key, "level": level, "text": text})


def get(path: str):
    with urllib.request.urlopen(api + path, timeout=8) as r:
        return json.load(r)


def age_s(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        return (now - datetime.fromisoformat(iso.replace("Z", "+00:00"))).total_seconds()
    except ValueError:
        return None


# 1. the backend answers at all
try:
    get("/api/health")
    reachable = True
except Exception as e:  # noqa: BLE001 - any failure means "not healthy"
    reachable = False
    add("backend", "critical", f"The backend does not answer ({type(e).__name__}).")

if reachable:
    try:
        st = get("/api/status")
        auth = (st.get("auth") or {}).get("state")
        if auth != "authenticated":
            add("broker-login", "critical", f"Broker login is '{auth}': {((st.get('auth') or {}).get('last_error') or 'no detail')}.")
        stream = st.get("stream") or {}
        fo = (stream.get("market") or {}).get("state")
        # during the NSE F&O session the feed must be delivering; "market_closed" is the only quiet state
        if fo == "open" and stream.get("freshness") in ("stale", "none"):
            add("live-feed", "critical", f"Market is open but the live feed is {stream.get('freshness')} (last data {stream.get('data_age_seconds')} s ago).")
        if stream.get("state") not in ("streaming", None) and fo == "open":
            add("stream-state", "warning", f"Stream state is '{stream.get('state')}' while the market is open.")
    except Exception as e:  # noqa: BLE001
        add("status", "warning", f"/api/status failed ({type(e).__name__}).")
    try:
        sm = get("/api/sampler/status")
        if sm.get("in_session") and sm.get("enabled"):
            a = age_s(sm.get("last_success_at"))
            started = sm.get("last_attempt_at") is not None
            # first sample is due within a minute or two of 09:15; after 09:25 a missing or old sample is a problem
            late = (ist.hour, ist.minute) >= (9, 25)
            if late and (a is None or a > 300) and (started or a is None):
                add("sampler", "critical", f"No chain sample stored for {'the whole session' if a is None else str(int(a // 60)) + ' min'} while the market is open.")
        if sm.get("last_error"):
            add("sampler-error", "warning", f"Sampler error: {str(sm['last_error'])[:160]}")
        if sm.get("state") == "paused":
            add("sampler-paused", "critical", f"Sampler paused: {sm.get('reason')}.")
    except Exception as e:  # noqa: BLE001
        add("sampler-status", "warning", f"/api/sampler/status failed ({type(e).__name__}).")
    try:
        sto = get("/api/storage/status")
        free_gb = ((sto.get("disk") or {}).get("free_gb"))
        if free_gb is not None and free_gb < 1.5:
            add("disk", "critical", f"Only {free_gb} GB of disk is free; updates stop at 1.5 GB and the sampler at 2 GB.")
        elif free_gb is not None and free_gb < 3:
            add("disk", "warning", f"Disk is getting full: {free_gb} GB free.")
        eod = sto.get("end_of_day") or {}
        if eod.get("pending_days") and (ist.weekday() < 5 and ist.hour >= 18 or ist.weekday() >= 5):
            add("eod", "warning", f"End-of-day processing is pending for {', '.join(eod['pending_days'])}.")
    except Exception as e:  # noqa: BLE001
        add("storage-status", "warning", f"/api/storage/status failed ({type(e).__name__}).")

# 2. a recent verified backup exists (the nightly one runs at 18:30 UTC)
try:
    days = sorted(d for d in os.listdir(backups) if len(d) == 10 and d[4] == "-" and d[7] == "-")
    if not days:
        add("backup", "critical", "There is no backup at all.")
    else:
        newest = os.path.getmtime(os.path.join(backups, days[-1]))
        hours = (now.timestamp() - newest) / 3600
        if hours > 36:
            add("backup", "warning", f"The newest backup ({days[-1]}) is {int(hours)} hours old; the nightly backup did not run.")
except OSError as e:
    add("backup", "warning", f"Backups cannot be read ({e.__class__.__name__}).")

# 3. the last deploy did not fail
try:
    failed = open(os.path.join(state_dir, "failed_sha")).read().strip()
    deployed = open(os.path.join(state_dir, "deployed_sha")).read().strip()
    if failed and failed != deployed:
        add("deploy", "warning", f"Commit {failed[:8]} failed to deploy; the server is still running {deployed[:8]}.")
except OSError:
    pass

# 4. write the result, and notify only about changes
path = os.path.join(state_dir, "alerts.json")
try:
    before = {a["key"]: a for a in json.load(open(path)).get("alerts", [])}
except (OSError, ValueError):
    before = {}
after = {a["key"]: a for a in alerts}
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump({"checked_at": now.isoformat(), "alerts": alerts}, f)
os.chmod(tmp, 0o644)
os.replace(tmp, path)
for a in alerts:
    print(f"watchdog: {a['level'].upper()} {a['key']}: {a['text']}")
if not alerts:
    print("watchdog: all checks passed")

messages = [f"NSE Universe {a['level'].upper()}: {a['text']}" for k, a in after.items() if k not in before]
messages += [f"NSE Universe resolved: {a['text']}" for k, a in before.items() if k not in after]
if messages and os.path.exists(notify_env):
    cfg = {}
    for line in open(notify_env):
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.strip().split("=", 1)
            cfg[k] = v.strip().strip('"')
    url = cfg.get("NOTIFY_URL")
    if url:
        for m in messages:
            body = (urllib.parse.urlencode({cfg["NOTIFY_FIELD"]: m}) if cfg.get("NOTIFY_FIELD") else m).encode()
            try:
                urllib.request.urlopen(urllib.request.Request(url, data=body, method="POST"), timeout=10).read()
                print(f"watchdog: notified: {m[:80]}")
            except Exception as e:  # noqa: BLE001 - a failed notification must not hide the alert itself
                print(f"watchdog: notification failed ({type(e).__name__})")
PY
