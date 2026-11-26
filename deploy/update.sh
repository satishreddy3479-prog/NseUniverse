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
ASSET_KEEP_DAYS=${NSE_ASSET_KEEP_DAYS:-7}   # how long a release keeps the built page files of the releases before it (see keep_assets)
RETRY_AFTER_S=${NSE_RETRY_AFTER_S:-1800}
TEST_MODE=${NSE_TEST_MODE:-0}   # tests only: skip pip/npm and run as the current user

# ---- Built-file helpers. Tests load them with `NSE_UPDATE_LIB=1 source update.sh`.
# The app's pages are loaded on demand under hashed names; a browser tab opened before a deploy still asks for the old names, and when they are gone that page cannot open
# (a blank screen until the person reloads). So each release keeps the previous release's built files next to its own. They are hard links, not copies (same disk): a file
# lives once however many releases hold it. Names are content hashes, so old and new never clash. Files older than DAYS are dropped from the NEW release only.
keep_assets() {
  local old=$1 new=$2 days=$3
  [ -d "$old/frontend/dist/assets" ] && [ -d "$new/frontend/dist/assets" ] || return 0
  cp -aln "$old/frontend/dist/assets/." "$new/frontend/dist/assets/" 2>/dev/null || cp -an "$old/frontend/dist/assets/." "$new/frontend/dist/assets/" 2>/dev/null || true
  find "$new/frontend/dist/assets" -type f -mtime +"$days" -delete 2>/dev/null || true
}
# Releases made before the hard-link change each hold their own copy of the same files: make identical files (same name, same bytes) share one copy with the newest release.
dedupe_assets() {
  local root=$1 rel=$2 cur d f b
  cur="$rel/frontend/dist/assets"
  [ -d "$cur" ] || return 0
  for d in "$root"/releases/*/; do
    d=${d%/}
    [ "$d" = "$rel" ] && continue
    [ -d "$d/frontend/dist/assets" ] || continue
    for f in "$d"/frontend/dist/assets/*; do
      [ -f "$f" ] || continue
      b=$(basename "$f")
      if [ -f "$cur/$b" ] && [ ! "$f" -ef "$cur/$b" ] && cmp -s "$f" "$cur/$b"; then ln -f "$cur/$b" "$f" 2>/dev/null || true; fi
    done
  done
}
[ "${NSE_UPDATE_LIB:-0}" = 1 ] && return 0

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

# A deploy restarts the live stream, so a new commit waits for the close (deploy/deploy-guard.sh); the owner can let one through
GUARD_BIN=${NSE_GUARD_BIN:-/usr/local/sbin/nse-universe-deploy-guard}
if [ -x "$GUARD_BIN" ]; then
  verdict=$(NSE_STATE="$STATE" "$GUARD_BIN" || echo "go (guard failed)")
  case "$verdict" in
    hold*)
      [ "$(cat "$STATE/held_sha" 2>/dev/null || true)" = "$remote" ] || { log "$remote held: $verdict"; echo "$remote" > "$STATE/held_sha"; }
      exit 0 ;;
    "go (the owner allowed"*) rm -f "$STATE/allow-market-hours-deploy"; log "market-hours deploy allowed by the owner" ;;
  esac
fi
rm -f "$STATE/held_sha"

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
reqhash=$(cat "$rel"/backend/requirements.txt "$rel"/backend/requirements-research.txt "$rel"/backend/requirements.lock 2>/dev/null | sha256sum | cut -c1-16)
if [ "$TEST_MODE" != 1 ] && [ "$(cat "$ROOT/venv/.reqhash" 2>/dev/null || true)" != "$reqhash" ]; then
  log "installing Python packages"
  PYBIN=$(cat /etc/nse-universe-python 2>/dev/null || echo python3)
  [ -x "$ROOT/venv/bin/python" ] || as_app "$PYBIN" -m venv "$ROOT/venv" || fail "venv"
  # the lock file pins every package to the version the server was proven with; without it the ranges in requirements*.txt pick the newest release
  lock=(); [ -f "$rel/backend/requirements.lock" ] && lock=(-c "$rel/backend/requirements.lock")
  as_app "$ROOT/venv/bin/pip" install --quiet --disable-pip-version-check \
    -r "$rel/backend/requirements.txt" -r "$rel/backend/requirements-research.txt" "${lock[@]}" || fail "pip install"
  as_app "$ROOT/venv/bin/pip" check >/dev/null 2>&1 || fail "pip check: the installed packages conflict"
  echo "$reqhash" > "$ROOT/venv/.reqhash"
fi
if [ "$TEST_MODE" != 1 ]; then
  (cd "$rel/backend" && as_app "$ROOT/venv/bin/python" -c "import app.main") || fail "backend does not import"
fi

# ---- Frontend build (node_modules cached by lock-file hash; one cache kept).
# Production only bundles with vite; type checks and tests run on the development machine / CI.
if [ "$TEST_MODE" != 1 ]; then
  lockhash=$(sha256sum "$rel/frontend/package-lock.json" | cut -c1-16)
  cache="$ROOT/cache/nm2-$lockhash"   # must contain a folder literally named node_modules (Node resolves real paths)
  export PATH="/opt/node/bin:$PATH"
  if [ ! -d "$cache/node_modules" ]; then
    log "installing frontend packages"
    (cd "$rel/frontend" && as_app env PATH="$PATH" npm ci --no-audit --no-fund --loglevel=error) || fail "npm ci"
    mkdir -p "$cache" && mv "$rel/frontend/node_modules" "$cache/node_modules"
    for d in "$ROOT"/cache/*; do [ "$d" = "$cache" ] || rm -rf "$d"; done
  fi
  ln -sfn "$cache/node_modules" "$rel/frontend/node_modules"
  (cd "$rel/frontend" && as_app env PATH="$PATH" NODE_OPTIONS=--max-old-space-size=700 ./node_modules/.bin/vite build --logLevel warn) || fail "frontend build"
  [ -f "$rel/frontend/dist/index.html" ] || fail "frontend build produced no index.html"
fi

# ---- Keep the previous release's built files next to the new ones (hard links, see keep_assets).
oldd=$(readlink -f "$ROOT/current" 2>/dev/null || true)
if [ -n "$oldd" ] && [ "$oldd" != "$rel" ]; then keep_assets "$oldd" "$rel" "$ASSET_KEEP_DAYS"; fi

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
  for pair in update:nse-universe-update deploy-guard:nse-universe-deploy-guard backup:nse-universe-backup monitor:nse-universe-monitor watchdog:nse-universe-watchdog restore-check:nse-universe-restore-check; do
    src="$rel/deploy/${pair%%:*}.sh"; dst="/usr/local/sbin/${pair##*:}"
    [ -f "$src" ] && install -m 755 "$src" "$dst.new" && mv -f "$dst.new" "$dst"
  done
fi
# the watchdog's timer units are installed once (idempotent), so an older server picks them up from the first release that carries them
if [ "$TEST_MODE" != 1 ] && [ -f "$rel/deploy/systemd/nse-universe-watchdog.timer" ] && [ ! -f /etc/systemd/system/nse-universe-watchdog.timer ]; then
  install -m 644 "$rel"/deploy/systemd/nse-universe-watchdog.service "$rel"/deploy/systemd/nse-universe-watchdog.timer /etc/systemd/system/
  systemctl daemon-reload && systemctl enable --now nse-universe-watchdog.timer || log "could not enable the watchdog timer"
fi
# the weekly restore check's units, installed once like the watchdog's (a server provisioned before they existed picks them up here)
if [ "$TEST_MODE" != 1 ] && [ -f "$rel/deploy/systemd/nse-universe-restore-check.timer" ] && [ ! -f /etc/systemd/system/nse-universe-restore-check.timer ]; then
  install -m 644 "$rel"/deploy/systemd/nse-universe-restore-check.service "$rel"/deploy/systemd/nse-universe-restore-check.timer /etc/systemd/system/
  systemctl daemon-reload && systemctl enable --now nse-universe-restore-check.timer || log "could not enable the restore-check timer"
fi
log "deployed $sha; healthy"

# one copy of every built file across the releases still held, then keep the newest releases (source copies only; data lives elsewhere and is never touched here)
dedupe_assets "$ROOT" "$rel"
cur=$(basename "$(readlink -f "$ROOT/current")")
ls -1dt "$ROOT"/releases/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r d; do
  [ "$(basename "$d")" = "$cur" ] || rm -rf "$d"
done
# the deploy clone fetches one commit at a time, so objects of earlier commits pile up unused: tidy them (about 60 MB after three weeks of daily deploys)
if [ "$TEST_MODE" != 1 ]; then as_app git -c pack.threads=1 -C "$ROOT/repo" gc --quiet --prune=now >/dev/null 2>&1 || true; fi
