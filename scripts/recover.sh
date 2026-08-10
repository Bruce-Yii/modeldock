#!/bin/sh
# ModelDock manual recovery menu.
# Choose gateway restart, restore the last native Codex configuration, or repair
# the start-at-login entry.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
STATE_DIR="${MODELDOCK_STATE_DIR:-$ROOT}"
PORT="${MODELDOCK_PORT:-4097}"
if [ -f "$ROOT/.env" ]; then
  ENV_PORT="$(sed -n 's/^MODELDOCK_PORT=//p' "$ROOT/.env" | tail -n 1)"
  [ -n "$ENV_PORT" ] && PORT="$ENV_PORT"
fi

restart_gateway() {
  if [ ! -x "$ROOT/scripts/start-hidden.sh" ]; then
    echo "start-hidden.sh is missing from $ROOT" >&2
    exit 1
  fi
  old_pid=""
  has_lsof=0
  if command -v lsof >/dev/null 2>&1; then has_lsof=1; fi
  if [ "$has_lsof" -eq 1 ]; then
    pid="$(lsof -ti "tcp:$PORT" 2>/dev/null | head -n 1 || true)"
    if [ -n "$pid" ]; then
      command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      case "$command" in
        *"$ROOT"*) old_pid="$pid"; kill "$pid";;
        *) echo "Refusing to stop an unrelated process on port $PORT." >&2; exit 1;;
      esac
    fi
  fi
  # Give the old process and its socket time to release before starting the
  # replacement, so the new instance cannot fail with EADDRINUSE and the health
  # probe below cannot be answered by the dying process (false healthy).
  i=0
  while [ "$i" -lt 20 ]; do
    alive=""
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then alive=1; fi
    listening=""
    if [ "$has_lsof" -eq 1 ] && [ -n "$(lsof -ti "tcp:$PORT" 2>/dev/null | head -n 1 || true)" ]; then listening=1; fi
    if [ -z "$alive" ] && [ -z "$listening" ]; then break; fi
    sleep 0.25
    i=$((i + 1))
  done
  if [ "$i" -ge 20 ]; then
    echo "Port $PORT did not release within 5s; aborting restart." >&2
    exit 1
  fi
  "$ROOT/scripts/start-hidden.sh"
  i=0
  while [ "$i" -lt 40 ]; do
    # No -f: a 503 before a token is set still proves the gateway is listening.
    if curl -sS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null; then
      if [ "$has_lsof" -eq 1 ]; then
        new_pid="$(lsof -ti "tcp:$PORT" 2>/dev/null | head -n 1 || true)"
        if [ -n "$new_pid" ] && [ "$new_pid" != "$old_pid" ]; then
          echo "ModelDock gateway is healthy at http://127.0.0.1:$PORT (PID $new_pid)"
          return
        fi
      else
        echo "ModelDock gateway is healthy at http://127.0.0.1:$PORT"
        return
      fi
    fi
    sleep 0.25
    i=$((i + 1))
  done
  echo "Gateway did not become healthy. Check $ROOT/modeldock.log" >&2
  exit 1
}

restore_native() {
  if curl -fsS --max-time 3 -X POST "http://127.0.0.1:$PORT/api/config/disable" >/dev/null 2>&1; then
    echo "Codex native route restored through the running gateway."
    return
  fi
  echo "Gateway is unavailable; restoring from the local backup."
  CODEX_HOME_VALUE="${MODELDOCK_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}"
  STATE="$CODEX_HOME_VALUE/modeldock/config-switch-state.json"
  CONFIG="$CODEX_HOME_VALUE/config.toml"
  if [ ! -f "$STATE" ]; then
    echo "ModelDock switch state was not found: $STATE" >&2
    exit 1
  fi
  node --input-type=module - "$STATE" "$CONFIG" <<'NODE'
import { copyFile, readFile, rm, writeFile, rename } from "node:fs/promises";
import path from "node:path";
const [statePath, configPath] = process.argv.slice(2);
const state = JSON.parse(await readFile(statePath, "utf8"));
if (!state.enabled) {
  console.log("Codex is already on the native route.");
  process.exit(0);
}
if (!state.backupPath) throw new Error("ModelDock backup path is missing.");
const backup = path.resolve(state.backupPath);
try { await readFile(backup); } catch { throw new Error(`ModelDock backup is missing: ${backup}`); }
try {
  await readFile(configPath);
  await copyFile(configPath, `${configPath}.native-recovery-${Date.now()}.bak`);
  if (state.originalExisted) await copyFile(backup, configPath);
  else await rm(configPath, { force: true });
} catch (error) {
  if (error.code === "ENOENT" && state.originalExisted) await copyFile(backup, configPath);
  else if (error.code !== "ENOENT") throw error;
}
state.enabled = false;
state.restartRequired = true;
state.lastBackupPath = backup;
state.changedAt = new Date().toISOString();
const temporary = `${statePath}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
await rename(temporary, statePath);
console.log(`Codex native route restored from ${backup}`);
console.log("Fully quit and restart Codex.");
NODE
}

repair_autostart() {
  if [ "$(uname -s)" != "Darwin" ] && [ "${MODELDOCK_FAKE_DARWIN:-}" != "1" ]; then
    echo "Start-at-login repair is macOS-only; on Windows use the installer's recover menu." >&2
    return
  fi
  if [ ! -e "$STATE_DIR/autostart-initialized" ]; then
    echo "No start-at-login decision was recorded; enable it from the dashboard Settings instead." >&2
    return
  fi
  NODE_BIN=""
  for d in "$ROOT"/node/v*; do
    [ -d "$d" ] && [ -x "$d/bin/node" ] || continue
    NODE_BIN="$d/bin/node"
    break
  done
  [ -n "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"
  if [ -z "$NODE_BIN" ]; then
    echo "node not found; cannot regenerate the launch agent." >&2
    exit 1
  fi
  if [ -f "$ROOT/dist/modeldock.mjs" ]; then
    SERVER="$ROOT/dist/modeldock.mjs"
  else
    SERVER="$ROOT/src/server.mjs"
  fi
  PLIST_DIR="${MODELDOCK_AUTOSTART_PLIST_DIR:-$HOME/Library/LaunchAgents}"
  PLIST="$PLIST_DIR/com.modeldock.gateway.plist"
  mkdir -p "$PLIST_DIR"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.modeldock.gateway</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>MODELDOCK_NODE_PATH</key><string>$NODE_BIN</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$SERVER</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StandardOutPath</key><string>$ROOT/modeldock.log</string>
  <key>StandardErrorPath</key><string>$ROOT/modeldock.log</string>
</dict>
</plist>
PLISTEOF
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  if launchctl load -w "$PLIST"; then
    echo "Start-at-login re-enabled."
  else
    echo "launchctl load failed; check $ROOT/modeldock.log and the plist." >&2
    exit 1
  fi
}

echo ""
echo "ModelDock manual recovery"
echo "1. Restart ModelDock gateway"
echo "2. Restore Codex native route"
echo "3. Repair start-at-login"
echo "Q. Quit"
printf "Choose 1, 2, 3, or Q: "
read -r choice
case "$choice" in
  1) restart_gateway ;;
  2) restore_native ;;
  3) repair_autostart ;;
  q|Q|"") exit 0 ;;
  *) echo "Unknown choice: $choice" >&2; exit 1 ;;
esac
