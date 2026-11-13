#!/usr/bin/env bash
# Proves a backup can really be restored: decompresses every database of one backup day into a temporary folder, runs
# PRAGMA integrity_check and counts tables and rows. Touches nothing else (no stored data, no running service).
#   sudo bash deploy/restore-check.sh            # the newest backup day
#   sudo bash deploy/restore-check.sh 2026-11-12 # a given day
# Exit code 1 if any file fails.
set -Eeuo pipefail
DEST=${NSE_BACKUP_DIR:-/var/backups/nse-universe}
day=${1:-$(ls -1 "$DEST" | grep -E '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' | tail -1)}
dir="$DEST/$day"
[ -d "$dir" ] || { echo "restore-check: no backup folder $dir"; exit 1; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
fail=0; n=0
shopt -s nullglob
for gz in "$dir"/*.sqlite3.gz; do
  name=$(basename "$gz" .gz)
  if ! gzip -t "$gz" 2>/dev/null; then echo "FAIL  $name: the compressed file is damaged"; fail=1; continue; fi
  gunzip -c "$gz" > "$tmp/$name"
  check=$(sqlite3 "$tmp/$name" 'PRAGMA integrity_check;' 2>&1 | head -1)
  tables=0; rows=0
  for t in $(sqlite3 "$tmp/$name" "select name from sqlite_master where type='table' and name not like 'sqlite_%';"); do
    c=$(sqlite3 "$tmp/$name" "select count(*) from \"$t\";")
    tables=$((tables + 1)); rows=$((rows + c))
  done
  if [ "$check" = "ok" ]; then echo "ok    $name: $tables tables, $rows rows"; else echo "FAIL  $name: $check"; fail=1; fi
  rm -f "$tmp/$name"; n=$((n + 1))
done
[ "$n" -gt 0 ] || { echo "restore-check: no databases in $dir"; exit 1; }
if [ "$fail" = 0 ]; then echo "restore-check: $day restores cleanly ($n databases)"; else echo "restore-check: $day has problems"; fi
exit "$fail"
