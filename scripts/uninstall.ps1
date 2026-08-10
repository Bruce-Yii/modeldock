# Remove ModelDock: stop the owned gateway, drop the autostart Run key, clear
# the install state (except the memory vault) and remove the gateway log.
# Ownership-list discipline: only ModelDock-owned processes and paths are
# touched, never a recursive sweep of user state. The memory vault is a user
# asset and is preserved; the ~/.codex config backup
# (config.toml.modeldock-backup-*) is also kept for recovery.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stateDir = if ($env:MODELDOCK_ROOT) { $env:MODELDOCK_ROOT } else { Join-Path $HOME ".modeldock" }
$log = Join-Path $root "modeldock.log"
$port = if ($env:MODELDOCK_PORT) { [int]$env:MODELDOCK_PORT } else { 4097 }
$runKey = if ($env:MODELDOCK_AUTOSTART_KEY) { $env:MODELDOCK_AUTOSTART_KEY } else { "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" }

# Stop the gateway: only the pid recorded in the owner file is ours. A listener
# without a matching owner record is a foreign process - warn and leave it.
$ownerPid = $null
$ownerFile = Join-Path $stateDir "owner-$port.json"
if (Test-Path -LiteralPath $ownerFile) {
    try { $ownerPid = [int]((Get-Content -LiteralPath $ownerFile -Raw | ConvertFrom-Json).pid) } catch { $ownerPid = $null }
}
$procIds = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
$stopped = 0
foreach ($procId in $procIds) {
    if ($ownerPid -and $procId -eq $ownerPid) {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        Write-Output "Stopped gateway process $procId"
        $stopped += 1
    } else {
        Write-Output "WARNING: port $port is held by pid $procId which is not the recorded ModelDock gateway (owner pid $ownerPid); leaving it alone."
    }
}
if ($procIds.Count -gt 0 -and $stopped -eq 0) {
    Write-Output "WARNING: no ModelDock-owned listener was found on port $port; nothing was stopped."
}

# Drop the autostart Run key (as written by autostart.mjs).
try {
    reg.exe delete $runKey /v ModelDock /f 2>$null | Out-Null
    Write-Output "Removed autostart Run key"
} catch {
    # A missing key is the normal case on a fresh machine; native stderr can
    # surface as a terminating error under $ErrorActionPreference = "Stop".
    Write-Output "No autostart Run key to remove (or removal failed): $($_.Exception.Message)"
}

# Clear the install state but preserve the memory vault: MEMORY.md captures and
# global.db and node databases are user data, not disposable runtime state.
if (Test-Path -LiteralPath $stateDir) {
    Get-ChildItem -LiteralPath $stateDir -Force | Where-Object { $_.Name -ne "memory" } |
        Remove-Item -Recurse -Force
    Write-Output "Cleared install state: $stateDir (memory vault preserved)"
} else {
    Write-Output "No install dir at $stateDir; nothing to remove."
}
Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue

Write-Output "ModelDock uninstalled. Your memory vault ($stateDir\memory) and ~/.codex config backup (config.toml.modeldock-backup-*) were preserved for recovery."
