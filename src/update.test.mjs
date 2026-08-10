import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareVersions, parseLatestRelease, parseSumsFile, localVersion, createUpdater } from "./update.mjs";

function responseBody(body) {
  const bytes = Buffer.from(body);
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(bytes.length) },
    arrayBuffer: async () => bytes,
  };
}

function releaseResponse(tag, assets, sums = "") {
  const releaseAssets = { ...assets, ...(sums ? { SHA256SUMS: sums } : {}) };
  return {
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: `v${tag}`,
      html_url: `https://example.com/releases/v${tag}`,
      assets: Object.entries(releaseAssets).map(([name, body]) => ({
        name,
        browser_download_url: `https://assets.example/${tag}/${name}`,
        body,
      })),
    }),
  };
}

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

test("compareVersions orders dotted versions numerically", () => {
  assert.ok(compareVersions("0.2.0", "0.1.0") > 0);
  assert.ok(compareVersions("0.1.0", "0.2.0") < 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("v1.2.3", "1.2.2") > 0);
  assert.ok(compareVersions("1.0.1", "1.0") > 0);
});

test("parseLatestRelease flags newer releases with the bundle asset", () => {
  const release = {
    tag_name: "v0.2.0",
    html_url: "https://github.com/x/y/releases/tag/v0.2.0",
    assets: [
      { name: "modeldock.mjs", browser_download_url: "https://example.com/modeldock.mjs" },
      { name: "SHA256SUMS", browser_download_url: "https://example.com/SHA256SUMS" },
    ],
  };
  const parsed = parseLatestRelease(release, "0.1.0");
  assert.equal(parsed.available, true);
  assert.equal(parsed.latestVersion, "0.2.0");
  assert.equal(parsed.assetUrl, "https://example.com/modeldock.mjs");
  assert.equal(parsed.sumsUrl, "https://example.com/SHA256SUMS");
  assert.equal(parsed.notesUrl, "https://github.com/x/y/releases/tag/v0.2.0");
});

test("parseSumsFile reads sha256sum output", () => {
  const hex = "a".repeat(64);
  const sums = parseSumsFile(`${hex}  modeldock.mjs\n${"b".repeat(64)} *other.bin\nnot a sums line\n`);
  assert.equal(sums["modeldock.mjs"], hex);
  assert.equal(sums["other.bin"], "b".repeat(64));
  assert.equal(Object.keys(sums).length, 2);
  assert.deepEqual(parseSumsFile(""), {});
});

test("parseLatestRelease is not available for same or older versions", () => {
  assert.equal(parseLatestRelease({ tag_name: "v0.1.0", assets: [] }, "0.1.0").available, false);
  assert.equal(parseLatestRelease({ tag_name: "v0.0.9", assets: [] }, "0.1.0").available, false);
  assert.equal(parseLatestRelease({}, "0.1.0").available, false);
  assert.equal(parseLatestRelease(null, "0.1.0").available, false);
});

test("localVersion reads package.json in a git checkout", () => {
  assert.match(localVersion(), /^\d+\.\d+\.\d+/);
});

test("createUpdater.check populates state from the release endpoint", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      tag_name: "v99.0.0",
      html_url: "https://example.com/notes",
      assets: [{ name: "modeldock.mjs", browser_download_url: "https://example.com/dl" }],
    }),
  });
  const updater = createUpdater({ fetchImpl });
  const state = await updater.check();
  assert.equal(state.available, true);
  assert.equal(state.latestVersion, "99.0.0");
  assert.equal(state.error, "");
  assert.ok(state.checkedAt > 0);
});

test("createUpdater.check sends a bearer token when configured", async () => {
  process.env.MODELDOCK_GITHUB_TOKEN = "test-token";
  try {
    let seenHeaders = null;
    const fetchImpl = async (_url, options) => {
      seenHeaders = options.headers;
      return {
        ok: true,
        json: async () => ({ tag_name: "v0.2.0", html_url: "", assets: [] }),
      };
    };
    const updater = createUpdater({ fetchImpl });
    await updater.check();
    assert.equal(seenHeaders.authorization, "Bearer test-token");
    assert.equal(seenHeaders.accept, "application/vnd.github+json");
  } finally {
    delete process.env.MODELDOCK_GITHUB_TOKEN;
  }
});

test("createUpdater.check records errors without throwing", async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  const updater = createUpdater({ fetchImpl });
  const state = await updater.check();
  assert.equal(state.available, false);
  assert.match(state.error, /503/);
});

test("createUpdater.apply refuses when no update is available", async () => {
  const updater = createUpdater({ fetchImpl: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(() => updater.apply(), /No update available/);
});

test("createUpdater.apply deploys the complete Windows install and rechecks at click time", async (t) => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-update-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ version: "0.2.5" }));
  mkdirSync(path.join(rootDir, "dist"));
  mkdirSync(path.join(rootDir, "scripts"));

  const oldFiles = {
    "dist/modeldock.mjs": "old gateway",
    "dist/mcp-standalone.mjs": "old bridge",
    "scripts/start-hidden.ps1": "old launcher",
    "scripts/restart.ps1": "old restart",
    "scripts/recover.ps1": "old recovery",
    "scripts/start-hidden.sh": "posix file must not change on Windows",
  };
  for (const [relative, body] of Object.entries(oldFiles)) {
    writeFileSync(path.join(rootDir, relative), body);
  }

  const assets = {
    "modeldock.mjs": "new gateway".repeat(20_000),
    "mcp-standalone.mjs": "new bridge",
    "start-hidden.ps1": "new launcher",
    "restart.ps1": "new restart",
    "recover.ps1": "new recovery",
    "start-hidden.sh": "new posix launcher",
  };
  const sums = Object.entries(assets)
    .map(([name, body]) => `${sha256(body)}  ${name}`)
    .join("\n");
  let releaseChecks = 0;
  const fetchImpl = async (url) => {
    if (url.includes("api.github.com")) {
      releaseChecks += 1;
      return releaseResponse(releaseChecks === 1 ? "0.2.6" : "0.2.7", assets, sums);
    }
    if (url.endsWith("/SHA256SUMS")) return responseBody(sums);
    const name = url.split("/").pop();
    return responseBody(assets[name]);
  };
  let restartCalls = 0;
  const updater = createUpdater({
    fetchImpl,
    restartImpl: () => { restartCalls += 1; },
    rootDir,
    platform: "win32",
  });

  assert.equal((await updater.check()).latestVersion, "0.2.6");
  const result = await updater.apply();

  assert.equal(result.latestVersion, "0.2.7");
  assert.equal(releaseChecks, 2, "apply should re-check instead of trusting stale startup state");
  assert.equal(restartCalls, 1);
  for (const [relative, body] of Object.entries({
    "dist/modeldock.mjs": assets["modeldock.mjs"],
    "dist/mcp-standalone.mjs": assets["mcp-standalone.mjs"],
    "scripts/start-hidden.ps1": assets["start-hidden.ps1"],
    "scripts/restart.ps1": assets["restart.ps1"],
    "scripts/recover.ps1": assets["recover.ps1"],
  })) {
    assert.equal(readFileSync(path.join(rootDir, relative), "utf8"), body, `${relative} should be updated`);
  }
  assert.equal(
    readFileSync(path.join(rootDir, "scripts/start-hidden.sh"), "utf8"),
    oldFiles["scripts/start-hidden.sh"],
    "a non-current-platform helper must not be overwritten",
  );
});

test("createUpdater.apply leaves an installed layout untouched when a helper is missing", async (t) => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-update-missing-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ version: "0.2.5" }));
  mkdirSync(path.join(rootDir, "dist"));
  mkdirSync(path.join(rootDir, "scripts"));
  const original = {
    "dist/modeldock.mjs": "installed gateway",
    "dist/mcp-standalone.mjs": "installed bridge",
    "scripts/start-hidden.ps1": "installed launcher",
    "scripts/restart.ps1": "installed restart",
    "scripts/recover.ps1": "installed recovery",
  };
  for (const [relative, body] of Object.entries(original)) writeFileSync(path.join(rootDir, relative), body);
  const assets = {
    "modeldock.mjs": "new gateway".repeat(20_000),
    "mcp-standalone.mjs": "new bridge",
    "start-hidden.ps1": "new launcher",
    "restart.ps1": "new restart",
  };
  const sums = Object.entries(assets)
    .map(([name, body]) => `${sha256(body)}  ${name}`)
    .join("\n");
  const fetchImpl = async (url) => {
    if (url.includes("api.github.com")) return releaseResponse("0.2.6", assets, sums);
    if (url.endsWith("/SHA256SUMS")) return responseBody(sums);
    return responseBody(assets[url.split("/").pop()]);
  };
  const updater = createUpdater({
    fetchImpl,
    restartImpl: () => assert.fail("restart must not happen after an incomplete release"),
    rootDir,
    platform: "win32",
  });

  await updater.check();
  await assert.rejects(() => updater.apply(), /Release is missing recover\.ps1/);
  for (const [relative, body] of Object.entries(original)) {
    assert.equal(readFileSync(path.join(rootDir, relative), "utf8"), body, `${relative} must remain unchanged`);
  }
});
