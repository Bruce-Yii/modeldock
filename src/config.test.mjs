import test from "node:test";
import assert from "node:assert/strict";
import { tokenFromCodexToml } from "./config.mjs";

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
