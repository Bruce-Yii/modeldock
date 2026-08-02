@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0.."

set "PORT=4097"
set "URL=http://127.0.0.1:%PORT%"

netstat -ano | findstr ":%PORT%" | findstr /i "LISTENING" >nul 2>&1
if errorlevel 1 (
    echo Starting ModelDock gateway...
    start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "node src\server.mjs"
) else (
    echo Gateway already running.
)

set /a tries=0
:wait
timeout /t 1 /nobreak >nul
set /a tries=tries+1
if !tries! GEQ 25 goto open
curl -s -o nul "%URL%/healthz"
if errorlevel 1 goto wait

:open
start "" "%URL%"
exit /b 0