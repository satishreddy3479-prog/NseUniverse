#!/usr/bin/env bash
# Pull-based deploy for NSE Universe. Run by nse-universe-update.timer (every minute) as root.
#
# Cheap when nothing changed: one `git ls-remote`. When GitHub's branch moved to a new commit it
# fetches that commit, builds a new release next to the running one, switches over, checks health,
# and rolls back by itself if the new release does not become healthy. Data is never touched here.
# Production does not need GitHub Actions; GitHub is only read.
set -Eeuo pipefail

ROOT=${NSE_ROOT:-/opt/nse-universe}
REPO_URL=${NSE_REPO_URL:-https://github.com/satishreddy3479-prog/NseUniverse.git}
BRANCH=${NSE_BRANCH:-main}
APP_USER=${NSE_USER:-nseuniverse}
SERVICE=${NSE_SERVICE:-nse-universe}
HEALTH_URL=${NSE_HEALTH_URL:-http://127.0.0.1:8010/api/health}
SYSTEMCTL=${NSE_SYSTEMCTL:-systemctl}
MIN_FREE_MB=${NSE_MIN_FREE_MB:-1500}
KEEP_RELEASES=${NSE_KEEP_RELEASES:-3}
RETRY_AFTER_S=${NSE_RETRY_AFTER_S:-1800}
TEST_MODE=${NSE_TEST_MODE:-0}   # tests only: skip pip/npm and run as the current user

STATE="$ROOT/state"
mkdir -p "$STATE" "$ROOT/releases" "$ROOT/cache"
log() { echo "update: $*"; }
as_app() { if [ "$TEST_MODE" = 1 ]; then "$@"; else runuser -u "$APP_USER" -- "$@"; fi; }

exec 9>"$STATE/lock"
flock -n 9 || { log "another update is running"; exit 0; }

remote=$(git ls-remote "$REPO_URL" "refs/heads/$BRANCH" 2>/dev/null | cut -f1 || true)
if [ -z "$remote" ]; then log "GitHub not reachable; keeping the running version"; exit 0; fi
deployed=$(cat "$STATE/deployed_sha" 2>/dev/null || echo none)
[ "$remote" = "$deployed" ] && exit 0

if [ -f "$STATE/failed_sha" ] && [ "$(cat "$STATE/failed_sha")" = "$remote" ]; then
  age=$(( $(date +%s) - $(stat -c %Y "$STATE/failed_sha") ))
  if [ "$age" -lt "$RETRY_AFTER_S" ]; then exit 0; fi   # do not rebuild a failing commit every minute
fi

free_mb=$(df -Pm "$ROOT" | awk 'NR==2{print $4}')
if [ "$free_mb" -lt "$MIN_FREE_MB" ]; then
  log "only ${free_mb} MB free (need ${MIN_FREE_MB}); update skipped, running version kept"
  exit 0
fi

fail() {
  log "FAILED for $remote: $1"
  echo "$remote" > "$STATE/failed_sha"
  rm -rf "$ROOT/releases/$remote"
  exit 1
}

log "deploying $remote (was $deployed)"
if [ ! -d "$ROOT/repo/.git" ]; then
  as_app git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$ROOT/repo" >/dev/null 2>&1 || fail "clone"
fi
as_app git -C "$ROOT/repo" fetch --depth 1 --quiet origin "$BRANCH" || fail "fetch"
GIT_SAFE=(-c "safe.directory=$ROOT/repo")   # repo is owned by the service user; root only reads it
sha=$(git "${GIT_SAFE[@]}" -C "$ROOT/repo" rev-parse FETCH_HEAD)
rel="$ROOT/releases/$sha"
rm -rf "$rel"; mkdir -p "$rel"
git "${GIT_SAFE[@]}" -C "$ROOT/repo" archive "$sha" | tar -x -C "$rel" || fail "archive"
chown -R "$APP_USER:$APP_USER" "$rel" 2>/dev/null || true

# ---- Python dependencies (shared venv, reinstalled only when requirements change)
reqhash=$(cat "$rel"/backend/requirements.txt "$rel"/backend/requirements-research.txt | sha256sum | cut -c1-16)
if [ "$TEST_MODE" != 1 ] && [ "$(cat "$ROOT/venv/.reqhash" 2>/dev/null || true)" != "$reqhash" ]; then
  log "installing Python packages"
  PYBIN=$(cat /etc/nse-universe-python 2>/dev/null || echo python3)
  [ -x "$ROOT/venv/bin/python" ] || as_app "$PYBIN" -m venv "$ROOT/venv" || fail "venv"
  as_app "$ROOT/venv/bin/pip" install --quiet --disable-pip-version-check \
    -r "$rel/backend/requirements.txt" -r "$rel/backend/requirements-research.txt" || fail "pip install"
  echo "$reqhash" > "$ROOT/venv/.reqhash"
fi
if [ "$TEST_MODE" != 1 ]; then
  (cd "$rel/backend" && as_app "$ROOT/venv/bin/python" -c "import app.main") || fail "backend does not import"
fi

# ---- Frontend build (node_modules cached by lock-file hash; one cache kept)
if [ "$TEST_MODE" != 1 ]; then
  lockhash=$(sha256sum "$rel/frontend/package-lock.json" | cut -c1-16)
  cache="$ROOT/cache/nm-$lockhash"
  export PATH="/opt/node/bin:$PATH"
  if [ ! -d "$cache" ]; then
    log "installing frontend packages"
    (cd "$rel/frontend" && as_app env PATH="$PATH" npm ci --no-audit --no-fund --loglevel=error) || fail "npm ci"
    mv "$rel/frontend/node_modules" "$cache"
    for d in "$ROOT"/cache/nm-*; do [ "$d" = "$cache" ] || rm -rf "$d"; done
  fi
  ln -sfn "$cache" "$rel/frontend/node_modules"
  (cd "$rel/frontend" && as_app env PATH="$PATH" NODE_OPTIONS=--max-old-space-size=700 npm run build --silent) || fail "frontend build"
  [ -f "$rel/frontend/dist/index.html" ] || fail "frontend build produced no index.html"
fi

# ---- Switch over, check health, roll back on failure
prev=$(readlink -f "$ROOT/current" 2>/dev/null || true)
ln -sfn "$rel" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"
"$SYSTEMCTL" restart "$SERVICE" || true
ok=0
for _ in $(seq 1 30); do
  sleep 2
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then ok=1; break; fi
done
if [ "$ok" != 1 ]; then
  if [ -n "$prev" ] && [ -d "$prev" ]; then
    ln -sfn "$prev" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"
    "$SYSTEMCTL" restart "$SERVICE" || true
    log "new release unhealthy; rolled back to $(basename "$prev")"
  fi
  fail "health check did not pass"
fi

echo "$sha" > "$STATE/deployed_sha"
rm -f "$STATE/failed_sha"
# the scripts the timers run are refreshed from the release that just proved healthy
if [ "$TEST_MODE" != 1 ]; then
  for pair in update:nse-universe-update backup:nse-universe-backup monitor:nse-universe-monitor; do
    src="$rel/deploy/${pair%%:*}.sh"; dst="/usr/local/sbin/${pair##*:}"
    [ -f "$src" ] && install -m 755 "$src" "$dst.new" && mv -f "$dst.new" "$dst"
  done
fi
log "deployed $sha; healthy"

# keep the newest releases (source copies only; data lives elsewhere and is never touched here)
cur=$(basename "$(readlink -f "$ROOT/current")")
ls -1dt "$ROOT"/releases/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r d; do
  [ "$(basename "$d")" = "$cur" ] || rm -rf "$d"
done
