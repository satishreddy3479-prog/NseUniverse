@echo off
rem Double-click to open NSE Universe. Starts it if it is not running; otherwise just opens the page.
rem Code and package changes show up on a browser refresh: there is nothing to stop or restart.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1" %*
if errorlevel 1 (
  echo.
  echo Something failed. Details: logs\launch-summary.txt
  pause
) else (
  timeout /t 4 >nul
)
