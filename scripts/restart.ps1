# restart.ps1 - restart the ModelDock gateway service.
#
# The model (Codex/DeepSeek/Luna) can restart the gateway itself by running:
#   powershell -ExecutionPolicy Bypass -File <modeldock>\scripts\restart.ps1
#
# What it does:
#   1. Reads MODELDOCK_PORT from <modeldock>\.env (default 4097).
#   2. Stops the process listening on that port (if any).
#   3. Starts a fresh detached `node src/server.mjs` from the project root.
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

# Prefer an explicit path, then a bundled Node under <root>\node (the installer
# downloads Node 22 LTS there when none is on PATH), then PATH.
$nodeExe = $null
if ($env:MODELDOCK_NODE_PATH -and (Test-Path -LiteralPath $env:MODELDOCK_NODE_PATH)) { $nodeExe = $env:MODELDOCK_NODE_PATH }
if (-not $nodeExe) {
  $bestDir = @(Get-ChildItem -LiteralPath (Join-Path $root "node") -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match "^v\d+\.\d+\.\d+$" } |
      Sort-Object @{ Expression = {
              if ($_.Name -match "^v(\d+)\.(\d+)\.(\d+)$") { [long]$Matches[1] * 1000000 + [long]$Matches[2] * 1000 + [long]$Matches[3] } else { -1 }
          }; Descending = $true } |
      Select-Object -First 1)
  if ($bestDir -and (Test-Path -LiteralPath (Join-Path $bestDir.FullName "node.exe"))) {
    $nodeExe = Join-Path $bestDir.FullName "node.exe"
  }
}
if (-not $nodeExe) { $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $nodeExe) {
  Write-Output "ERROR: node.exe not found; install Node 22+ or re-run the ModelDock installer"
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
