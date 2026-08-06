# Start the ModelDock gateway hidden (no console window) with the package root as the
# working directory. Used by the autostart Run key entry and by dashboard.bat.
# Prefers the built single-file bundle (dist/modeldock.mjs); falls back to the source
# entry in a git checkout.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$bundle = Join-Path $root "dist\modeldock.mjs"
$server = Join-Path $root "src\server.mjs"
if (Test-Path -LiteralPath $bundle) { $server = $bundle }
Start-Process -FilePath "node" -ArgumentList "`"$server`"" -WorkingDirectory $root -WindowStyle Hidden
