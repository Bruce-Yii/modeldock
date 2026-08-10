#!/bin/sh
# Remove ModelDock: the owned gateway, the autostart entry, the install state
# (except the memory vault), and the gateway log.
# Ownership-list discipline: only ModelDock-owned processes and paths are
# touched, never a recursive sweep of user state. The memory vault is a user
# asset and is preserved; the ~/.codex config backup
# (config.toml.modeldock-backup-*) is also kept for recovery.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
STATE_DIR="${MODELDOCK_ROOT:-$HOME/.modeldock}"
LOG="$ROOT/modeldock.log"
PORT="${MODELDOCK_PORT:-4097}"

# Stop the gateway: only the pid recorded in the owner file is ours. A live
# process with no matching owner record is foreign - warn and leave it alone.
OWNER_FILE="$STATE_DIR/owner-$PORT.json"
OWNER_PID=""
if [ -f "$OWNER_FILE" ]; then
  OWNER_PID=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$OWNER_FILE" | head -n 1)
fi

find_listener_pid() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true
  elif command -v ss >/dev/null 2>&1; then
    ss -tlnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -n 1 | cut -d= -f2 || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser "$PORT/tcp" 2>/dev/null | tr ' ' '\n' | sed '/^$/d' | head -n 1 || true
  else
    true
  fi
}

# Confirm the recorded PID is really our gateway before killing it: after a reboot
# the owner file can name a PID that has since been reused by an unrelated process.
# Accept it only if it is the current listener on our port, or its command line
# references this install root.
owner_is_ours() {
  pid="$1"
  [ -n "$pid" ] || return 1
  listener="$(find_listener_pid)"
  [ -n "$listener" ] && [ "$listener" = "$pid" ] && return 0
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$cmd" in
    *"$ROOT"*) return 0 ;;
    *"$STATE_DIR"*) return 0 ;;
  esac
  return 1
}

if [ -n "$OWNER_PID" ] && kill -0 "$OWNER_PID" 2>/dev/null && owner_is_ours "$OWNER_PID"; then
  kill "$OWNER_PID" 2>/dev/null || true
  echo "Stopped gateway process $OWNER_PID"
elif [ -n "$OWNER_PID" ] && kill -0 "$OWNER_PID" 2>/dev/null; then
  echo "WARNING: recorded PID $OWNER_PID is not listening on port $PORT and does not look like this install; not killing (possible PID reuse)."
else
  echo "WARNING: no live ModelDock-owned gateway found on port $PORT; nothing was stopped."
fi

if [ "$(uname -s)" = "Darwin" ]; then
  PLIST_DIR="${MODELDOCK_AUTOSTART_PLIST_DIR:-$HOME/Library/LaunchAgents}"
  PLIST="$PLIST_DIR/com.modeldock.gateway.plist"
  if [ -f "$PLIST" ]; then
    launchctl unload -w "$PLIST" >/dev/null 2>&1 || true
    rm -f "$PLIST"
    echo "Removed autostart entry: $PLIST"
  fi
fi

# Clear the install state but preserve the memory vault: MEMORY.md captures and
# global.db and node databases are user data, not disposable runtime state.
if [ -d "$STATE_DIR" ]; then
  for entry in "$STATE_DIR"/* "$STATE_DIR"/.[!.]*; do
    [ -e "$entry" ] || continue
    case "$(basename "$entry")" in
      memory) continue ;;
    esac
    rm -rf "$entry"
  done
  echo "Cleared install state: $STATE_DIR (memory vault preserved)"
else
  echo "No install dir at $STATE_DIR; nothing to remove."
fi
rm -f "$LOG"

echo "ModelDock uninstalled. Your memory vault ($STATE_DIR/memory) and ~/.codex config backup (config.toml.modeldock-backup-*) were preserved for recovery."
