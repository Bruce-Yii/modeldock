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

# Start-at-login repair: when the autostart decision mark exists but the Run key
# is gone (registry cleanup, earlier toggle-off that deleted the key), re-write
# the login entry before restarting the gateway. A missing mark means no decision
# was ever recorded, so an explicit off is never silently overridden.
$autostartKeyName = if ($env:MODELDOCK_AUTOSTART_KEY) { $env:MODELDOCK_AUTOSTART_KEY } else { "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" }
$autostartValueName = if ($env:MODELDOCK_AUTOSTART_NAME) { $env:MODELDOCK_AUTOSTART_NAME } else { "ModelDock" }
$autostartStateDir = if ($env:MODELDOCK_STATE_DIR) { $env:MODELDOCK_STATE_DIR } else { $root }
$autostartMark = Join-Path $autostartStateDir "autostart-initialized"

function Repair-Autostart {
  if (-not (Test-Path -LiteralPath $autostartMark)) { return }
  $subKey = $autostartKeyName
  if ($subKey -like "HKEY_CURRENT_USER\*") { $subKey = $subKey.Substring("HKEY_CURRENT_USER\".Length) }
  elseif ($subKey -like "HKCU\*") { $subKey = $subKey.Substring("HKCU\".Length) }
  $runKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subKey)
  try {
    if ($runKey -and ($null -ne $runKey.GetValue($autostartValueName, $null))) {
      Write-Output "  start at login: OK"
      return
    }
  } finally { if ($runKey) { $runKey.Close() } }
  $launcher = Join-Path $root "scripts\start-hidden.ps1"
  if (-not (Test-Path -LiteralPath $launcher)) {
    Write-Warning "  start at login: launcher missing ($launcher); not repairing"
    return
  }
  $runKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($subKey)
  try {
    $runCommand = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`""
    $runKey.SetValue($autostartValueName, $runCommand, [Microsoft.Win32.RegistryValueKind]::String)
    Write-Output "  start at login was missing - re-enabled"
  } finally { if ($runKey) { $runKey.Close() } }
}

function Restart-Gateway {
  Repair-Autostart
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
  # Rebuild the state as a fresh ordered map: Windows PowerShell 5.1 throws when a
  # property that ConvertFrom-Json did not create (here lastBackupPath) is set via
  # dot assignment, so copy the existing keys and override the ones we change.
  $out = [ordered]@{}
  foreach ($p in $state.PSObject.Properties) { $out[$p.Name] = $p.Value }
  $out['enabled'] = $false
  $out['restartRequired'] = $true
  $out['lastBackupPath'] = $backup
  $out['changedAt'] = (Get-Date).ToUniversalTime().ToString("o")
  $tmp = "$statePath.$PID.tmp"
  # Write UTF-8 without a BOM: the gateway reads this file with Node's utf8 and a
  # BOM would make JSON.parse fail (Set-Content -Encoding utf8 emits a BOM on 5.1).
  [System.IO.File]::WriteAllText($tmp, ($out | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
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
