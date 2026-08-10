#!/bin/sh
# Remove ModelDock: the owned gateway, the autostart entry, the install state
# (except the memory vault), and the gateway log.
# Ownership-list discipline: only ModelDock-owned processes and paths are
# touched, never a recursive sweep of user state. The memory vault is a user
# asset and is preserved; the ~/.codex config backup
# (config.toml.modeldock-backup-*) is also kept for recovery.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
# Runtime state (owner records, caller key, catalog, memory) follows
# MODELDOCK_STATE_DIR everywhere else; MODELDOCK_ROOT only ever names the
# install directory. Honour both so a custom state dir is cleaned up too.
STATE_DIR="${MODELDOCK_STATE_DIR:-${MODELDOCK_ROOT:-$HOME/.modeldock}}"
LOG="$ROOT/modeldock.log"
PORT="${MODELDOCK_PORT:-4097}"

# Stop the gateway: only the pid recorded in the owner file is ours. A live
# process with no matching owner record is foreign - warn and leave it alone.
OWNER_FILE="$STATE_DIR/owner-$PORT.json"
OWNER_PID=""
if [ -f "$OWNER_FILE" ]; then
  OWNER_PID=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$OWNER_FILE" | head -n 1)
fi

find_node() {
  if [ -n "${MODELDOCK_NODE_PATH:-}" ] && [ -x "$MODELDOCK_NODE_PATH" ]; then
    printf '%s\n' "$MODELDOCK_NODE_PATH"
    return
  fi
  for candidate in "$ROOT"/node/v*/bin/node; do
    [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return; }
  done
  command -v node 2>/dev/null || true
}
NODE_BIN="$(find_node)"

# Confirm the recorded PID is really our gateway before killing it: after a reboot
# the owner file can name a PID that has since been reused by an unrelated process.
# The owner fields and the exact gateway entry path must both match.
owner_is_ours() {
  pid="$1"
  [ -n "$pid" ] && [ -n "$NODE_BIN" ] || return 1
  "$NODE_BIN" --input-type=module - "$OWNER_FILE" "$pid" "$ROOT" "$PORT" <<'NODE'
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [ownerFile, pid, root, port] = process.argv.slice(2);
try {
  const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  const thisRoot = path.resolve(root);
  if (Number(owner?.pid) !== Number(pid) || Number(owner?.port) !== Number(port) || path.resolve(String(owner?.root || "")) !== thisRoot) {
    process.exit(1);
  }
  const candidates = [path.join(thisRoot, "src", "server.mjs"), path.join(thisRoot, "dist", "modeldock.mjs")];
  let matches = false;
  if (process.platform === "linux") {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0").filter(Boolean);
    matches = argv.some((arg) => candidates.includes(path.resolve(arg)));
  } else {
    const command = execFileSync("ps", ["-p", pid, "-o", "command="], { encoding: "utf8" });
    matches = candidates.some((candidate) => command.includes(candidate));
  }
  process.exit(matches ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}

if [ -n "$OWNER_PID" ] && kill -0 "$OWNER_PID" 2>/dev/null && owner_is_ours "$OWNER_PID"; then
  kill "$OWNER_PID" 2>/dev/null || true
  echo "Stopped gateway process $OWNER_PID"
elif [ -n "$OWNER_PID" ] && kill -0 "$OWNER_PID" 2>/dev/null; then
  echo "WARNING: recorded PID $OWNER_PID could not be verified as this install; not killing (possible PID reuse)."
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
