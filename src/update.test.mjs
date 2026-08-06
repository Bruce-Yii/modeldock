import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, parseLatestRelease, localVersion, createUpdater } from "./update.mjs";

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
    assets: [{ name: "modeldock.mjs", browser_download_url: "https://example.com/modeldock.mjs" }],
  };
  const parsed = parseLatestRelease(release, "0.1.0");
  assert.equal(parsed.available, true);
  assert.equal(parsed.latestVersion, "0.2.0");
  assert.equal(parsed.assetUrl, "https://example.com/modeldock.mjs");
  assert.equal(parsed.notesUrl, "https://github.com/x/y/releases/tag/v0.2.0");
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
