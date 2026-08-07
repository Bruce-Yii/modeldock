import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The Codex App's picker list is a replacement, not a merge: with
// `model_catalog_json` set it shows exactly that file, otherwise it shows the
// app's bundled native GPT catalog. So native GPT models must be published in
// our own catalog to stay visible beside ours. This module captures that
// bundled catalog from the Codex desktop CLI (`codex debug models --bundled`),
// caches it next to the model catalog file, and exposes the captured slugs so
// the gateway can route them to the native backend instead of an external
// upstream. Same approach codex-router uses for its merged catalog.

// The desktop app bundles its CLI under a version-hashed directory
// (%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe); the hash changes on every
// app update, so scan for the newest installed version instead of pinning one.
function desktopBundledCodex() {
  if (process.platform !== "win32") return null;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  const binDir = path.join(localAppData, "OpenAI", "Codex", "bin");
  if (!existsSync(binDir)) return null;
  try {
    const matches = readdirSync(binDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(binDir, entry.name, "codex.exe"))
      .filter((candidate) => existsSync(candidate))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return matches[0] || null;
  } catch {
    return null;
  }
}

function resolveCodexBinary() {
  if (process.env.CODEX_BIN && existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
  return desktopBundledCodex();
}

function runCodex(args) {
  const binary = resolveCodexBinary();
  if (!binary) return null;
  return execFileSync(binary, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

export function nativeCatalogPath(config) {
  return (config && config.nativeCatalogFile)
    || path.join(os.homedir(), ".modeldock", "native-catalog.json");
}

// Synchronous read of the cached native catalog; null when absent or corrupt.
// The catalog builders run synchronously, so the cache file is the only source
// they can consult. Refreshes happen at gateway startup and on the model
// refresh timer.
export function readNativeCatalog(config) {
  try {
    const file = nativeCatalogPath(config);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed?.models)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Every slug the native backend owns, including picker-hidden entries: a hidden
// slug must still reach ChatGPT instead of an external upstream.
export function nativeModelSlugs(config) {
  const catalog = readNativeCatalog(config);
  const slugs = new Set();
  for (const model of catalog?.models || []) {
    if (typeof model?.slug === "string" && model.slug) slugs.add(model.slug);
  }
  return slugs;
}

export function codexVersion() {
  try {
    const out = runCodex(["--version"]);
    return String(out || "").trim().split(/\s+/)[0] || "";
  } catch {
    return "";
  }
}

// Ask the Codex desktop CLI for its bundled native catalog and cache it. A
// capture is versioned by the app build; a stale capture is replaced on the
// next refresh. Returns the captured models, or null when the CLI is missing
// or the capture failed (the catalog then simply keeps the last good cache).
export async function refreshNativeCatalog(config) {
  if (!resolveCodexBinary()) return null;
  try {
    const output = runCodex(["debug", "models", "--bundled"]);
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed?.models) || parsed.models.length === 0) return null;
    const file = nativeCatalogPath(config);
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp.${process.pid}`;
    writeFileSync(
      temporary,
      JSON.stringify({ captured_with: codexVersion(), models: parsed.models }, null, 2),
      "utf8",
    );
    renameSync(temporary, file);
    return parsed.models;
  } catch (error) {
    console.log(`[gate] native model catalog refresh failed: ${error.message}`);
    return null;
  }
}
