# ModelDock manual recovery menu.
# Choose gateway restart or restore the last native Codex configuration.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$port = 4097
$envFile = Join-Path $root ".env"
if (Test-Path -LiteralPath $envFile) {
  $line = Select-String -Path $envFile -Pattern '^MODELDOCK_PORT=' | Select-Object -First 1
  $parsed = 0
  if ($line -and [int]::TryParse(($line.Line -replace '^MODELDOCK_PORT=', ''), [ref]$parsed) -and $parsed -gt 0) {
    $port = $parsed
  }
}

function Restart-Gateway {
  $restart = Join-Path $root "scripts\restart.ps1"
  if (-not (Test-Path -LiteralPath $restart)) {
    throw "restart.ps1 is missing from $root"
  }
  & powershell -NoProfile -ExecutionPolicy Bypass -File $restart
  if ($LASTEXITCODE -ne 0) { throw "gateway restart failed" }
}

function Restore-Native {
  $uri = "http://127.0.0.1:$port/api/config/disable"
  try {
    Invoke-RestMethod -Method Post -Uri $uri -TimeoutSec 3 | Out-Null
    Write-Output "Codex native route restored through the running gateway."
    return
  } catch {
    Write-Output "Gateway is unavailable; restoring from the local backup."
  }

  $codexHome = if ($env:MODELDOCK_CODEX_HOME) { $env:MODELDOCK_CODEX_HOME } elseif ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
  $statePath = Join-Path $codexHome "modeldock\config-switch-state.json"
  if (-not (Test-Path -LiteralPath $statePath)) { throw "ModelDock switch state was not found: $statePath" }
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  if (-not $state.enabled) {
    Write-Output "Codex is already on the native route."
    return
  }
  $backup = [System.IO.Path]::GetFullPath([string]$state.backupPath)
  if (-not (Test-Path -LiteralPath $backup)) { throw "ModelDock backup is missing: $backup" }
  $config = Join-Path $codexHome "config.toml"
  if (Test-Path -LiteralPath $config) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Copy-Item -LiteralPath $config -Destination "$config.native-recovery-$stamp.bak"
    if (-not $state.originalExisted) { Remove-Item -LiteralPath $config -Force }
    else { Copy-Item -LiteralPath $backup -Destination $config -Force }
  } elseif ($state.originalExisted) {
    Copy-Item -LiteralPath $backup -Destination $config -Force
  }
  $state.enabled = $false
  $state.restartRequired = $true
  $state.lastBackupPath = $backup
  $state.changedAt = (Get-Date).ToUniversalTime().ToString("o")
  $tmp = "$statePath.$PID.tmp"
  $state | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $tmp -Encoding utf8
  Move-Item -LiteralPath $tmp -Destination $statePath -Force
  Write-Output "Codex native route restored from $backup"
  Write-Output "Fully quit and restart Codex."
}

Write-Output ""
Write-Output "ModelDock manual recovery"
Write-Output "1. Restart ModelDock gateway"
Write-Output "2. Restore Codex native route"
Write-Output "Q. Quit"
$choice = (Read-Host "Choose 1, 2, or Q").Trim().ToUpperInvariant()
try {
  if ($choice -eq "1") { Restart-Gateway }
  elseif ($choice -eq "2") { Restore-Native }
  elseif ($choice -eq "Q" -or $choice -eq "") { exit 0 }
  else { throw "Unknown choice: $choice" }
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
