# One-time setup on Windows 11 (PowerShell). Run from the project root:
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
# Installs dependencies locally (backend\.venv, frontend\node_modules). Makes no broker calls.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "Checking tools..."
if (-not (Get-Command py -ErrorAction SilentlyContinue)) { throw "Python launcher 'py' not found. Install Python 3.11-3.14 from python.org." }
& py -3 -c "import sys; assert (3,11) <= sys.version_info[:2] < (3,15), sys.version; print('Python', sys.version.split()[0])"
if ($LASTEXITCODE -ne 0) { throw "Python 3.11-3.14 is required." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js not found. Install Node 22 LTS." }
Write-Host ("Node " + (node --version))

Write-Host "Backend: creating virtual environment and installing packages..."
Set-Location "$root\backend"
if (-not (Test-Path ".venv")) { & py -3 -m venv .venv }
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
if ($LASTEXITCODE -ne 0) { throw "pip install failed." }
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created backend\.env from .env.example. Edit it yourself for live mode."
}

Write-Host "Frontend: installing packages..."
Set-Location "$root\frontend"
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }

Set-Location $root
Write-Host "Setup complete. Start everything with: powershell -ExecutionPolicy Bypass -File scripts\dev.ps1"
