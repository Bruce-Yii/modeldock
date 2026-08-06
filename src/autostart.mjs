// Cross-platform "start ModelDock at login" support.
//
// - Windows: a per-user HKCU Run key that launches scripts/start-hidden.ps1 (hidden
//   console, install dir as cwd). No admin rights needed.
// - macOS: a per-user LaunchAgent (~/Library/LaunchAgents/com.modeldock.gateway.plist)
//   that launchd loads at login and keeps running. No sudo needed.
//
// The autostart entry points at the built bundle (dist/modeldock.mjs) when present and
// falls back to src/server.mjs in a git checkout, so the same module serves dev and
// installed layouts.

import { execFile } from "node:child_process";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
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

function serverEntryPath(root) {
  const bundle = path.join(root, "dist", "modeldock.mjs");
  const source = path.join(root, "src", "server.mjs");
  return access(bundle)
    .then(() => bundle)
    .catch(() => source);
}

function exec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim() || error.message));
      else resolve(stdout);
    });
  });
}

function plistXml(entryPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>${entryPath}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>WorkingDirectory</key><string>${path.dirname(entryPath)}</string>
  <key>StandardOutPath</key><string>${path.join(os.tmpdir(), "modeldock.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(os.tmpdir(), "modeldock.log")}</string>
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
      const entryPath = await serverEntryPath(path.resolve(dirname, ".."));
      await mkdir(path.dirname(plistPath), { recursive: true });
      await writeFile(plistPath, plistXml(entryPath), "utf8");
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
