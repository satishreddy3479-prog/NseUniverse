<#
NSE Universe - one-step local setup, verification and launch (Windows 11, PowerShell 5.1+).

  powershell -ExecutionPolicy Bypass -File scripts\launch.ps1
  powershell -ExecutionPolicy Bypass -File scripts\launch.ps1 -SkipChecks

What it does (all reversible, all inside this project folder):
  1. Writes an environment report (Windows, CPU, RAM, disk, Python/Node/npm/Git, ports).
  2. Picks a compatible Python (prefers 3.12; accepts 3.11-3.14) and Node (20.19+ / 22.12+).
  3. Creates backend\.venv, installs pinned backend deps; runs npm ci for the frontend.
  4. Creates backend\.env from .env.example if missing. Never reads its secrets. The app has no demo
     mode: it needs your Kotak credentials in backend\.env and signs in read-only (no orders).
  5. Runs offline checks: ruff, mypy, pytest, tsc, vitest, production build.
  6. Starts backend and frontend as background processes on free loopback ports
     (never kills other programs, never starts duplicates), then verifies HTTP health.
  7. Writes logs\launch-report.json and logs\launch-summary.txt.

Stop everything with scripts\stop.ps1 (rarely needed: code and package changes are picked up automatically).
#>
param([switch]$Checks, [switch]$SkipChecks)  # offline checks are opt-in now; scripts\check.ps1 runs them anytime

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Logs = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $Logs | Out-Null
$Report = [ordered]@{ started_at = (Get-Date).ToString("o"); steps = [ordered]@{}; errors = @() }
$SummaryLines = New-Object System.Collections.Generic.List[string]

function Say([string]$msg) { Write-Host $msg; $SummaryLines.Add($msg) }
function Save-Report {
  $Report.finished_at = (Get-Date).ToString("o")
  $Report | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $Logs "launch-report.json")
  $SummaryLines | Set-Content -Encoding UTF8 (Join-Path $Logs "launch-summary.txt")
}
function Fail([string]$step, [string]$msg) {
  $Report.steps[$step] = "failed"
  $Report.errors += "${step}: $msg"
  Say "FAILED [$step] $msg"
  Save-Report
  Write-Host ""
  Write-Host "Setup stopped. Details: logs\launch-summary.txt" -ForegroundColor Red
  exit 1
}

# Run a native program, capturing stdout/stderr to log files. Returns exit code.
function Invoke-Logged([string]$name, [string]$exe, [string]$arguments, [string]$workdir) {
  $out = Join-Path $Logs "$name.out.log"
  $err = Join-Path $Logs "$name.err.log"
  $p = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $workdir `
        -RedirectStandardOutput $out -RedirectStandardError $err -NoNewWindow -Wait -PassThru
  return $p.ExitCode
}

function Get-Ver([string]$exe, [string[]]$prefix) {
  try {
    $v = & $exe @prefix -c "import sys;print('%d.%d.%d'%sys.version_info[:3])" 2>$null
    if ($LASTEXITCODE -eq 0 -and $v) { return [version]($v | Select-Object -First 1).Trim() }
  } catch { }
  return $null
}

function Test-PortFree([int]$port) {
  $busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  return -not $busy
}

function Find-FreePort([int]$start) {
  for ($p = $start; $p -lt $start + 20; $p++) { if (Test-PortFree $p) { return $p } }
  return $null
}

function Wait-Http([string]$url, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { return $r }
    } catch { }
    Start-Sleep -Milliseconds 700
  }
  return $null
}

Say "NSE Universe launcher - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Say "Project root: $Root"

# ---------------------------------------------------------------- 1. environment
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$drive = Get-PSDrive -Name ($Root.Substring(0, 1))
$envInfo = [ordered]@{
  windows = "$($os.Caption) $($os.Version) (build $($os.BuildNumber))"
  cpu = "$($cpu.Name.Trim()), $($cpu.NumberOfCores) cores / $($cpu.NumberOfLogicalProcessors) threads"
  ram_total_gb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
  ram_free_gb = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
  project_drive_free_gb = [math]::Round($drive.Free / 1GB, 1)
  powershell = $PSVersionTable.PSVersion.ToString()
}
$git = Get-Command git -ErrorAction SilentlyContinue
$envInfo.git = if ($git) { (& git --version) } else { "not installed" }
$envInfo.git_repo = if ($git -and (Test-Path (Join-Path $Root ".git"))) { "present" } else { "none (local-only stage)" }
$Report.environment = $envInfo
foreach ($k in $envInfo.Keys) { Say ("  {0,-22} {1}" -f $k, $envInfo[$k]) }

# ---------------------------------------------------------------- 2. runtimes
$candidates = @()
if (Get-Command py -ErrorAction SilentlyContinue) {
  foreach ($v in "3.12", "3.13", "3.11", "3.14") { $candidates += ,@("py", @("-$v")) }
}
foreach ($c in (Get-Command python -All -ErrorAction SilentlyContinue)) {
  if ($c.Source -notmatch "WindowsApps") { $candidates += ,@($c.Source, @()) }
}
$conda = Join-Path $env:USERPROFILE "anaconda3\python.exe"
if (Test-Path $conda) { $candidates += ,@($conda, @()) }

$pyExe = $null; $pyPrefix = @(); $pyVer = $null
$seen = @()
foreach ($c in $candidates) {
  $ver = Get-Ver $c[0] $c[1]
  if (-not $ver) { continue }
  $seen += "$($c[0]) $($c[1] -join ' ') -> $ver"
  if ($ver.Major -eq 3 -and $ver.Minor -ge 11 -and $ver.Minor -le 14) {
    if (-not $pyExe -or ($ver.Minor -eq 12 -and $pyVer.Minor -ne 12)) {
      $pyExe = $c[0]; $pyPrefix = $c[1]; $pyVer = $ver
    }
  }
}
$Report.python_candidates = $seen
if (-not $pyExe) {
  Fail "python" ("No Python 3.11-3.14 found. Seen: " + ($seen -join "; ") +
    ". Install Python 3.12: winget install -e --id Python.Python.3.12")
}
Say "Python selected: $pyExe $($pyPrefix -join ' ') ($pyVer)"
$Report.python = "$pyVer"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "node" "Node.js not found. Install Node 22 LTS: winget install -e --id OpenJS.NodeJS.LTS" }
$nodeVer = [version]((& node --version).TrimStart("v"))
$npmVer = (& cmd /c "npm --version").Trim()
$Report.node = "$nodeVer"; $Report.npm = $npmVer
Say "Node $nodeVer, npm $npmVer"
$nodeOk = ($nodeVer.Major -ge 23) -or ($nodeVer.Major -eq 22 -and $nodeVer.Minor -ge 12) -or ($nodeVer.Major -eq 20 -and $nodeVer.Minor -ge 19)
if (-not $nodeOk) { Fail "node" "Node $nodeVer is too old for Vite 8 (needs 20.19+ or 22.12+). Install Node 22 LTS: winget install -e --id OpenJS.NodeJS.LTS" }

# ---------------------------------------------------------------- 2b. existing instance
# Handled BEFORE any install: running servers keep files in node_modules/.venv locked on Windows.
$pidFile = Join-Path $Logs "pids.json"
if (Test-Path $pidFile) {
  $old = Get-Content $pidFile -Raw | ConvertFrom-Json
  $alive = @()
  foreach ($procId in @($old.backend_pid, $old.frontend_pid)) {
    if ($procId -and (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { $alive += $procId }
  }
  if ($alive.Count -gt 0 -and -not $old.watcher_pid) {
    # Started by an older launcher (no auto-reload). Replace it once; after this nothing needs restarting.
    Say "Upgrading the running instance to auto-reload (one time) ..."
    foreach ($procId in $alive) { & taskkill /PID $procId /T /F | Out-Null }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    $alive = @()
  }
  if ($alive.Count -gt 0) {
    $ok = Wait-Http "http://127.0.0.1:$($old.backend_port)/api/health" 3
    if ($ok) {
      Say "Already running (PIDs $($alive -join ', ')); not starting duplicates."
      Say "Dashboard: http://127.0.0.1:$($old.frontend_port)   API docs: http://127.0.0.1:$($old.backend_port)/docs"
      Say "Code changes show up on a browser refresh; nothing needs restarting."
      Start-Process "http://127.0.0.1:$($old.frontend_port)"
      $Report.steps.launch = "already running"; Save-Report; exit 0
    }
    Fail "launch" "Stale NSE Universe processes ($($alive -join ', ')) are running but unhealthy. Run scripts\stop.ps1, then rerun."
  }
}

# ---------------------------------------------------------------- 3. dependencies
$backend = Join-Path $Root "backend"
$frontend = Join-Path $Root "frontend"
$venvPy = Join-Path $backend ".venv\Scripts\python.exe"

if (Test-Path $venvPy) {
  $existing = Get-Ver $venvPy @()
  if (-not $existing -or $existing.Minor -lt 11 -or $existing.Minor -gt 14) {
    Fail "venv" "backend\.venv exists but uses Python $existing. Rename or remove that folder, then rerun."
  }
  Say "Reusing backend\.venv (Python $existing)"
} else {
  Say "Creating backend\.venv ..."
  $argList = (($pyPrefix + @("-m", "venv", "`"$backend\.venv`"")) -join " ")
  $code = Invoke-Logged "venv" $pyExe $argList $backend
  if ($code -ne 0 -or -not (Test-Path $venvPy)) { Fail "venv" "venv creation failed (logs\venv.err.log)" }
}
$Report.steps.venv = "ok"

function Get-Hash([string[]]$files) {
  $all = ($files | ForEach-Object { (Get-FileHash -Algorithm SHA256 $_).Hash }) -join ""
  return $all
}
$pipHashFile = Join-Path $Logs "deps-backend.sha256"
$pipHash = Get-Hash @((Join-Path $backend "requirements.txt"), (Join-Path $backend "requirements-dev.txt"), (Join-Path $backend "requirements-research.txt"))
if ((Test-Path $pipHashFile) -and ((Get-Content $pipHashFile -Raw).Trim() -eq $pipHash)) {
  Say "Backend packages unchanged since last successful install; skipping."
} else {
  Say "Installing backend packages (this can take a few minutes) ..."
  $null = Invoke-Logged "pip-upgrade" $venvPy "-m pip install --upgrade pip" $backend
  $code = Invoke-Logged "pip-install" $venvPy "-m pip install -r requirements-dev.txt" $backend
  if ($code -ne 0) { Fail "pip" "pip install failed (logs\pip-install.err.log)" }
  $null = Invoke-Logged "pip-freeze" $venvPy "-m pip freeze" $backend
  Set-Content -Path $pipHashFile -Value $pipHash
}
$Report.steps.pip = "ok"

$npmHashFile = Join-Path $Logs "deps-frontend.sha256"
$npmHash = Get-Hash @((Join-Path $frontend "package-lock.json"))
$viteOk = Test-Path (Join-Path $frontend "node_modules\vite\bin\vite.js")
if ($viteOk -and (Test-Path $npmHashFile) -and ((Get-Content $npmHashFile -Raw).Trim() -eq $npmHash)) {
  Say "Frontend packages unchanged since last successful install; skipping."
} else {
  Say "Installing frontend packages (npm ci) ..."
  $code = Invoke-Logged "npm-ci" $env:ComSpec "/c npm ci --no-audit --no-fund" $frontend
  if ($code -ne 0) { Fail "npm" "npm ci failed (logs\npm-ci.err.log). If it mentions EPERM or EBUSY, close any program using the project folder and run scripts\stop.ps1, then rerun." }
  Set-Content -Path $npmHashFile -Value $npmHash
}
$Report.steps.npm = "ok"

$envFile = Join-Path $backend ".env"
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $backend ".env.example") $envFile
  Say "Created backend\.env from .env.example. Fill in the KOTAK_* values yourself before the backend can start."
  $Report.env_file = "created from example"
} else {
  Say "backend\.env exists (left unchanged; secrets not read)."
  $Report.env_file = "existing, unchanged"
}

# ---------------------------------------------------------------- 4. offline checks
if ($Checks -and -not $SkipChecks) {
  $checks = @(
    @("ruff", $venvPy, "-m ruff check .", $backend),
    @("mypy", $venvPy, "-m mypy", $backend),
    @("pytest", $venvPy, "-m pytest -q -p no:cacheprovider", $backend),
    @("tsc", $env:ComSpec, "/c npm run typecheck", $frontend),
    @("vitest", $env:ComSpec, "/c npm test", $frontend),
    @("build", $env:ComSpec, "/c npm run build", $frontend)
  )
  $failed = @()
  foreach ($c in $checks) {
    Say "Check: $($c[0]) ..."
    $code = Invoke-Logged ("check-" + $c[0]) $c[1] $c[2] $c[3]
    $Report.steps["check_" + $c[0]] = if ($code -eq 0) { "ok" } else { "failed (exit $code)" }
    if ($code -ne 0) { $failed += $c[0]; Say "  -> FAILED (logs\check-$($c[0]).out.log)" } else { Say "  -> ok" }
  }
  if ($failed.Count -gt 0) { Fail "checks" ("Failed: " + ($failed -join ", ") + ". Servers not started.") }
}

# ---------------------------------------------------------------- 5. launch
$bePort = Find-FreePort 8000
$fePort = Find-FreePort 5173
if (-not $bePort -or -not $fePort) { Fail "ports" "No free port near 8000/5173." }
if ($bePort -ne 8000) { Say "Port 8000 is in use by another program; using $bePort." }
if ($fePort -ne 5173) { Say "Port 5173 is in use by another program; using $fePort." }

$env:APP_HOST = "127.0.0.1"
$env:APP_PORT = "$bePort"
$env:ALLOWED_ORIGINS = "http://localhost:$fePort,http://127.0.0.1:$fePort"
$env:NSE_BACKEND_URL = "http://127.0.0.1:$bePort"
$env:APP_RELOAD = "1"   # backend restarts itself when a file in backend\app changes

$be = Start-Process -FilePath $venvPy -ArgumentList "-m app" -WorkingDirectory $backend `
  -RedirectStandardOutput (Join-Path $Logs "backend-console.out.log") `
  -RedirectStandardError (Join-Path $Logs "backend-console.err.log") -WindowStyle Hidden -PassThru
$viteJs = Join-Path $frontend "node_modules\vite\bin\vite.js"
$fe = Start-Process -FilePath $node.Source -ArgumentList "`"$viteJs`" --host 127.0.0.1 --port $fePort --strictPort" `
  -WorkingDirectory $frontend `
  -RedirectStandardOutput (Join-Path $Logs "frontend-console.out.log") `
  -RedirectStandardError (Join-Path $Logs "frontend-console.err.log") -WindowStyle Hidden -PassThru

$watcher = Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\watch.ps1`" -Root `"$Root`"" `
  -WindowStyle Hidden -PassThru

@{ backend_pid = $be.Id; frontend_pid = $fe.Id; watcher_pid = $watcher.Id; backend_port = $bePort; frontend_port = $fePort;
   started_at = (Get-Date).ToString("o"); data_mode = "live" } | ConvertTo-Json | Set-Content -Encoding UTF8 $pidFile
$Report.processes = @{ backend_pid = $be.Id; frontend_pid = $fe.Id; backend_port = $bePort; frontend_port = $fePort }

# ---------------------------------------------------------------- 6. verify
$health = Wait-Http "http://127.0.0.1:$bePort/api/health" 40
if (-not $health) {
  $cfg = Select-String -Path (Join-Path $Logs "backend-console.err.log") -Pattern "Configuration error|  - |Refusing" -ErrorAction SilentlyContinue | ForEach-Object { $_.Line }
  Fail "backend_health" ("Backend did not answer /api/health. " + ($cfg -join " ") + " (logs\backend-console.err.log)")
}
$Report.backend_health = $health.Content
Say "Backend health: $($health.Content)"

$status = Wait-Http "http://127.0.0.1:$bePort/api/status" 5
if ($status) {
  $st = $status.Content | ConvertFrom-Json
  $Report.backend_status = @{ auth = $st.auth.state; session = $st.session_id }
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline -and $st.auth.state -in @("not_attempted", "authenticating")) {
    Start-Sleep -Seconds 2
    $st = (Invoke-WebRequest -Uri "http://127.0.0.1:$bePort/api/status" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
  }
  $Report.backend_status.auth = $st.auth.state
  Say "Kotak Neo sign-in: $($st.auth.state)"
  if ($st.auth.last_error) { Say "  reason: $($st.auth.last_error)" }
  Say "Live stream: $($st.stream.state) (starts automatically; market status comes from the exchange feed)"
}

$page = Wait-Http "http://127.0.0.1:$fePort/" 60
if (-not $page) { Fail "frontend_http" "Frontend did not answer (logs\frontend-console.out.log)" }
$hasRoot = $page.Content -match 'id="root"'
$proxied = Wait-Http "http://127.0.0.1:$fePort/api/health" 10
$Report.frontend_http = @{ status = $page.StatusCode; app_shell = $hasRoot; api_proxy = [bool]$proxied }
Say "Frontend HTTP $($page.StatusCode); app shell present: $hasRoot; API proxy works: $([bool]$proxied)"

$errText = ""
foreach ($f in "backend-console.err.log", "frontend-console.err.log") {
  $p = Join-Path $Logs $f
  if (Test-Path $p) {
    $bad = Select-String -Path $p -Pattern 'Traceback|"level": "(ERROR|CRITICAL)"|Configuration error' | Select-Object -First 5
    if ($bad) { $errText += ($bad | ForEach-Object { $_.Line }) -join "`n" }
  }
}
$Report.startup_log_errors = $errText
if ($errText) { Say "Startup log lines mentioning errors (review): $errText" } else { Say "No errors in startup logs." }

$Report.steps.launch = "ok"
Say ""
Say "NSE Universe is running (read-only market data, no orders)."
Say "  Dashboard: http://127.0.0.1:$fePort"
Say "  API docs:  http://127.0.0.1:$bePort/docs"
Say "  Edit code or add packages: just refresh the page (backend and frontend update by themselves)."
Say "  Stop (rarely needed): powershell -ExecutionPolicy Bypass -File scripts\stop.ps1"
Save-Report
Start-Process "http://127.0.0.1:$fePort"
