#!/bin/sh
# Start the ModelDock gateway in the background with no attached terminal and the
# package root as the working directory. Used by the dashboard and for manual
# background starts on macOS/Linux.
set -e
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
if [ -f "$ROOT/dist/modeldock.mjs" ]; then
  SERVER="$ROOT/dist/modeldock.mjs"
else
  SERVER="$ROOT/src/server.mjs"
fi
cd "$ROOT"
# Log instead of discarding: a background start that dies (bad node, port in use,
# missing file) is otherwise completely silent for the user.
nohup node "$SERVER" >>"$ROOT/modeldock.log" 2>&1 &
