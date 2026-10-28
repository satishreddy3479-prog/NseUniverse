# Stop the backend, frontend and watcher started by scripts\launch.ps1 (only those PIDs and their children).
# Rarely needed: code and package changes are picked up automatically; use this only to shut everything down.
#   powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
$Root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $Root "logs\pids.json"
if (-not (Test-Path $pidFile)) { Write-Host "Nothing to stop (no logs\pids.json)."; exit 0 }
$info = Get-Content $pidFile -Raw | ConvertFrom-Json
foreach ($pair in @(@("backend", $info.backend_pid, "python"), @("frontend", $info.frontend_pid, "node"), @("watcher", $info.watcher_pid, "powershell"))) {
  $name = $pair[0]; $procId = $pair[1]; $expected = $pair[2]
  if (-not $procId) { continue }
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if (-not $p) { Write-Host "$name (PID $procId) is not running."; continue }
  if ($p.ProcessName -notlike "$expected*") {
    Write-Host "PID $procId is now '$($p.ProcessName)', not $expected - left alone."
    continue
  }
  # /T also ends the backend's auto-reload worker, so no process is left holding the port
  & taskkill /PID $procId /T /F | Out-Null
  Write-Host "Stopped $name (PID $procId)."
}
Remove-Item $pidFile
