# Keeps the running app current without a restart:
#   - backend code: the backend restarts itself when a file in backend\app changes (APP_RELOAD=1)
#   - frontend code: Vite updates the page on its own
#   - new packages: this watcher installs them when requirements*.txt or package-lock.json change
# Started by scripts\launch.ps1 and stopped by scripts\stop.ps1. Output: logs\watcher.log
param([string]$Root)

$ErrorActionPreference = "Continue"
$Logs = Join-Path $Root "logs"
$backend = Join-Path $Root "backend"
$frontend = Join-Path $Root "frontend"
$venvPy = Join-Path $backend ".venv\Scripts\python.exe"
$logFile = Join-Path $Logs "watcher.log"

function Log([string]$m) { Add-Content -Path $logFile -Value ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m) }
function Get-Hash([string[]]$files) {
  return (($files | Where-Object { Test-Path $_ } | ForEach-Object { (Get-FileHash -Algorithm SHA256 $_).Hash }) -join "")
}
function Saved([string]$file) { if (Test-Path $file) { return (Get-Content $file -Raw).Trim() } else { return "" } }

$pipFile = Join-Path $Logs "deps-backend.sha256"
$npmFile = Join-Path $Logs "deps-frontend.sha256"
Log "watcher started"

while ($true) {
  Start-Sleep -Seconds 5
  try {
    $pipNow = Get-Hash @((Join-Path $backend "requirements.txt"), (Join-Path $backend "requirements-dev.txt"), (Join-Path $backend "requirements-research.txt"))
    if ($pipNow -and $pipNow -ne (Saved $pipFile)) {
      Log "backend requirements changed: installing"
      $out = Join-Path $Logs "watch-pip.out.log"; $err = Join-Path $Logs "watch-pip.err.log"
      $p = Start-Process -FilePath $venvPy -ArgumentList "-m pip install -r requirements-dev.txt" -WorkingDirectory $backend `
            -RedirectStandardOutput $out -RedirectStandardError $err -NoNewWindow -Wait -PassThru
      if ($p.ExitCode -eq 0) {
        Set-Content -Path $pipFile -Value $pipNow
        # touching a backend file makes the backend restart and load the new packages
        (Get-Item (Join-Path $backend "app\__init__.py")).LastWriteTime = Get-Date
        Log "backend packages installed; backend restarting"
      } else { Log "pip install FAILED (see logs\watch-pip.err.log); will retry after the next change"; Set-Content -Path $pipFile -Value $pipNow }
    }
    $npmNow = Get-Hash @((Join-Path $frontend "package-lock.json"))
    if ($npmNow -and $npmNow -ne (Saved $npmFile)) {
      Log "frontend package-lock changed: installing"
      $out = Join-Path $Logs "watch-npm.out.log"; $err = Join-Path $Logs "watch-npm.err.log"
      $p = Start-Process -FilePath $env:ComSpec -ArgumentList "/c npm install --no-audit --no-fund" -WorkingDirectory $frontend `
            -RedirectStandardOutput $out -RedirectStandardError $err -NoNewWindow -Wait -PassThru
      if ($p.ExitCode -eq 0) { Log "frontend packages installed; refresh the page" } else { Log "npm install FAILED (see logs\watch-npm.err.log)" }
      Set-Content -Path $npmFile -Value $npmNow
    }
  } catch { Log ("watcher error: " + $_.Exception.Message) }
}
