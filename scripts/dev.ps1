# Start backend (127.0.0.1:8000) and frontend (127.0.0.1:5173) in two windows.
#   powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
$root = Split-Path -Parent $PSScriptRoot
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\backend'; .\.venv\Scripts\python.exe -m app"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\frontend'; npm run dev"
Write-Host "API docs:  http://127.0.0.1:8000/docs"
Write-Host "Dashboard: http://127.0.0.1:5173"
