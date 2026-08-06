#!/bin/sh
# ModelDock installer (macOS / Linux).
#
# User-side bootstrap: runs BEFORE Node is guaranteed to exist, so it must stay a
# plain shell script (an .mjs installer would need Node already - chicken and egg).
#
#   curl -fsSL https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.sh | sh
#
# What it does:
#   1. Check Node >= 22; if missing, print instructions and exit.
#   2. Lay out the install dir at ~/.modeldock: dist/modeldock.mjs (downloaded from the
#      newest GitHub Release) + scripts/start-hidden.sh (background launcher used by the
#      dashboard's start-at-login toggle and the one-click updater).
#   3. Start ModelDock in the background (skipped if one is already running) and print
#      the dashboard URL.
# Tokens are NOT asked for here - the dashboard opens its Settings dialog on first run.
#
# Overrides (optional; used by the mock-install test and mirror deployments):
#   MODELDOCK_ROOT          install directory             (default: ~/.modeldock)
#   MODELDOCK_REPO          GitHub repo                   (default: architectds/modeldock)
#   MODELDOCK_RELEASE_URL   direct asset URL (overrides MODELDOCK_REPO)
#   MODELDOCK_PORT          dashboard port                (default: 4097)
#   MODELDOCK_SKIP_OPEN     set to "1" to not open a browser

set -eu

REPO="${MODELDOCK_REPO:-architectds/modeldock}"
PORT="${MODELDOCK_PORT:-4097}"
ROOT="${MODELDOCK_ROOT:-$HOME/.modeldock}"
RELEASE_URL="${MODELDOCK_RELEASE_URL:-https://github.com/$REPO/releases/latest/download/modeldock.mjs}"
SKIP_OPEN="${MODELDOCK_SKIP_OPEN:-0}"

echo "ModelDock installer"

# 1. Node >= 22
NODE_MAJOR=""
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node --version | sed -n 's/^v\([0-9]*\).*/\1/p')
fi
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 22 ]; then
  echo ""
  echo "Node.js 22 or newer is required but was not found."
  echo "Install the LTS version from https://nodejs.org (or: brew install node),"
  echo "reopen your terminal, then run this installer again."
  exit 1
fi
echo "  node $(node --version) - OK"

# 2. Install layout
mkdir -p "$ROOT/dist" "$ROOT/scripts"

BUNDLE="$ROOT/dist/modeldock.mjs"
echo "  downloading latest release bundle..."
curl -fL --progress-bar "$RELEASE_URL" -o "$BUNDLE"
echo "  saved $BUNDLE"

# Background launcher (same content as the repo's scripts/start-hidden.sh). Written by
# the installer so a single-file download still gets autostart + self-update restarts.
LAUNCHER="$ROOT/scripts/start-hidden.sh"
cat > "$LAUNCHER" <<'EOF'
#!/bin/sh
set -e
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
if [ -f "$ROOT/dist/modeldock.mjs" ]; then
  SERVER="$ROOT/dist/modeldock.mjs"
else
  SERVER="$ROOT/src/server.mjs"
fi
cd "$ROOT"
nohup node "$SERVER" >/dev/null 2>&1 &
EOF
chmod +x "$LAUNCHER"

# 3. Start (unless already running) and point at the dashboard
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/healthz"; then
  echo "  ModelDock is already running on port $PORT - keeping it."
else
  echo "  starting ModelDock in the background..."
  "$LAUNCHER"
  sleep 3
fi

echo ""
echo "Done. Dashboard: http://127.0.0.1:$PORT"
echo "First run: paste your API token into the Settings dialog that opens automatically."
echo "Optional: flip the 'Start at login' toggle on the dashboard."
if [ "$SKIP_OPEN" != "1" ]; then
  command -v open >/dev/null 2>&1 && open "http://127.0.0.1:$PORT" || true
fi
