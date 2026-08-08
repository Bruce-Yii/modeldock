#!/bin/sh
# Remove ModelDock: the autostart entry, the install dir, and the gateway log.
# Ownership-list discipline: only ModelDock-owned paths are touched, never a
# recursive sweep of user state.
#   - macOS: ~/Library/LaunchAgents/com.modeldock.gateway.plist + launchctl
#   - the install dir (~/.modeldock by default; MODELDOCK_ROOT overrides)
#   - the gateway log next to this script
# The ~/.codex config backup (config.toml.modeldock-backup-*) is kept: recover.sh
# still needs it, and an uninstall must never destroy recovery data.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
STATE_DIR="${MODELDOCK_ROOT:-$HOME/.modeldock}"
LOG="$ROOT/modeldock.log"

if [ "$(uname -s)" = "Darwin" ]; then
  PLIST_DIR="${MODELDOCK_AUTOSTART_PLIST_DIR:-$HOME/Library/LaunchAgents}"
  PLIST="$PLIST_DIR/com.modeldock.gateway.plist"
  if [ -f "$PLIST" ]; then
    launchctl unload -w "$PLIST" >/dev/null 2>&1 || true
    rm -f "$PLIST"
    echo "Removed autostart entry: $PLIST"
  fi
fi

if [ -d "$STATE_DIR" ]; then
  rm -rf "$STATE_DIR"
  echo "Removed install dir: $STATE_DIR"
else
  echo "No install dir at $STATE_DIR; nothing to remove."
fi
rm -f "$LOG"

echo "ModelDock uninstalled. Your ~/.codex config backup (config.toml.modeldock-backup-*) was kept for recovery."
