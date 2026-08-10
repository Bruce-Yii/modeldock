// Startup update check + one-click apply.
//
// Source of truth is the newest GitHub Release of MODELDOCK_UPDATE_REPO (default
// architectds/modeldock). The check runs once at startup (fire-and-forget); the
// dashboard shows a small Update button when a newer version exists. Applying:
//   - git checkout (a .git directory next to src/): `git pull --ff-only`
//   - installed bundle: download the release's modeldock.mjs into dist/ atomically
// then relaunch through scripts/start-hidden.* (detached, delayed so the port is
// free) and exit the current process.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_REPO = "architectds/modeldock";
const ASSET_NAME = "modeldock.mjs";
const SUMS_NAME = "SHA256SUMS";
const CHECK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

// Files an installed layout needs beyond the bundle itself. The release carries
// every one of them as an asset (see release.yml), and an update deploys the
// full set for the current platform so an install never mixes a new bundle
// with old launcher/restart/recover scripts. Each entry is {asset, dest,
// platforms}; dest is relative to the package root.
const DEPLOY_TARGETS = {
  "modeldock.mjs": { dest: ["dist", "modeldock.mjs"] },
  "mcp-standalone.mjs": { dest: ["dist", "mcp-standalone.mjs"] },
  "start-hidden.ps1": { dest: ["scripts", "start-hidden.ps1"], platforms: ["win32"] },
  "restart.ps1": { dest: ["scripts", "restart.ps1"], platforms: ["win32"] },
  "recover.ps1": { dest: ["scripts", "recover.ps1"], platforms: ["win32"] },
  "start-hidden.sh": { dest: ["scripts", "start-hidden.sh"], platforms: ["linux", "darwin"] },
  "restart.sh": { dest: ["scripts", "restart.sh"], platforms: ["linux", "darwin"] },
  "recover.sh": { dest: ["scripts", "recover.sh"], platforms: ["linux", "darwin"] },
};

function deployTargetsFor(platform) {
  return Object.entries(DEPLOY_TARGETS)
    .filter(([, target]) => !target.platforms || target.platforms.includes(platform))
    .map(([asset, target]) => ({ asset, ...target }));
}

// In the release bundle esbuild's `define` replaces this expression with the version
// string literal; in a git checkout it is undefined and package.json is used.
const BUILD_VERSION = process.env.MODELDOCK_BUILD_VERSION;

export function localVersion(rootDir = root) {
  if (BUILD_VERSION) return BUILD_VERSION;
  try {
    return JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Numeric dotted compare; non-numeric suffixes (e.g. -beta.1) are ignored per part.
// Returns >0 when a is newer than b.
export function compareVersions(a, b) {
  const parse = (v) => String(v || "").replace(/^v/, "").split(".").map((p) => Number.parseInt(p, 10) || 0);
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

export function parseLatestRelease(release, current) {
  const tag = String(release?.tag_name || "").replace(/^v/, "");
  if (!tag) return { available: false };
  const assets = release?.assets || [];
  const asset = assets.find((a) => a?.name === ASSET_NAME);
  const sums = assets.find((a) => a?.name === SUMS_NAME);
  const assetMap = {};
  for (const item of assets) assetMap[item?.name] = item?.browser_download_url || "";
  return {
    available: compareVersions(tag, current) > 0,
    latestVersion: tag,
    assetUrl: asset?.browser_download_url || "",
    sumsUrl: sums?.browser_download_url || "",
    notesUrl: release?.html_url || "",
    assets: assetMap,
  };
}

// Parse a sha256sum-style file ("<hex>  <filename>" per line) into {filename: hex}.
export function parseSumsFile(text) {
  const sums = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match) sums[match[2].trim()] = match[1].toLowerCase();
  }
  return sums;
}

function updateRepo() {
  return process.env.MODELDOCK_UPDATE_REPO || DEFAULT_REPO;
}

// Optional token for the GitHub API check. Anonymous requests share the caller's
// public IP rate budget (60/hour), which shared/NAT egress can exhaust; a token
// (MODELDOCK_GITHUB_TOKEN or GITHUB_TOKEN) raises that and keeps the Update
// button reliable. Without a token the check still runs anonymously.
function updateToken() {
  return process.env.MODELDOCK_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";
}

function isGitCheckout(rootDir) {
  return existsSync(path.join(rootDir, ".git"));
}

function gitPull(rootDir) {
  return new Promise((resolve, reject) => {
    // Explicit remote/branch so the update never depends on the checkout's
    // configured upstream (a detached or custom branch would otherwise fail
    // with "no tracking information").
    execFile("git", ["pull", "--ff-only", "origin", "main"], { cwd: rootDir, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim() || error.message));
      else resolve(stdout);
    });
  });
}

async function fetchAsset(url, maxBytes, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { "user-agent": "modeldock-updater" },
  });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error(`Asset too large (${declared} bytes, limit ${maxBytes})`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maxBytes) throw new Error(`Asset too large (${body.length} bytes, limit ${maxBytes})`);
  return body;
}

async function fetchVerified(assetUrl, expected, { minBytes = 0, fetchImpl = fetch } = {}) {
  const body = await fetchAsset(assetUrl, MAX_BUNDLE_BYTES, fetchImpl);
  if (body.length < minBytes) throw new Error(`Downloaded asset suspiciously small (${body.length} bytes)`);
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${assetUrl} (expected ${expected.slice(0, 12)}..., got ${actual.slice(0, 12)}...)`);
  }
  return body;
}

async function fetchSums(sumsUrl, fetchImpl = fetch) {
  if (!sumsUrl) throw new Error("Release has no SHA256SUMS asset; refusing unverified update");
  return parseSumsFile((await fetchAsset(sumsUrl, 64 * 1024, fetchImpl)).toString("utf8"));
}

function stageFile(body, target) {
  const tmp = `${target}.${process.pid}.tmp`;
  // Keep POSIX launchers executable after an update. The installer chmods these
  // files, but replacing a file with a newly-created temp file would otherwise
  // silently drop that mode bit.
  const mode = target.endsWith(".sh") ? 0o755 : 0o644;
  writeFileSync(tmp, body, { mode });
  renameSync(tmp, target);
}

// Relaunch after the current process exits: a detached shell waits for the port to
// free up, then runs the hidden-start script. unref() so it survives our exit.
function scheduleRestart(rootDir) {
  if (process.platform === "win32") {
    const script = path.join(rootDir, "scripts", "start-hidden.ps1");
    // Single quotes in the path (e.g. a user name with an apostrophe) are escaped by
    // doubling, per PowerShell single-quoted string rules.
    const quoted = script.replace(/'/g, "''");
    spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Start-Sleep -Seconds 2; & '${quoted}'`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  } else {
    const script = path.join(rootDir, "scripts", "start-hidden.sh");
    const quoted = script.replace(/(["$`\\])/g, "\\$1");
    // "sh script" needs no executable bit; PATH gains this node's directory so the
    // launcher's bare "node" resolves even under launchd's minimal environment.
    spawn("sh", ["-c", `sleep 2; sh "${quoted}"`], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ""}` },
    }).unref();
  }
  setTimeout(() => process.exit(0), 700).unref();
}

export function createUpdater({
  fetchImpl = fetch,
  restartImpl,
  autoCheckMs = 0,
  rootDir = root,
  platform = process.platform,
} = {}) {
  const restart = restartImpl || (() => scheduleRestart(rootDir));
  const state = {
    currentVersion: localVersion(rootDir),
    latestVersion: "",
    available: false,
    updating: false,
    checkedAt: 0,
    notesUrl: "",
    error: "",
  };
  let assetUrl = "";
  let sumsUrl = "";
  let releaseAssets = {};

  async function check() {
    try {
      const headers = {
        accept: "application/vnd.github+json",
        "user-agent": "modeldock-updater",
      };
      const token = updateToken();
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await fetchImpl(`https://api.github.com/repos/${updateRepo()}/releases/latest`, {
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        headers,
      });
      if (!response.ok) throw new Error(`Release check: HTTP ${response.status}`);
      const parsed = parseLatestRelease(await response.json(), state.currentVersion);
      state.available = parsed.available;
      state.latestVersion = parsed.latestVersion || "";
      state.notesUrl = parsed.notesUrl || "";
      state.error = "";
      assetUrl = parsed.assetUrl || "";
      sumsUrl = parsed.sumsUrl || "";
      releaseAssets = parsed.assets || {};
    } catch (error) {
      state.error = error.message;
    }
    state.checkedAt = Date.now();
    return state;
  }

  async function apply() {
    if (state.updating) throw new Error("Update already in progress");
    if (!state.available) throw new Error("No update available");
    state.updating = true;
    try {
      let mode;
      if (isGitCheckout(rootDir)) {
        mode = "git";
        await gitPull(rootDir);
      } else {
        mode = "bundle";
        // Always re-check at click time: the button may have been rendered from a
        // startup check while newer releases were published in the meantime, and
        // apply() must deploy the newest release, not a cached one.
        await check();
        if (!state.available) throw new Error("No update available");
        if (!assetUrl) throw new Error("Release has no modeldock.mjs asset");
        const sums = await fetchSums(sumsUrl, fetchImpl);
        // Download and verify the whole set first; only then touch the installed
        // files, so a failed download never leaves a half-updated layout.
        const staged = [];
        for (const target of deployTargetsFor(platform)) {
          const url = releaseAssets[target.asset];
          if (!url) throw new Error(`Release is missing ${target.asset}`);
          const expected = sums[target.asset];
          if (!expected) throw new Error(`SHA256SUMS has no entry for ${target.asset}`);
          const body = await fetchVerified(url, expected, {
            minBytes: target.asset === ASSET_NAME ? 100_000 : 0,
            fetchImpl,
          });
          staged.push({ body, dest: path.join(rootDir, ...target.dest) });
        }
        for (const item of staged) stageFile(item.body, item.dest);
      }
      restart();
      return { ok: true, mode, latestVersion: state.latestVersion, restarting: true };
    } catch (error) {
      state.updating = false;
      throw error;
    }
  }

  const api = { state: () => ({ ...state }), check, apply };
  if (autoCheckMs > 0) {
    // Keep the Update button current without a restart. unref() so the timer
    // never keeps the process alive on its own.
    const timer = setInterval(() => {
      check().catch(() => {});
    }, autoCheckMs);
    timer.unref?.();
  }
  return api;
}
