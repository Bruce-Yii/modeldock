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

# Restart script (same content as the repo's scripts/restart.ps1). Written by the
# installer so the model-facing "Restarting the gateway" instruction baked into the
# catalog resolves to a real file in the installed layout.
$restart = Join-Path $root "scripts\restart.ps1"
@'
# restart.ps1 - restart the ModelDock gateway service.
#
# The model (Codex/DeepSeek/Luna) can restart the gateway itself by running:
#   powershell -ExecutionPolicy Bypass -File <modeldock>\scripts\restart.ps1
#
# What it does:
#   1. Reads MODELDOCK_PORT from <modeldock>\.env (default 4097).
#   2. Stops the process listening on that port (if any).
#   3. Starts a fresh detached node process from the project root.
#   4. Waits for /healthz and reports the result.

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env"

$port = 4097
if (Test-Path $envFile) {
  $line = Select-String -Path $envFile -Pattern '^MODELDOCK_PORT=' | Select-Object -First 1
  if ($line) {
    $parsed = 0
    if ([int]::TryParse(($line.Line -replace '^MODELDOCK_PORT=', ''), [ref]$parsed) -and $parsed -gt 0) {
      $port = $parsed
    }
  }
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $oldPid = $listener.OwningProcess
  # Ownership guard: the gateway records {pid, root} per port in
  # ~/.modeldock/owner-<port>.json. If the recorded owner is a *different*
  # checkout, killing it would swap live traffic onto this checkout's code -
  # exactly the lookalike-instance mixup we have hit before. Refuse unless -Force.
  # Must match ownerFilePath() in src/instance-owner.mjs, including the
  # MODELDOCK_STATE_DIR redirect, or the guard reads a file the gateway never wrote.
  $stateDir = if ($env:MODELDOCK_STATE_DIR) { $env:MODELDOCK_STATE_DIR } else { Join-Path $env:USERPROFILE ".modeldock" }
  $ownerFile = Join-Path $stateDir "owner-$port.json"
  if ((Test-Path $ownerFile) -and (-not $args.Contains("-Force"))) {
    try {
      $owner = Get-Content $ownerFile -Raw | ConvertFrom-Json
      if ($owner.root -and $owner.pid -eq $oldPid) {
        $ownerRoot = [System.IO.Path]::GetFullPath($owner.root)
        $thisRoot = [System.IO.Path]::GetFullPath($root)
        if ($ownerRoot -ne $thisRoot) {
          Write-Output "ERROR: port $port is owned by a gateway from '$ownerRoot' (PID $oldPid); this script runs from '$thisRoot'."
          Write-Output "Re-run with -Force to take the port over deliberately."
          exit 1
        }
      }
    } catch {
      # Unreadable owner file: fall through and behave as before.
    }
  }
  Write-Output "restart.ps1: stopping gateway (PID $oldPid, port $port)"
  Stop-Process -Id $oldPid -Force
  for ($i = 0; $i -lt 20; $i += 1) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }
  }
} else {
  Write-Output "restart.ps1: no gateway on port $port; starting fresh"
}

$logDir = Join-Path $env:TEMP "modeldock"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stdout = Join-Path $logDir "gateway.log"
$stderr = Join-Path $logDir "gateway.err.log"

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
  Write-Output "ERROR: node.exe not found on PATH"
  exit 1
}

# Prefer src/server.mjs (git checkout: restart the code being edited); fall back
# to the built bundle (installed layout ships dist/modeldock.mjs only). Mirrors
# the server-selection in start-hidden.ps1.
$server = Join-Path $root "src\server.mjs"
if (-not (Test-Path -LiteralPath $server)) { $server = Join-Path $root "dist\modeldock.mjs" }

Start-Process -FilePath $nodeExe -ArgumentList $server -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
Write-Output "restart.ps1: started gateway from $root (logs: $logDir)"

for ($i = 0; $i -lt 40; $i += 1) {
  Start-Sleep -Milliseconds 250
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2
    if ($health.ok) {
      Write-Output "restart.ps1: gateway healthy at http://127.0.0.1:$port"
      exit 0
    }
  } catch {
    # Gateway still booting; keep polling.
  }
}

Write-Output "ERROR: gateway did not become healthy within 10s"
if (Test-Path $stderr) { Get-Content $stderr -Tail 10 -ErrorAction SilentlyContinue }
exit 1
'@ | Out-File -FilePath $restart -Encoding ascii

# Manual recovery menu: restart the gateway or restore the native Codex route.
$recover = Join-Path $root "scripts\recover.ps1"
@'
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$port = 4097
$envFile = Join-Path $root ".env"
if (Test-Path -LiteralPath $envFile) {
  $line = Select-String -Path $envFile -Pattern '^MODELDOCK_PORT=' | Select-Object -First 1
  $parsed = 0
  if ($line -and [int]::TryParse(($line.Line -replace '^MODELDOCK_PORT=', ''), [ref]$parsed) -and $parsed -gt 0) { $port = $parsed }
}
function Restart-Gateway {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\restart.ps1")
  if ($LASTEXITCODE -ne 0) { throw "gateway restart failed" }
}
function Restore-Native {
  try {
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/config/disable" -TimeoutSec 3 | Out-Null
    Write-Output "Codex native route restored through the running gateway."
    return
  } catch { Write-Output "Gateway is unavailable; restoring from the local backup." }
  $codexHome = if ($env:MODELDOCK_CODEX_HOME) { $env:MODELDOCK_CODEX_HOME } elseif ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
  $statePath = Join-Path $codexHome "modeldock\config-switch-state.json"
  if (-not (Test-Path -LiteralPath $statePath)) { throw "ModelDock switch state was not found: $statePath" }
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  if (-not $state.enabled) { Write-Output "Codex is already on the native route."; return }
  $backup = [System.IO.Path]::GetFullPath([string]$state.backupPath)
  if (-not (Test-Path -LiteralPath $backup)) { throw "ModelDock backup is missing: $backup" }
  $config = Join-Path $codexHome "config.toml"
  if (Test-Path -LiteralPath $config) {
    Copy-Item -LiteralPath $config -Destination "$config.native-recovery-$(Get-Date -Format yyyyMMdd-HHmmss).bak"
    if (-not $state.originalExisted) { Remove-Item -LiteralPath $config -Force } else { Copy-Item -LiteralPath $backup -Destination $config -Force }
  } elseif ($state.originalExisted) { Copy-Item -LiteralPath $backup -Destination $config -Force }
  $state.enabled = $false; $state.restartRequired = $true; $state.lastBackupPath = $backup
  $state.changedAt = (Get-Date).ToUniversalTime().ToString("o")
  $tmp = "$statePath.$PID.tmp"
  $state | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $tmp -Encoding utf8
  Move-Item -LiteralPath $tmp -Destination $statePath -Force
  Write-Output "Codex native route restored from $backup"
  Write-Output "Fully quit and restart Codex."
}
Write-Output "ModelDock manual recovery"
Write-Output "1. Restart ModelDock gateway"
Write-Output "2. Restore Codex native route"
Write-Output "Q. Quit"
$choice = (Read-Host "Choose 1, 2, or Q").Trim().ToUpperInvariant()
try {
  if ($choice -eq "1") { Restart-Gateway } elseif ($choice -eq "2") { Restore-Native } elseif ($choice -ne "Q" -and $choice -ne "") { throw "Unknown choice: $choice" }
} catch { Write-Error $_.Exception.Message; exit 1 }
'@ | Out-File -FilePath $recover -Encoding ascii

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
if (-not $skipOpen) { Start-Process "http://127.0.0.1:$port/?settings=1" }
