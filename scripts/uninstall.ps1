# Remove ModelDock: stop the gateway, drop the autostart Run key, delete the
# install dir and the gateway log. Ownership-list discipline: only
# ModelDock-owned paths are touched, never a recursive sweep of user state.
# The ~/.codex config backup (config.toml.modeldock-backup-*) is kept:
# recover.ps1 still needs it, and an uninstall must never destroy recovery data.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stateDir = if ($env:MODELDOCK_ROOT) { $env:MODELDOCK_ROOT } else { Join-Path $HOME ".modeldock" }
$log = Join-Path $root "modeldock.log"
$port = if ($env:MODELDOCK_PORT) { [int]$env:MODELDOCK_PORT } else { 4097 }

# Stop the gateway: find the listener on the configured port and terminate it.
$procIds = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
foreach ($procId in $procIds) {
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    Write-Output "Stopped gateway process $procId"
}

# Drop the autostart Run key (HKCU\...\Run ModelDock, as written by autostart.mjs).
reg.exe delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v ModelDock /f 2>$null | Out-Null
Write-Output "Removed autostart Run key"

if (Test-Path -LiteralPath $stateDir) {
    Remove-Item -LiteralPath $stateDir -Recurse -Force
    Write-Output "Removed install dir: $stateDir"
} else {
    Write-Output "No install dir at $stateDir; nothing to remove."
}
Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue

Write-Output "ModelDock uninstalled. Your ~/.codex config backup (config.toml.modeldock-backup-*) was kept for recovery."
