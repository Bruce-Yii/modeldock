import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { loadConfig, hasChatGptLogin, tokenFromCodexToml } from "./config.mjs";

test("reads an OpenCode bearer token only from a supported provider section", () => {
  const source = `
[model_providers.other]
experimental_bearer_token = "wrong"

[model_providers.opencode]
experimental_bearer_token = "go-token"
`;
  assert.equal(tokenFromCodexToml(source), "go-token");
});

test("supports TOML literal strings for an OpenCode backup token", () => {
  assert.equal(tokenFromCodexToml("[model_providers.opencode_go]\nexperimental_bearer_token = 'literal-token'\n"), "literal-token");
});

test("does not treat an unrelated provider token as OpenCode Go", () => {
  assert.equal(tokenFromCodexToml('[model_providers.openai]\nexperimental_bearer_token = "secret"\n'), "");
});

test("zenBaseUrl resolves from MODELDOCK_ZEN_BASE_URL with the trailing slash normalized", () => {
  const previous = process.env.MODELDOCK_ZEN_BASE_URL;
  process.env.MODELDOCK_ZEN_BASE_URL = "https://zen.example.test/v1/";
  try {
    const config = loadConfig();
    assert.equal(config.zenBaseUrl, "https://zen.example.test/v1");
  } finally {
    if (previous === undefined) delete process.env.MODELDOCK_ZEN_BASE_URL;
    else process.env.MODELDOCK_ZEN_BASE_URL = previous;
  }
});

test("nativeMerge defaults to the ChatGPT sign-in state when MODELDOCK_NATIVE_MERGE is unset", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "modeldock-config-auth-"));
  const previousHome = process.env.MODELDOCK_CODEX_HOME;
  const previousMerge = process.env.MODELDOCK_NATIVE_MERGE;
  const previousEnvFile = process.env.MODELDOCK_ENV_FILE;
  process.env.MODELDOCK_CODEX_HOME = home;
  process.env.MODELDOCK_ENV_FILE = path.join(home, "isolated.env");
  try {
    assert.equal(loadConfig().nativeMerge, false, "no ChatGPT sign-in means native GPT models stay unpublished");
    writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "sk-test" } }), "utf8");
    assert.equal(loadConfig().nativeMerge, true, "a detected sign-in keeps the subscriber-native merge");
    process.env.MODELDOCK_NATIVE_MERGE = "0";
    assert.equal(loadConfig().nativeMerge, false, "MODELDOCK_NATIVE_MERGE=0 overrides a detected sign-in");
    delete process.env.MODELDOCK_NATIVE_MERGE;
    process.env.MODELDOCK_NATIVE_MERGE = "1";
    rmSync(path.join(home, "auth.json"), { force: true });
    assert.equal(loadConfig().nativeMerge, true, "MODELDOCK_NATIVE_MERGE=1 overrides a missing sign-in");
  } finally {
    if (previousHome === undefined) delete process.env.MODELDOCK_CODEX_HOME;
    else process.env.MODELDOCK_CODEX_HOME = previousHome;
    if (previousMerge === undefined) delete process.env.MODELDOCK_NATIVE_MERGE;
    else process.env.MODELDOCK_NATIVE_MERGE = previousMerge;
    if (previousEnvFile === undefined) delete process.env.MODELDOCK_ENV_FILE;
    else process.env.MODELDOCK_ENV_FILE = previousEnvFile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("hasChatGptLogin requires a real token and ignores malformed files", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "modeldock-config-auth2-"));
  try {
    assert.equal(hasChatGptLogin(home), false, "no auth.json means no sign-in");
    writeFileSync(path.join(home, "auth.json"), "{}", "utf8");
    assert.equal(hasChatGptLogin(home), false, "an empty tokens object is not a sign-in");
    writeFileSync(path.join(home, "auth.json"), "not json", "utf8");
    assert.equal(hasChatGptLogin(home), false, "a malformed file is not a sign-in");
    writeFileSync(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-test" }), "utf8");
    assert.equal(hasChatGptLogin(home), true, "the legacy OPENAI_API_KEY shape counts");
    writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { refresh_token: "r-test" } }), "utf8");
    assert.equal(hasChatGptLogin(home), true, "a refresh token counts (Codex refreshes it silently)");
    writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: {} }), "utf8");
    assert.equal(hasChatGptLogin(home), false, "an empty tokens object is not a sign-in");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
