# Start the ModelDock gateway hidden (no console window) with the package root as the
# working directory. Used by the autostart Run key entry and by dashboard.bat.
# Prefers the built single-file bundle (dist/modeldock.mjs); falls back to the source
# entry in a git checkout.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$bundle = Join-Path $root "dist\modeldock.mjs"
$server = Join-Path $root "src\server.mjs"
if (Test-Path -LiteralPath $bundle) { $server = $bundle }
# Log instead of discarding: a hidden start that dies (node missing, port taken, bad
# bundle) is otherwise completely silent. cmd.exe does the redirection so Start-Process
# stays on the ShellExecute path - its -RedirectStandard* parameters switch to
# CreateProcess with handle inheritance, which leaves the caller's pipes open and hangs
# any parent waiting for them to close.
$log = Join-Path $root "modeldock.log"
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "node `"$server`" >> `"$log`" 2>&1" -WorkingDirectory $root -WindowStyle Hidden
