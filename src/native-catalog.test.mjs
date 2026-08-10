import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { desktopCodexCandidates, nativeCatalogPath, nativeModelSlugs, readNativeCatalog, refreshNativeCatalog, shouldRecapture } from "./native-catalog.mjs";

function writeCapture(file, models, capturedBin, capturedWith = "0.1.0") {
  writeFileSync(file, JSON.stringify({ captured_with: capturedWith, ...(capturedBin ? { captured_bin: capturedBin } : {}), models }), "utf8");
}

test("readNativeCatalog returns null for a missing cache and a corrupt cache", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  try {
    const missing = path.join(dir, "missing.json");
    assert.equal(readNativeCatalog({ nativeCatalogFile: missing }), null);
    const corrupt = path.join(dir, "corrupt.json");
    writeFileSync(corrupt, "{not json", "utf8");
    assert.equal(readNativeCatalog({ nativeCatalogFile: corrupt }), null);
    const wrongShape = path.join(dir, "wrong.json");
    writeFileSync(wrongShape, JSON.stringify({ models: "nope" }), "utf8");
    assert.equal(readNativeCatalog({ nativeCatalogFile: wrongShape }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nativeCatalogPath honors the config override and otherwise defaults under ~/.modeldock", () => {
  const override = path.join(os.tmpdir(), "modeldock-native-override.json");
  assert.equal(nativeCatalogPath({ nativeCatalogFile: override }), override);
  assert.equal(
    nativeCatalogPath({}),
    path.join(os.homedir(), ".modeldock", "native-catalog.json"),
  );
});

test("nativeModelSlugs includes every captured slug, hidden or not", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  try {
    const file = path.join(dir, "native-catalog.json");
    writeCapture(file, [
      { slug: "gpt-5.6-sol", visibility: "list" },
      { slug: "gpt-5.4-mini", visibility: "hide" },
      { slug: "codex-auto-review", visibility: "hide" },
    ]);
    const slugs = nativeModelSlugs({ nativeCatalogFile: file });
    assert.deepEqual([...slugs].sort(), ["codex-auto-review", "gpt-5.4-mini", "gpt-5.6-sol"]);
    assert.equal(nativeModelSlugs({ nativeCatalogFile: path.join(dir, "missing.json") }).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("desktopCodexCandidates covers the bundled Windows and macOS CLIs", () => {
  const mac = desktopCodexCandidates("darwin");
  assert.ok(
    mac.some((candidate) => candidate.endsWith(path.join("ChatGPT.app", "Contents", "Resources", "codex"))),
    "macOS must include the ChatGPT.app bundled Codex CLI",
  );

  const win = desktopCodexCandidates("win32");
  assert.ok(win.every((candidate) => candidate.endsWith("codex.exe")), "Windows candidates must point at codex.exe");
});

test("shouldRecapture keeps a cache bound to the same version and binary", () => {
  const cached = { captured_with: "0.146.0", captured_bin: "C:\\bin\\abc\\codex.exe", models: [{ slug: "gpt-5.6-sol" }] };
  assert.equal(shouldRecapture(cached, "0.146.0", "C:\\bin\\abc\\codex.exe"), false);
  assert.equal(shouldRecapture(cached, "", "C:\\bin\\abc\\codex.exe"), false, "unavailable version must not force a recapture when the binary matches");
});

test("shouldRecapture recaptures on app build changes", () => {
  const cached = { captured_with: "0.146.0", captured_bin: "C:\\bin\\abc\\codex.exe", models: [{ slug: "gpt-5.6-sol" }] };
  assert.equal(shouldRecapture(cached, "0.146.0", "C:\\bin\\def\\codex.exe"), true, "binary hash dir changed (app update)");
  assert.equal(shouldRecapture(cached, "0.147.0", "C:\\bin\\abc\\codex.exe"), true, "CLI version changed");
});

test("shouldRecapture recaptures a missing or legacy cache", () => {
  assert.equal(shouldRecapture(null, "0.146.0", "C:\\bin\\abc\\codex.exe"), true);
  assert.equal(shouldRecapture({ captured_with: "0.146.0", models: [] }, "0.146.0", "C:\\bin\\abc\\codex.exe"), true, "empty model list is not a usable capture");
  const legacy = { captured_with: "0.146.0", models: [{ slug: "gpt-5.6-sol" }] };
  assert.equal(shouldRecapture(legacy, "0.146.0", "C:\\bin\\abc\\codex.exe"), true, "legacy capture without captured_bin upgrades once");
});

test("refreshNativeCatalog skips recapture when the cache matches the current build", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  try {
    const file = path.join(dir, "native-catalog.json");
    writeCapture(file, [{ slug: "gpt-5.6-sol" }], "C:\\bin\\abc\\codex.exe", "0.146.0");
    let captureCalls = 0;
    const models = await refreshNativeCatalog(
      { nativeCatalogFile: file },
      {
        resolveCodexBinary: async () => "C:\\bin\\abc\\codex.exe",
        codexVersion: async () => "0.146.0",
        runCodex: async () => { captureCalls += 1; throw new Error("should not recapture"); },
      },
    );
    assert.deepEqual(models, [{ slug: "gpt-5.6-sol" }], "returns the cached models");
    assert.equal(captureCalls, 0, "no `codex debug models` call when the build matches");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshNativeCatalog recaptures and binds the new build when the binary changed", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  try {
    const file = path.join(dir, "native-catalog.json");
    writeCapture(file, [{ slug: "gpt-5.6-sol" }]);
    const models = await refreshNativeCatalog(
      { nativeCatalogFile: file },
      {
        resolveCodexBinary: async () => "C:\\bin\\def\\codex.exe",
        codexVersion: async () => "0.147.0",
        runCodex: async () => JSON.stringify({ models: [{ slug: "gpt-5.6-luna" }, { slug: "gpt-5.5" }] }),
      },
    );
    assert.equal(models.length, 2, "fresh capture returned");
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(written.captured_with, "0.147.0");
    assert.equal(written.captured_bin, "C:\\bin\\def\\codex.exe");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshNativeCatalog keeps the stale cache with a warning when a recapture fails", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  try {
    const file = path.join(dir, "native-catalog.json");
    writeCapture(file, [{ slug: "gpt-5.6-sol" }]);
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      const models = await refreshNativeCatalog(
        { nativeCatalogFile: file },
        {
          resolveCodexBinary: async () => "C:\\bin\\def\\codex.exe",
          codexVersion: async () => "0.147.0",
          runCodex: async () => { throw new Error("CLI exploded"); },
        },
      );
      assert.equal(models, null, "failed recapture returns null");
    } finally {
      console.log = originalLog;
    }
    assert.ok(logs.some((line) => line.includes("stale is the best we have")), "stale warning must be explicit");
    const kept = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(kept.captured_with, "0.1.0", "stale cache file is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
