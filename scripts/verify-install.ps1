# verify-install.ps1 - local install-behavior verification.
#
# Covers the user-facing install lifecycle end to end:
#   1. install -> first start (gateway, dashboard, autostart, MCP, catalog)
#   2. second start -> routing + MCP + catalog still work
#   3. login relaunch through the OS entry (Run key on Windows)
#   4. macOS install branch modeled inside WSL (fake uname/launchctl sandbox)
#
# Windows lifecycle runs natively; the macOS branch runs through WSL when present
# and skips otherwise (CI Windows runners have no WSL).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "Building bundles..." -ForegroundColor Cyan
npm run build

Write-Host "Running install lifecycle tests (Windows native)..." -ForegroundColor Cyan
node --test test/install-mock.test.mjs

Write-Host "Running macOS install-branch simulation (WSL)..." -ForegroundColor Cyan
node --test test/install-macos-sim.test.mjs

Write-Host "Install behavior verified." -ForegroundColor Green
