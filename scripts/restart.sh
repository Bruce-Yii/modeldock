#!/bin/sh
# restart.sh - restart the ModelDock gateway service on macOS/Linux.
#
# The model (Codex/DeepSeek/Luna) can restart the gateway itself by running:
#   sh <modeldock>/scripts/restart.sh
#
# What it does:
#   1. Reads MODELDOCK_PORT from <modeldock>/.env (default 4097).
#   2. On macOS, asks launchd to restart the managed service when it is loaded.
#   3. Otherwise stops the process listening on that port, after an owner check.
#   4. Starts a fresh detached node gateway and waits for /healthz.

set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
FORCE=0
for arg in "$@"; do
  case "$arg" in
    -f|--force|-Force) FORCE=1 ;;
  esac
done

status() {
  printf '%s\n' "$*"
  printf '%s\n' "$*" >&2
}

PORT="${MODELDOCK_PORT:-4097}"
if [ -f "$ENV_FILE" ]; then
  ENV_PORT="$(sed -n 's/^MODELDOCK_PORT=//p' "$ENV_FILE" | tail -n 1 | tr -d '\r' || true)"
  case "$ENV_PORT" in
    ''|*[!0-9]*) ;;
    *) [ "$ENV_PORT" -gt 0 ] && PORT="$ENV_PORT" ;;
  esac
fi

find_listener_pid() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser "$PORT/tcp" 2>/dev/null | tr ' ' '\n' | sed '/^$/d' | head -n 1 || true
  else
    true
  fi
}

resolve_node() {
  if [ -n "${MODELDOCK_NODE_PATH:-}" ] && [ -x "$MODELDOCK_NODE_PATH" ]; then
    printf '%s\n' "$MODELDOCK_NODE_PATH"
    return
  fi

  best_bin=""
  best_v=""
  for d in "$ROOT"/node/v*; do
    [ -d "$d" ] && [ -x "$d/bin/node" ] || continue
    v="$(basename "$d" | sed 's/^v//')"
    if [ -z "$best_v" ] || [ "$(printf '%s\n%s\n' "$v" "$best_v" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)" = "$v" ]; then
      best_bin="$d/bin/node"
      best_v="$v"
    fi
  done
  if [ -n "$best_bin" ]; then
    printf '%s\n' "$best_bin"
    return
  fi

  command -v node || true
}

NODE_BIN="$(resolve_node)"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  status "ERROR: node not found; install Node 22+ or re-run the ModelDock installer"
  exit 1
fi

SERVER="$ROOT/src/server.mjs"
if [ ! -f "$SERVER" ]; then
  SERVER="$ROOT/dist/modeldock.mjs"
fi
if [ ! -f "$SERVER" ]; then
  status "ERROR: gateway entry not found under $ROOT/src or $ROOT/dist"
  exit 1
fi

OLD_PID="$(find_listener_pid)"

check_owner() {
  [ -n "$OLD_PID" ] || return 0
  [ "$FORCE" -eq 0 ] || return 0
  state_dir="${MODELDOCK_STATE_DIR:-$HOME/.modeldock}"
  owner_file="$state_dir/owner-$PORT.json"
  [ -f "$owner_file" ] || return 0
  "$NODE_BIN" --input-type=module - "$owner_file" "$OLD_PID" "$ROOT" <<'NODE'
import fs from "node:fs";
import path from "node:path";

const [ownerFile, oldPid, root] = process.argv.slice(2);
try {
  const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  if (owner?.root && Number(owner.pid) === Number(oldPid)) {
    const ownerRoot = path.resolve(owner.root);
    const thisRoot = path.resolve(root);
    if (ownerRoot !== thisRoot) {
      const first = `ERROR: port ${owner.port || ""} is owned by a gateway from '${ownerRoot}' (PID ${oldPid}); this script runs from '${thisRoot}'.`;
      const second = "Re-run with --force to take the port over deliberately.";
      console.log(first);
      console.log(second);
      console.error(first);
      console.error(second);
      process.exit(2);
    }
  }
} catch {
  // Unreadable owner file: match restart.ps1 and behave as before.
}
NODE
}

wait_for_health() {
  old_pid="${1:-}"
  i=0
  while [ "$i" -lt 40 ]; do
    if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
      new_pid="$(find_listener_pid)"
      if [ -z "$old_pid" ] || [ -z "$new_pid" ] || [ "$new_pid" != "$old_pid" ]; then
        status "restart.sh: gateway healthy at http://127.0.0.1:$PORT"
        return 0
      fi
    fi
    sleep 0.25
    i=$((i + 1))
  done
  return 1
}

try_launchd_restart() {
  [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] || return 1
  command -v launchctl >/dev/null 2>&1 || return 1
  label="gui/$(id -u)/com.modeldock.gateway"
  launchctl print "$label" >/dev/null 2>&1 || return 1
  status "restart.sh: restarting launchd service com.modeldock.gateway"
  launchctl kickstart -k "$label" >/dev/null 2>&1
}

check_owner

if try_launchd_restart; then
  if wait_for_health "$OLD_PID"; then
    exit 0
  fi
  status "WARNING: launchd restart did not become healthy; falling back to manual restart"
  OLD_PID="$(find_listener_pid)"
fi

if [ -n "$OLD_PID" ]; then
  status "restart.sh: stopping gateway (PID $OLD_PID, port $PORT)"
  kill "$OLD_PID" 2>/dev/null || true
  i=0
  while [ "$i" -lt 20 ]; do
    current_pid="$(find_listener_pid)"
    alive=""
    if kill -0 "$OLD_PID" 2>/dev/null; then alive=1; fi
    if [ -z "$alive" ] && { [ -z "$current_pid" ] || [ "$current_pid" != "$OLD_PID" ]; }; then
      break
    fi
    sleep 0.25
    i=$((i + 1))
  done
  if kill -0 "$OLD_PID" 2>/dev/null; then
    status "restart.sh: gateway did not stop after SIGTERM; forcing PID $OLD_PID"
    kill -9 "$OLD_PID" 2>/dev/null || true
    sleep 0.5
  fi
else
  status "restart.sh: no gateway on port $PORT; starting fresh"
fi

cd "$ROOT"
LOG="$ROOT/modeldock.log"
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 33554432 ]; then
  mv -f "$LOG" "$LOG.1"
fi

nohup "$NODE_BIN" "$SERVER" >>"$LOG" 2>&1 &
status "restart.sh: started gateway from $ROOT (logs: $LOG)"

if wait_for_health "$OLD_PID"; then
  exit 0
fi

status "ERROR: gateway did not become healthy within 10s"
if [ -f "$LOG" ]; then
  tail -n 10 "$LOG" >&2 || true
fi
exit 1
