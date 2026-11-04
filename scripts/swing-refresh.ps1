# Refresh the Swing page: new Chartink list, new daily bars, new backtest + candidates report.
# Run after 16:00 IST on a trading day (takes about 4-6 minutes). Needs internet; no broker login.
#   powershell -ExecutionPolicy Bypass -File scripts\swing-refresh.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$py = "$root\backend\.venv\Scripts\python.exe"
& $py -c "import pyarrow, pandas, yfinance, httpx" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Installing research packages (pyarrow etc.) into backend\.venv ..."
  & $py -m pip install -r "$root\backend\requirements-research.txt"
  if ($LASTEXITCODE -ne 0) { throw "pip install failed" }
}
Set-Location "$root\research"
& $py -X utf8 -m swing.refresh
$code = $LASTEXITCODE
Set-Location $root
if ($code -eq 0) { Write-Host "Done. Refresh the browser: Swing trading page." }
exit $code
