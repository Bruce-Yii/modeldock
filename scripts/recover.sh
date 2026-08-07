#!/bin/sh
# ModelDock manual recovery menu.
# Choose gateway restart or restore the last native Codex configuration.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
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
  if command -v lsof >/dev/null 2>&1; then
    pid="$(lsof -ti "tcp:$PORT" 2>/dev/null | head -n 1 || true)"
    if [ -n "$pid" ]; then
      command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      case "$command" in
        *"$ROOT"*) kill "$pid";;
        *) echo "Refusing to stop an unrelated process on port $PORT." >&2; exit 1;;
      esac
      i=0
      while [ "$i" -lt 20 ] && kill -0 "$pid" 2>/dev/null; do
        sleep 0.25
        i=$((i + 1))
      done
    fi
  fi
  "$ROOT/scripts/start-hidden.sh"
  i=0
  while [ "$i" -lt 40 ]; do
    if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
      echo "ModelDock gateway is healthy at http://127.0.0.1:$PORT"
      return
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

echo ""
echo "ModelDock manual recovery"
echo "1. Restart ModelDock gateway"
echo "2. Restore Codex native route"
echo "Q. Quit"
printf "Choose 1, 2, or Q: "
read -r choice
case "$choice" in
  1) restart_gateway ;;
  2) restore_native ;;
  q|Q|"") exit 0 ;;
  *) echo "Unknown choice: $choice" >&2; exit 1 ;;
esac
