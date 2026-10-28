# Run all offline checks (no broker calls): lint, types, unit tests, frontend tests, production build.
#   powershell -ExecutionPolicy Bypass -File scripts\check.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
function Step($name, [scriptblock]$cmd) {
  Write-Host "== $name"
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "$name failed" }
}
Set-Location "$root\backend"
Step "ruff" { .\.venv\Scripts\python.exe -m ruff check . }
Step "mypy" { .\.venv\Scripts\python.exe -m mypy }
Step "pytest" { .\.venv\Scripts\python.exe -m pytest -q }
Set-Location "$root\frontend"
Step "typecheck" { npm run typecheck }
Step "vitest" { npm test }
Step "build" { npm run build }
Set-Location $root
Write-Host "All offline checks passed."
