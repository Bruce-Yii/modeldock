#!/bin/sh
# ModelDock installer (macOS / Linux).
#
# User-side bootstrap: runs BEFORE Node is guaranteed to exist, so it must stay a
# plain shell script (an .mjs installer would need Node already - chicken and egg).
#
#   curl -fsSL https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.sh | sh
#
# What it does:
#   1. Use Node >= 22 (a bundled copy under ~/.modeldock/node wins, then PATH). If
#      none is found, download the latest Node 22 LTS tarball from nodejs.org, verify
#      its SHA256 and unpack it under ~/.modeldock/node so the install is self-contained.
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
#   MODELDOCK_SKILL_BASE_URL  base URL for the content-to-video skill files
#                             (default: raw.githubusercontent.com/<repo>/main/skills/content-to-video)
#   MODELDOCK_CODEX_HOME    Codex home dir (default: ~/.codex; skills land in
#                             <codexHome>/skills/content-to-video)
#   MODELDOCK_PORT          dashboard port                (default: 4097)
#   MODELDOCK_NODE_PATH     absolute path to a node executable to prefer
#   MODELDOCK_FORCE_NODE_DOWNLOAD  set to "1" to always (re)install the bundled node
#   MODELDOCK_NODE_VERSION  pin a Node version, e.g. "22.14.0" (default: latest 22 LTS)
#   MODELDOCK_NODE_BASE_URL mirror of https://nodejs.org/dist (tests/mirrors)
#   MODELDOCK_SKIP_START    set to "1" to lay out files without starting the gateway
#   MODELDOCK_SKIP_OPEN     set to "1" to not open a browser

set -eu

REPO="${MODELDOCK_REPO:-architectds/modeldock}"
PORT="${MODELDOCK_PORT:-4097}"
ROOT="${MODELDOCK_ROOT:-$HOME/.modeldock}"
RELEASE_URL="${MODELDOCK_RELEASE_URL:-https://github.com/$REPO/releases/latest/download/modeldock.mjs}"
SKIP_OPEN="${MODELDOCK_SKIP_OPEN:-0}"
SKIP_START="${MODELDOCK_SKIP_START:-0}"

echo "ModelDock installer"

# 1. Node >= 22. Prefer an explicit path, then a bundled Node (installed here on a
#    previous run, or by the download step below), then a PATH node. When nothing
#    suitable exists, download the latest Node 22 LTS tarball, verify its SHA256 and
#    unpack it under "$ROOT/node" - the launcher and restart script resolve the same
#    bundled-first way, so the installed layout stays self-contained.
NODE_BIN=""
NODE_SYSTEM_VERSION=""
if [ -n "${MODELDOCK_NODE_PATH:-}" ] && [ -x "$MODELDOCK_NODE_PATH" ]; then
  NODE_BIN="$MODELDOCK_NODE_PATH"
fi
if [ -z "$NODE_BIN" ]; then
  for d in "$ROOT"/node/v*; do
    [ -d "$d" ] || continue
    [ -x "$d/bin/node" ] || continue
    NODE_BIN="$d/bin/node"
  done
fi
if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node --version | sed -n 's/^v\([0-9]*\).*/\1/p')"
  if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 22 ]; then
    NODE_SYSTEM_VERSION="$(node --version)"
    NODE_BIN="$(command -v node)"
  fi
fi
if [ "${MODELDOCK_FORCE_NODE_DOWNLOAD:-0}" = "1" ]; then
  NODE_BIN=""
fi
if [ -z "$NODE_BIN" ]; then
  NODE_BASE="${MODELDOCK_NODE_BASE_URL:-https://nodejs.org/dist}"
  NODE_VER="${MODELDOCK_NODE_VERSION:-}"
  if [ -z "$NODE_VER" ]; then
    echo "  resolving latest Node 22 LTS..."
    NODE_VER="$(curl -fsSL --max-time 30 "$NODE_BASE/index.json" 2>/dev/null | tr '{' '\n' | grep '"version":"v22\.' | grep '"lts":"' | sed -n 's/.*"version":"\(v22\.[0-9]*\.[0-9]*\)".*/\1/p' | head -n 1 || true)"
  fi
  case "$NODE_VER" in
    v[0-9]*.[0-9]*.[0-9]*) ;;
    ?*) NODE_VER="v$NODE_VER" ;;
  esac
  case "$NODE_VER" in
    v[0-9]*.[0-9]*.[0-9]*) ;;
    *) echo "ERROR: invalid Node version: ${NODE_VER:-<empty>} (set MODELDOCK_NODE_VERSION to pin one)" >&2; exit 1 ;;
  esac
  case "$(uname -s)" in
    Darwin) NODE_OS="darwin" ;;
    *) NODE_OS="linux" ;;
  esac
  case "$(uname -m)" in
    aarch64|arm64) NODE_ARCH="arm64" ;;
    *) NODE_ARCH="x64" ;;
  esac
  TARBALL="node-$NODE_VER-$NODE_OS-$NODE_ARCH.tar.gz"
  STAGE="$ROOT/node/.tmp-$NODE_VER"
  TARGET="$ROOT/node/$NODE_VER"
  # Preserve the exit status: a plain cleanup trap would make a failing
  # `exit 1` return 0 under dash (the trap's own status becomes the shell's).
  trap 'rc=$?; [ -n "${STAGE:-}" ] && rm -rf "$STAGE"; exit $rc' EXIT
  mkdir -p "$STAGE"
  echo "  downloading $TARBALL..."
  curl -fL --progress-bar "$NODE_BASE/$NODE_VER/$TARBALL" -o "$STAGE/$TARBALL"
  EXPECTED="$(curl -fsSL --max-time 30 "$NODE_BASE/$NODE_VER/SHASUMS256.txt" | grep " $TARBALL$" | awk '{print $1}')"
  if [ -z "$EXPECTED" ]; then
    echo "ERROR: SHA256 for $TARBALL not found in SHASUMS256.txt" >&2
    exit 1
  fi
  if command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$STAGE/$TARBALL" | awk '{print $1}')"
  else
    ACTUAL="$(sha256sum "$STAGE/$TARBALL" | awk '{print $1}')"
  fi
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "ERROR: SHA256 mismatch for $TARBALL" >&2
    exit 1
  fi
  echo "  extracting..."
  tar -xzf "$STAGE/$TARBALL" -C "$STAGE"
  rm -rf "$TARGET"
  mv "$STAGE/node-$NODE_VER-$NODE_OS-$NODE_ARCH" "$TARGET"
  rm -rf "$STAGE"
  NODE_BIN="$TARGET/bin/node"
  if [ ! -x "$NODE_BIN" ]; then
    echo "ERROR: extracted archive is missing bin/node" >&2
    exit 1
  fi
  echo "  bundled node $NODE_VER installed at $TARGET"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo ""
  echo "Node.js 22 or newer is required but could not be installed automatically."
  echo "Install the LTS version from https://nodejs.org (or: brew install node),"
  echo "reopen your terminal, then run this installer again."
  exit 1
fi
if [ -n "$NODE_SYSTEM_VERSION" ]; then
  echo "  node $NODE_SYSTEM_VERSION - OK"
else
  echo "  node $NODE_BIN - OK"
fi

# 2. Install layout
mkdir -p "$ROOT/dist" "$ROOT/scripts"

BUNDLE="$ROOT/dist/modeldock.mjs"
echo "  downloading latest release bundle..."
curl -fL --progress-bar "$RELEASE_URL" -o "$BUNDLE"
echo "  saved $BUNDLE"
BRIDGE_URL="${MODELDOCK_BRIDGE_URL:-https://github.com/$REPO/releases/latest/download/mcp-standalone.mjs}"
BRIDGE="$ROOT/dist/mcp-standalone.mjs"
echo "  downloading MCP stdio bridge..."
curl -fL --progress-bar "$BRIDGE_URL" -o "$BRIDGE"
echo "  saved $BRIDGE"

# Background launcher (same content as the repo's scripts/start-hidden.sh). Written by
# the installer so a single-file download still gets autostart + self-update restarts.
LAUNCHER="$ROOT/scripts/start-hidden.sh"
cat > "$LAUNCHER" <<'EOF'
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
PORT="${MODELDOCK_PORT:-4097}"
if [ -f "$ROOT/.env" ]; then
  ENV_PORT="$(sed -n 's/^MODELDOCK_PORT=//p' "$ROOT/.env" | tail -n 1)"
  [ -n "$ENV_PORT" ] && PORT="$ENV_PORT"
fi
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/healthz"; then
  exit 0
fi
NODE_BIN="${MODELDOCK_NODE_PATH:-}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  # Bundled Node installed by install.sh (or a previous run) wins over PATH so the
  # installed layout stays self-contained; pick the highest version if several exist.
  BEST_BIN=""
  BEST_V=""
  for d in "$ROOT"/node/v*; do
    [ -d "$d" ] && [ -x "$d/bin/node" ] || continue
    v="$(basename "$d" | sed 's/^v//')"
    if [ -z "$BEST_V" ] || [ "$(printf '%s\n%s\n' "$v" "$BEST_V" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)" = "$v" ]; then
      BEST_BIN="$d/bin/node"
      BEST_V="$v"
    fi
  done
  if [ -n "$BEST_BIN" ]; then
    NODE_BIN="$BEST_BIN"
  else
    NODE_BIN="$(command -v node)"
  fi
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "ERROR: node not found; install Node 22+ or re-run the ModelDock installer" >&2
  exit 1
fi
cd "$ROOT"
# Log instead of discarding: a background start that dies (bad node, port in use,
# missing file) is otherwise completely silent for the user.
nohup "$NODE_BIN" "$SERVER" >>"$ROOT/modeldock.log" 2>&1 &
EOF
chmod +x "$LAUNCHER"

# Restart script (same content as the repo's scripts/restart.ps1). Written by the
# installer so the model-facing "Restarting the gateway" instruction baked into the
# catalog resolves to a real file in the installed layout.
RESTART="$ROOT/scripts/restart.ps1"
cat > "$RESTART" <<'EOF'
# restart.ps1 - restart the ModelDock gateway service.
#
# The model (Codex/DeepSeek/Luna) can restart the gateway itself by running:
#   powershell -ExecutionPolicy Bypass -File <modeldock>\scripts\restart.ps1
#
# What it does:
#   1. Reads MODELDOCK_PORT from <modeldock>\.env (default 4097).
#   2. Stops the process listening on that port (if any).
#   3. Starts a fresh detached `node src/server.mjs` from the project root.
#   4. Waits for /healthz and reports the result.

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env"

$port = 4097
if (Test-Path $envFile) {
  $line = Select-String -Path $envFile -Pattern '^MODELDOCK_PORT=' | Select-Object -First 1
  if ($line) {
    $parsed = 0
    if ([int]::TryParse(($line.Line -replace '^MODELDOCK_PORT=', ''), [ref]$parsed) -and $parsed -gt 0) {
      $port = $parsed
    }
  }
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $oldPid = $listener.OwningProcess
  # Ownership guard: the gateway records {pid, root} per port in
  # ~/.modeldock/owner-<port>.json. If the recorded owner is a *different*
  # checkout, killing it would swap live traffic onto this checkout's code -
  # exactly the lookalike-instance mixup we have hit before. Refuse unless -Force.
  # Must match ownerFilePath() in src/instance-owner.mjs, including the
  # MODELDOCK_STATE_DIR redirect, or the guard reads a file the gateway never wrote.
  $stateDir = if ($env:MODELDOCK_STATE_DIR) { $env:MODELDOCK_STATE_DIR } else { Join-Path $env:USERPROFILE ".modeldock" }
  $ownerFile = Join-Path $stateDir "owner-$port.json"
  if ((Test-Path $ownerFile) -and (-not $args.Contains("-Force"))) {
    try {
      $owner = Get-Content $ownerFile -Raw | ConvertFrom-Json
      if ($owner.root -and $owner.pid -eq $oldPid) {
        $ownerRoot = [System.IO.Path]::GetFullPath($owner.root)
        $thisRoot = [System.IO.Path]::GetFullPath($root)
        if ($ownerRoot -ne $thisRoot) {
          Write-Output "ERROR: port $port is owned by a gateway from '$ownerRoot' (PID $oldPid); this script runs from '$thisRoot'."
          Write-Output "Re-run with -Force to take the port over deliberately."
          exit 1
        }
      }
    } catch {
      # Unreadable owner file: fall through and behave as before.
    }
  }
  Write-Output "restart.ps1: stopping gateway (PID $oldPid, port $port)"
  Stop-Process -Id $oldPid -Force
  for ($i = 0; $i -lt 20; $i += 1) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }
  }
} else {
  Write-Output "restart.ps1: no gateway on port $port; starting fresh"
}

$logDir = Join-Path $env:TEMP "modeldock"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stdout = Join-Path $logDir "gateway.log"
$stderr = Join-Path $logDir "gateway.err.log"

# Prefer an explicit path, then a bundled Node under <root>\node (the installer
# downloads Node 22 LTS there when none is on PATH), then PATH.
$nodeExe = $null
if ($env:MODELDOCK_NODE_PATH -and (Test-Path -LiteralPath $env:MODELDOCK_NODE_PATH)) { $nodeExe = $env:MODELDOCK_NODE_PATH }
if (-not $nodeExe) {
  $bestDir = @(Get-ChildItem -LiteralPath (Join-Path $root "node") -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match "^v\d+\.\d+\.\d+$" } |
      Sort-Object @{ Expression = {
              if ($_.Name -match "^v(\d+)\.(\d+)\.(\d+)$") { [long]$Matches[1] * 1000000 + [long]$Matches[2] * 1000 + [long]$Matches[3] } else { -1 }
          }; Descending = $true } |
      Select-Object -First 1)
  if ($bestDir -and (Test-Path -LiteralPath (Join-Path $bestDir.FullName "node.exe"))) {
    $nodeExe = Join-Path $bestDir.FullName "node.exe"
  }
}
if (-not $nodeExe) { $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $nodeExe) {
  Write-Output "ERROR: node.exe not found; install Node 22+ or re-run the ModelDock installer"
  exit 1
}

# Prefer src/server.mjs (git checkout: restart the code being edited); fall back
# to the built bundle (installed layout ships dist/modeldock.mjs only). Mirrors
# the server-selection in start-hidden.ps1.
$server = Join-Path $root "src\server.mjs"
if (-not (Test-Path -LiteralPath $server)) { $server = Join-Path $root "dist\modeldock.mjs" }

Start-Process -FilePath $nodeExe -ArgumentList $server -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
Write-Output "restart.ps1: started gateway from $root (logs: $logDir)"

for ($i = 0; $i -lt 40; $i += 1) {
  Start-Sleep -Milliseconds 250
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2
    if ($health.ok) {
      Write-Output "restart.ps1: gateway healthy at http://127.0.0.1:$port"
      exit 0
    }
  } catch {
    # Gateway still booting; keep polling.
  }
}

Write-Output "ERROR: gateway did not become healthy within 10s"
if (Test-Path $stderr) { Get-Content $stderr -Tail 10 -ErrorAction SilentlyContinue }
exit 1
EOF

# POSIX restart script (same content as the repo's scripts/restart.sh). Written by
# the installer so macOS/Linux installs can restart without requiring PowerShell.
RESTART_SH="$ROOT/scripts/restart.sh"
cat > "$RESTART_SH" <<'EOF'
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
EOF
chmod +x "$RESTART_SH"

# Manual recovery menu: restart the gateway or restore the native Codex route.
RECOVER="$ROOT/scripts/recover.sh"
cat > "$RECOVER" <<'EOF'
#!/bin/sh
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
    if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
      if [ "$has_lsof" -eq 1 ]; then
        new_pid="$(lsof -ti "tcp:$PORT" 2>/dev/null | head -n 1 || true)"
        if [ -n "$new_pid" ] && [ "$new_pid" != "$old_pid" ]; then
          echo "ModelDock gateway is healthy at http://127.0.0.1:$PORT (PID $new_pid)"; return
        fi
      else
        echo "ModelDock gateway is healthy at http://127.0.0.1:$PORT"; return
      fi
    fi
    sleep 0.25; i=$((i + 1))
  done
  echo "Gateway did not become healthy. Check $ROOT/modeldock.log" >&2; exit 1
}
restore_native() {
  if curl -fsS --max-time 3 -X POST "http://127.0.0.1:$PORT/api/config/disable" >/dev/null 2>&1; then
    echo "Codex native route restored through the running gateway."; return
  fi
  echo "Gateway is unavailable; restoring from the local backup."
  CODEX_HOME_VALUE="${MODELDOCK_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}"
  STATE="$CODEX_HOME_VALUE/modeldock/config-switch-state.json"
  CONFIG="$CODEX_HOME_VALUE/config.toml"
  [ -f "$STATE" ] || { echo "ModelDock switch state was not found: $STATE" >&2; exit 1; }
  node --input-type=module - "$STATE" "$CONFIG" <<'NODE'
import { copyFile, readFile, rm, writeFile, rename } from "node:fs/promises";
import path from "node:path";
const [statePath, configPath] = process.argv.slice(2);
const state = JSON.parse(await readFile(statePath, "utf8"));
if (!state.enabled) { console.log("Codex is already on the native route."); process.exit(0); }
if (!state.backupPath) throw new Error("ModelDock backup path is missing.");
const backup = path.resolve(state.backupPath);
await readFile(backup);
try {
  await readFile(configPath);
  await copyFile(configPath, `${configPath}.native-recovery-${Date.now()}.bak`);
  if (state.originalExisted) await copyFile(backup, configPath); else await rm(configPath, { force: true });
} catch (error) {
  if (error.code === "ENOENT" && state.originalExisted) await copyFile(backup, configPath);
  else if (error.code !== "ENOENT") throw error;
}
state.enabled = false; state.restartRequired = true; state.lastBackupPath = backup; state.changedAt = new Date().toISOString();
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
echo "ModelDock manual recovery"
echo "1. Restart ModelDock gateway"
echo "2. Restore Codex native route"
echo "3. Repair start-at-login"
echo "Q. Quit"
printf "Choose 1, 2, 3, or Q: "
read -r choice
case "$choice" in 1) restart_gateway ;; 2) restore_native ;; 3) repair_autostart ;; q|Q|"") exit 0 ;; *) echo "Unknown choice: $choice" >&2; exit 1 ;; esac
EOF
chmod +x "$RECOVER"

# 2.5. Install the content-to-video skill into the Codex skills directory.
# The skill is small (18 text files, ~0.1 MB) and ships as source in the repo,
# so the installer mirrors the same files from GitHub raw instead of bundling
# an archive. The skill is additive: a download failure warns and continues,
# it never fails the install.
CODEX_HOME_VALUE="${MODELDOCK_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}"
SKILL_BASE="${MODELDOCK_SKILL_BASE_URL:-https://raw.githubusercontent.com/$REPO/main/skills/content-to-video}"
SKILL_DEST="$CODEX_HOME_VALUE/skills/content-to-video"
mkdir -p "$SKILL_DEST"
SKILL_FILES="
SKILL.md
agents/openai.yaml
references/beat-sync.md
references/classification.md
references/hyperframes.md
references/methodology.md
references/pipeline.md
references/pipelines.md
references/quality.md
references/sound-design.md
references/sprites.md
references/tech-stack.md
scripts/build_film.py
scripts/classify.mjs
scripts/preview-scenes.mjs
scripts/qa-frames.mjs
scripts/render-clip.mjs
scripts/static-server-range.mjs
"
for rel in $SKILL_FILES; do
  mkdir -p "$SKILL_DEST/$(dirname "$rel")"
  if ! curl -fsSL --max-time 20 "$SKILL_BASE/$rel" -o "$SKILL_DEST/$rel"; then
    rm -f "$SKILL_DEST/$rel"
    echo "  WARNING: could not download skill file $rel" >&2
  fi
done
echo "  content-to-video skill installed to $SKILL_DEST"

# 3. Enable login autostart on a first install. The gateway also has this
#    safeguard, but doing it here makes the install result deterministic even
#    when the first background start is delayed or fails. The marker preserves
#    an explicit user choice across later reinstalls. Tests redirect the plist
#    directory and state dir through MODELDOCK_AUTOSTART_PLIST_DIR and
#    MODELDOCK_STATE_DIR so mock installs never touch the real LaunchAgents.
STATE_DIR="${MODELDOCK_STATE_DIR:-$ROOT}"
AUTOSTART_MARK="$STATE_DIR/autostart-initialized"
if [ "$SKIP_START" != "1" ] && [ ! -e "$AUTOSTART_MARK" ] && [ "$(uname -s)" = "Darwin" ]; then
  SERVER="$ROOT/dist/modeldock.mjs"
  PLIST_DIR="${MODELDOCK_AUTOSTART_PLIST_DIR:-$HOME/Library/LaunchAgents}"
  PLIST="$PLIST_DIR/com.modeldock.gateway.plist"
  mkdir -p "$PLIST_DIR"
  cat > "$PLIST" <<EOF
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
EOF
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  if launchctl load -w "$PLIST"; then
    mkdir -p "$STATE_DIR"
    printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$AUTOSTART_MARK"
    echo "  start at login enabled (default)"
  else
    echo "ERROR: could not enable start at login (launchctl load failed)." >&2
    echo "       The gateway still works; run the recovery script and choose" >&2
    echo "       'Repair start-at-login' to fix it later." >&2
  fi
fi

# 4. Start (unless already running) and point at the dashboard.
#    MODELDOCK_SKIP_START=1 skips the launch (used by the install mock test, which
#    feeds the installer a fake node that may not be executable).
if [ "$SKIP_START" = "1" ]; then
  echo "  MODELDOCK_SKIP_START=1 - not starting the gateway."
elif curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/healthz"; then
  echo "  ModelDock is already running on port $PORT - keeping it."
else
  echo "  starting ModelDock in the background..."
  "$LAUNCHER"
  sleep 3
fi

echo ""
echo "Done. Dashboard: http://127.0.0.1:$PORT"
echo "First run: paste your API token into the Settings dialog that opens automatically."
echo "Start at login is enabled by default; you can turn it off in Settings."
if [ "$SKIP_OPEN" != "1" ]; then
  command -v open >/dev/null 2>&1 && open "http://127.0.0.1:$PORT/?settings=1" || true
fi
