#!/usr/bin/env bash
# Root-owned helper for the Server Management Centre. It does exactly two things:
#   1. refresh <data>/mgmt/helper-ready (so the website knows the helper is installed), and
#   2. if <data>/mgmt/restart-request.json exists and names the service "nse-universe", restart that one service,
#      wait for its health endpoint, and write <data>/mgmt/restart-result.json.
# It never runs anything taken from the request: the service name is compared with a fixed value and the id is
# checked against a strict pattern. Files in the (app-writable) directory are only ever replaced by rename.
set -Eeuo pipefail
DATA=${NSE_DATA_DIR:-/var/lib/nse-universe/data}
DIR="$DATA/mgmt"
SERVICE=nse-universe                      # the only service this helper will ever restart
HEALTH_URL=${NSE_HEALTH_URL:-http://127.0.0.1:8010/api/health}
REQ="$DIR/restart-request.json"
umask 022

publish() {  # publish <name> <content>: write a temp file we create ourselves, then rename it into place
  local tmp
  tmp=$(mktemp -p "$DIR" ".tmp.XXXXXX")
  printf '%s\n' "$2" > "$tmp"
  chmod 644 "$tmp"
  mv -fT "$tmp" "$DIR/$1"
}

[ -d "$DIR" ] && [ ! -L "$DIR" ] || { echo "mgmt-helper: $DIR missing or a link; nothing to do" >&2; exit 0; }
publish helper-ready "$(date -u +%FT%TZ)"

[ -e "$REQ" ] || exit 0
if [ -L "$REQ" ] || [ ! -f "$REQ" ]; then rm -f -- "$REQ"; echo "mgmt-helper: request is not a regular file; removed" >&2; exit 0; fi

# Parse with python3 in isolated mode; print "<id> <service>" only when both are well-formed.
parsed=$(python3 -I - "$REQ" <<'PY' || true
import json, re, sys
try:
    with open(sys.argv[1], "rb") as f:
        d = json.loads(f.read(4096))
    rid, svc = d.get("id"), d.get("service")
    if isinstance(rid, str) and re.fullmatch(r"[a-f0-9]{12}", rid) and svc == "nse-universe":
        print(rid, svc)
except Exception:
    pass
PY
)
rm -f -- "$REQ"   # consume the request first: a failing restart is never retried by itself
if [ -z "$parsed" ]; then
  publish restart-result.json '{"status":"rejected","reason":"malformed request or service not approved"}'
  exit 0
fi
rid=${parsed%% *}
started=$(date -u +%FT%TZ)
if ! systemctl restart "$SERVICE"; then
  publish restart-result.json "{\"id\":\"$rid\",\"status\":\"failed\",\"reason\":\"systemctl restart failed\",\"at\":\"$started\"}"
  exit 1
fi
ok=0
for _ in $(seq 1 30); do
  sleep 2
  if curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; then ok=1; break; fi
done
state=$(systemctl is-active "$SERVICE" || true)
if [ "$ok" = 1 ]; then st=ok; else st=unhealthy; fi
publish restart-result.json "{\"id\":\"$rid\",\"status\":\"$st\",\"service_state\":\"$state\",\"started\":\"$started\",\"finished\":\"$(date -u +%FT%TZ)\"}"
