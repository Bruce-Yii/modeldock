# ModelDock installer (Windows).
#
# User-side bootstrap: runs BEFORE Node is guaranteed to exist, so it must stay a
# plain PowerShell script (an .mjs installer would need Node already - chicken and egg).
#
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.ps1 | iex"
#
# What it does:
#   1. Check Node >= 22; if missing, open nodejs.org and exit with instructions.
#   2. Lay out the install dir at ~\.modeldock: dist\modeldock.mjs (downloaded from the
#      newest GitHub Release) + scripts\start-hidden.ps1 (hidden launcher used by the
#      dashboard's start-at-login toggle and the one-click updater).
#   3. Start ModelDock hidden (skipped if one is already running) and open the dashboard.
# Tokens are NOT asked for here - the dashboard opens its Settings dialog on first run.
#
# Overrides (optional; used by the mock-install test and mirror deployments):
#   MODELDOCK_ROOT          install directory             (default: ~\.modeldock)
#   MODELDOCK_REPO          GitHub repo                   (default: architectds/modeldock)
#   MODELDOCK_RELEASE_URL   direct asset URL (overrides MODELDOCK_REPO)
#   MODELDOCK_PORT          dashboard port                (default: 4097)
#   MODELDOCK_SKIP_OPEN     set to "1" to not open a browser

$ErrorActionPreference = "Stop"
$repo = if ($env:MODELDOCK_REPO) { $env:MODELDOCK_REPO } else { "architectds/modeldock" }
$port = if ($env:MODELDOCK_PORT) { [int]$env:MODELDOCK_PORT } else { 4097 }
$root = if ($env:MODELDOCK_ROOT) { $env:MODELDOCK_ROOT } else { Join-Path $env:USERPROFILE ".modeldock" }
$releaseUrl = if ($env:MODELDOCK_RELEASE_URL) { $env:MODELDOCK_RELEASE_URL } else { "https://github.com/$repo/releases/latest/download/modeldock.mjs" }
$skipOpen = ($env:MODELDOCK_SKIP_OPEN -eq "1")

Write-Host "ModelDock installer" -ForegroundColor Cyan

# 1. Node >= 22
$nodeOk = $false
try {
    $nodeVersion = (& node --version) 2>$null
    if ($nodeVersion -match "^v(\d+)\.") { $nodeOk = [int]$Matches[1] -ge 22 }
} catch {}
if (-not $nodeOk) {
    Write-Host ""
    Write-Host "Node.js 22 or newer is required but was not found." -ForegroundColor Yellow
    Write-Host "Install the LTS version from https://nodejs.org , reopen your terminal,"
    Write-Host "then run this installer again."
    Start-Process "https://nodejs.org"
    exit 1
}
Write-Host "  node $nodeVersion - OK"

# 2. Install layout
New-Item -ItemType Directory -Force (Join-Path $root "dist") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $root "scripts") | Out-Null

$bundle = Join-Path $root "dist\modeldock.mjs"
Write-Host "  downloading latest release bundle..."
Invoke-WebRequest -UseBasicParsing -Uri $releaseUrl -OutFile $bundle
Write-Host ("  saved {0} ({1:N1} MB)" -f $bundle, ((Get-Item $bundle).Length / 1MB))

# Hidden launcher (same content as the repo's scripts/start-hidden.ps1). Written by the
# installer so a single-file download still gets autostart + self-update restarts.
$launcher = Join-Path $root "scripts\start-hidden.ps1"
@'
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$bundle = Join-Path $root "dist\modeldock.mjs"
$server = Join-Path $root "src\server.mjs"
if (Test-Path -LiteralPath $bundle) { $server = $bundle }
$log = Join-Path $root "modeldock.log"
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "node `"$server`" >> `"$log`" 2>&1" -WorkingDirectory $root -WindowStyle Hidden
'@ | Out-File -FilePath $launcher -Encoding ascii

# 3. Start (unless already running) and open the dashboard
$running = $false
try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2
    $running = $true
} catch {
    # /healthz answers 503 until a token is configured - that still means running
    if ($_.Exception.Response) { $running = $true }
}
if ($running) {
    Write-Host "  ModelDock is already running on port $port - keeping it."
} else {
    Write-Host "  starting ModelDock in the background..."
    & powershell -NoProfile -ExecutionPolicy Bypass -File $launcher
    Start-Sleep -Seconds 3
}

Write-Host ""
Write-Host "Done. Dashboard: http://127.0.0.1:$port" -ForegroundColor Green
Write-Host "First run: paste your API token into the Settings dialog that opens automatically."
Write-Host "Optional: flip the 'Start at login' toggle on the dashboard."
if (-not $skipOpen) { Start-Process "http://127.0.0.1:$port" }
