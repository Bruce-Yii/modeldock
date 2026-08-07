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

// In the release bundle esbuild's `define` replaces this expression with the version
// string literal; in a git checkout it is undefined and package.json is used.
const BUILD_VERSION = process.env.MODELDOCK_BUILD_VERSION;

export function localVersion() {
  if (BUILD_VERSION) return BUILD_VERSION;
  try {
    return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version || "0.0.0";
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
  return {
    available: compareVersions(tag, current) > 0,
    latestVersion: tag,
    assetUrl: asset?.browser_download_url || "",
    sumsUrl: sums?.browser_download_url || "",
    notesUrl: release?.html_url || "",
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

function isGitCheckout() {
  return existsSync(path.join(root, ".git"));
}

function gitPull() {
  return new Promise((resolve, reject) => {
    execFile("git", ["pull", "--ff-only"], { cwd: root, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim() || error.message));
      else resolve(stdout);
    });
  });
}

async function fetchAsset(url, maxBytes) {
  const response = await fetch(url, {
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

async function downloadBundle(assetUrl, sumsUrl) {
  // Integrity: releases publish a SHA256SUMS asset (release.yml); refuse to install a
  // bundle we cannot verify against it.
  if (!sumsUrl) throw new Error("Release has no SHA256SUMS asset; refusing unverified update");
  const sums = parseSumsFile((await fetchAsset(sumsUrl, 64 * 1024)).toString("utf8"));
  const expected = sums[ASSET_NAME];
  if (!expected) throw new Error(`SHA256SUMS has no entry for ${ASSET_NAME}`);
  const body = await fetchAsset(assetUrl, MAX_BUNDLE_BYTES);
  if (body.length < 100_000) throw new Error(`Downloaded bundle suspiciously small (${body.length} bytes)`);
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual !== expected) throw new Error(`Bundle checksum mismatch (expected ${expected.slice(0, 12)}..., got ${actual.slice(0, 12)}...)`);
  const target = path.join(root, "dist", ASSET_NAME);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, target);
  return target;
}

// Relaunch after the current process exits: a detached shell waits for the port to
// free up, then runs the hidden-start script. unref() so it survives our exit.
function scheduleRestart() {
  if (process.platform === "win32") {
    const script = path.join(root, "scripts", "start-hidden.ps1");
    // Single quotes in the path (e.g. a user name with an apostrophe) are escaped by
    // doubling, per PowerShell single-quoted string rules.
    const quoted = script.replace(/'/g, "''");
    spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Start-Sleep -Seconds 2; & '${quoted}'`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  } else {
    const script = path.join(root, "scripts", "start-hidden.sh");
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

export function createUpdater({ fetchImpl = fetch } = {}) {
  const state = {
    currentVersion: localVersion(),
    latestVersion: "",
    available: false,
    updating: false,
    checkedAt: 0,
    notesUrl: "",
    error: "",
  };
  let assetUrl = "";
  let sumsUrl = "";

  async function check() {
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${updateRepo()}/releases/latest`, {
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        headers: { accept: "application/vnd.github+json", "user-agent": "modeldock-updater" },
      });
      if (!response.ok) throw new Error(`Release check: HTTP ${response.status}`);
      const parsed = parseLatestRelease(await response.json(), state.currentVersion);
      state.available = parsed.available;
      state.latestVersion = parsed.latestVersion || "";
      state.notesUrl = parsed.notesUrl || "";
      state.error = "";
      assetUrl = parsed.assetUrl || "";
      sumsUrl = parsed.sumsUrl || "";
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
      if (isGitCheckout()) {
        mode = "git";
        await gitPull();
      } else {
        mode = "bundle";
        if (!assetUrl) await check();
        if (!assetUrl) throw new Error("Release has no modeldock.mjs asset");
        await downloadBundle(assetUrl, sumsUrl);
      }
      scheduleRestart();
      return { ok: true, mode, latestVersion: state.latestVersion, restarting: true };
    } catch (error) {
      state.updating = false;
      throw error;
    }
  }

  return { state: () => ({ ...state }), check, apply };
}
