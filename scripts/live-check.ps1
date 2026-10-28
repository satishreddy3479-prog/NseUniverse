# LIVE read-only check against Kotak Neo: login, expiries, one weekly option-chain snapshot.
# Requires backend\.env with all KOTAK_* values. Prints no secrets.
#   powershell -ExecutionPolicy Bypass -File scripts\live-check.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location "$root\backend"
$env:NSE_LIVE_TESTS = "1"
& .\.venv\Scripts\python.exe -m pytest -m live -v -s tests\live
$code = $LASTEXITCODE
Remove-Item Env:\NSE_LIVE_TESTS
Set-Location $root
exit $code
