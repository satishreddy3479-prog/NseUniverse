# LIVE read-only streaming check against Kotak Neo. Run during market hours (09:15-15:30 IST).
# Requires backend\.env with all KOTAK_* values. Prints no secrets. No orders.
#   powershell -ExecutionPolicy Bypass -File scripts\stream-check.ps1            (30 seconds)
#   powershell -ExecutionPolicy Bypass -File scripts\stream-check.ps1 -Seconds 60
param([int]$Seconds = 30)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location "$root\backend"
$env:NSE_LIVE_TESTS = "1"
$env:NSE_STREAM_SECONDS = "$Seconds"
& .\.venv\Scripts\python.exe -m pytest -m live -v -s tests\live\test_live_stream.py
$code = $LASTEXITCODE
Remove-Item Env:\NSE_LIVE_TESTS
Remove-Item Env:\NSE_STREAM_SECONDS
Set-Location $root
exit $code
