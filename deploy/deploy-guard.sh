#!/usr/bin/env bash
# Decides whether the pull-based deploy may restart the service now. Prints "go ..." or "hold ...".
#
# A deploy restarts the backend, the live stream and the samplers: about a minute of lost option-chain samples and one-second candles.
# That must not happen while the market is trading, so a new commit waits until the close unless the owner allows it:
#   - weekdays 08:55-15:50 IST are held (pre-open from 09:00, the session to 15:40, 15:45 from 7 Dec 2026, plus a margin);
#   - exchange holidays (from the app's own calendar) and weekends are not held;
#   - `touch $STATE/allow-market-hours-deploy` lets the next deploy through once (the update script removes the file);
#   - NSE_DEPLOY_GUARD=0 switches the guard off.
# Tests set NSE_NOW_IST ("YYYY-MM-DD <weekday 1-7> HHMM") and NSE_HOLIDAYS (space separated dates).
set -u
STATE=${NSE_STATE:-/opt/nse-universe/state}
SESSION_URL=${NSE_SESSION_URL:-http://127.0.0.1:8010/api/market/session}
HOLD_FROM=${NSE_HOLD_FROM:-0855}
HOLD_TO=${NSE_HOLD_TO:-1550}

if [ "${NSE_DEPLOY_GUARD:-1}" = 0 ]; then echo "go (guard switched off)"; exit 0; fi
if [ -f "$STATE/allow-market-hours-deploy" ]; then echo "go (the owner allowed this deploy: allow-market-hours-deploy)"; exit 0; fi

now=${NSE_NOW_IST:-$(TZ=Asia/Kolkata date '+%F %u %H%M')}
read -r day dow hm <<<"$now"
if [ "$dow" -ge 6 ]; then echo "go (weekend)"; exit 0; fi
if [ "$((10#$hm))" -lt "$((10#$HOLD_FROM))" ] || [ "$((10#$hm))" -ge "$((10#$HOLD_TO))" ]; then echo "go (outside market hours)"; exit 0; fi

holidays=${NSE_HOLIDAYS-}
if [ -z "$holidays" ] && [ -z "${NSE_NOW_IST:-}" ]; then
  holidays=$(curl -fsS --max-time 3 "$SESSION_URL" 2>/dev/null | python3 -c 'import sys,json;print(" ".join(json.load(sys.stdin).get("holidays",[])))' 2>/dev/null || true)
fi
case " $holidays " in *" $day "*) echo "go (exchange holiday $day)"; exit 0;; esac

echo "hold (market hours ${HOLD_FROM:0:2}:${HOLD_FROM:2:2}-${HOLD_TO:0:2}:${HOLD_TO:2:2} IST; the deploy restarts the live stream. After the close it goes by itself, or now with: touch $STATE/allow-market-hours-deploy)"
