// Cross-platform "start ModelDock at login" support.
//
// - Windows: a per-user HKCU Run key that launches scripts/start-hidden.ps1 (hidden
//   console, install dir as cwd). No admin rights needed.
// - macOS: a per-user LaunchAgent (~/Library/LaunchAgents/com.modeldock.gateway.plist)
//   that launchd loads at login and keeps running. No sudo needed.
//
// The autostart entry points at scripts/start-hidden.*. On macOS launchd starts
// with a sparse PATH and first-run autostart can race the installer-started
// gateway, so keep that logic in the launcher instead of hardcoding a Node binary
// and server entry in the plist.

import { execFile } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "ModelDock";
const PLIST_LABEL = "com.modeldock.gateway";
const PLIST_NAME = `${PLIST_LABEL}.plist`;

function runFile(platform) {
  return platform === "win32"
    ? path.join(dirname, "..", "scripts", "start-hidden.ps1")
    : path.join(dirname, "..", "scripts", "start-hidden.sh");
}

function exec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim() || error.message));
      else resolve(stdout);
    });
  });
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function plistXml(launcherPath, rootDir, {
  nodePath = process.execPath,
  tmpDir = os.tmpdir(),
} = {}) {
  const pathDirs = [
    path.dirname(nodePath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const launchPath = [...new Set(pathDirs.filter(Boolean))].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(launchPath)}</string>
    <key>MODELDOCK_NODE_PATH</key><string>${xmlEscape(nodePath)}</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${xmlEscape(launcherPath)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>WorkingDirectory</key><string>${xmlEscape(rootDir)}</string>
  <key>StandardOutPath</key><string>${xmlEscape(path.join(tmpDir, "modeldock.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(tmpDir, "modeldock.log"))}</string>
</dict>
</plist>`;
}

export function createAutostart({
  platform = process.platform,
  launcherPath = runFile(platform),
  home = os.homedir(),
} = {}) {
  const supported = platform === "win32" || platform === "darwin";
  let cachedEnabled = null;

  async function winGetEnabled() {
    try {
      const out = await exec("reg.exe", ["query", RUN_KEY, "/v", RUN_VALUE]);
      return out.includes(RUN_VALUE);
    } catch {
      return false;
    }
  }

  async function winSetEnabled(enabled) {
    if (enabled) {
      await exec("reg.exe", [
        "add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ",
        "/d", `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${launcherPath}"`,
        "/f",
      ]);
    } else {
      await exec("reg.exe", ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
    }
  }

  async function macGetEnabled() {
    try {
      const out = await exec("launchctl", ["list"]);
      return out.split(/\r?\n/).some((line) => line.trim() === PLIST_LABEL);
    } catch {
      return false;
    }
  }

  async function macSetEnabled(enabled) {
    const plistPath = path.join(home, "Library", "LaunchAgents", PLIST_NAME);
    if (enabled) {
      const rootDir = path.resolve(dirname, "..");
      await mkdir(path.dirname(plistPath), { recursive: true });
      await writeFile(plistPath, plistXml(launcherPath, rootDir), "utf8");
      await exec("launchctl", ["unload", plistPath]).catch(() => {});
      await exec("launchctl", ["load", "-w", plistPath]);
    } else {
      await exec("launchctl", ["unload", "-w", plistPath]).catch(() => {});
      await unlink(plistPath).catch(() => {});
    }
  }

  return {
    supported: () => supported,
    enabled: () => (supported ? Boolean(cachedEnabled) : false),
    async getEnabled() {
      if (!supported) return false;
      cachedEnabled = platform === "win32" ? await winGetEnabled() : await macGetEnabled();
      return cachedEnabled;
    },
    async refresh() {
      return this.getEnabled();
    },
    async setEnabled(enabled) {
      if (!supported) throw new Error(`Autostart is not supported on ${platform}`);
      if (platform === "win32") await winSetEnabled(enabled);
      else await macSetEnabled(enabled);
      cachedEnabled = Boolean(enabled);
      return { enabled: cachedEnabled, supported: true };
    },
  };
}
