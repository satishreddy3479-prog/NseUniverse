#!/usr/bin/env bash
# Nightly consistent copy of every SQLite database (online .backup, safe while the app runs).
# Raw snapshot files are immutable gzip files and are NOT copied here: keep an off-server copy.
# Only backup copies older than BACKUP_KEEP_DAYS are removed by this script; stored market data never is.
set -Eeuo pipefail
DATA=${NSE_DATA_DIR:-/var/lib/nse-universe/data}
DEST=${NSE_BACKUP_DIR:-/var/backups/nse-universe}
KEEP_DAYS=${NSE_BACKUP_KEEP_DAYS:-14}
MIN_FREE_MB=${NSE_BACKUP_MIN_FREE_MB:-3000}

free_mb=$(df -Pm "$DEST" 2>/dev/null | awk 'NR==2{print $4}' || echo 0)
if [ "${free_mb:-0}" -lt "$MIN_FREE_MB" ]; then echo "backup: only ${free_mb} MB free; skipped (need $MIN_FREE_MB)"; exit 0; fi

day=$(date -u +%F); out="$DEST/$day"; tmp="$DEST/.tmp-$day-$$"
mkdir -p "$tmp"
trap 'rm -rf "$tmp"' EXIT
n=0
shopt -s nullglob
for db in "$DATA"/*.sqlite3; do
  name=$(basename "$db")
  sqlite3 "$db" ".backup '$tmp/$name'"
  [ "$(sqlite3 "$tmp/$name" 'PRAGMA quick_check;')" = "ok" ] || { echo "backup: integrity check FAILED for $name; nothing replaced"; exit 1; }
  gzip -f "$tmp/$name"
  n=$((n + 1))
done
[ "$n" -gt 0 ] || { echo "backup: no databases found in $DATA"; exit 0; }
rm -rf "$out"; mv "$tmp" "$out"; trap - EXIT
echo "backup: $n databases saved to $out ($(du -sh "$out" | cut -f1))"
# retention for backup copies only (verified new backup exists above)
find "$DEST" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??' -mtime +"$KEEP_DAYS" -exec rm -rf {} +
