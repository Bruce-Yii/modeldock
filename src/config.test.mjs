import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, tokenFromCodexToml } from "./config.mjs";

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
