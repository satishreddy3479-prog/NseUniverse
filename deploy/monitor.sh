#!/usr/bin/env bash
# Lightweight storage/memory report to the journal; warns at 70/80/90 % disk. Creates no files.
set -Eeuo pipefail
DATA=${NSE_DATA_DIR:-/var/lib/nse-universe/data}
used=$(df -P "$DATA" | awk 'NR==2{gsub("%","",$5); print $5}')
free_mb=$(df -Pm "$DATA" | awk 'NR==2{print $4}')
mem=$(free -m | awk '/Mem:/{print "mem_used_mb="$3" mem_avail_mb="$7}')
swap=$(free -m | awk '/Swap:/{print "swap_used_mb="$3" swap_total_mb="$2}')
data_mb=$(du -sm "$DATA" 2>/dev/null | cut -f1)
wal_mb=$(find "$DATA" -name '*.sqlite3-wal' -printf '%s\n' 2>/dev/null | awk '{s+=$1} END{printf "%d", s/1048576}')
level=INFO
[ "$used" -ge 70 ] && level=WARNING
[ "$used" -ge 80 ] && level=HIGH-PRIORITY
[ "$used" -ge 90 ] && level=CRITICAL
echo "monitor: level=$level disk_used_pct=$used disk_free_mb=$free_mb data_mb=${data_mb:-0} wal_mb=${wal_mb:-0} $mem $swap"
if [ "$level" != INFO ]; then
  echo "monitor: disk is filling; optional bulk work should pause. Nothing is deleted automatically; review $DATA and backups."
fi
