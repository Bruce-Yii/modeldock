import test from "node:test";
import assert from "node:assert/strict";
import {
  OPENCODE_GO_PROFILE,
  DEEPSEEK_OFFICIAL_PROFILE,
  profileById,
  profileOptions,
  CONTEXT_WINDOW,
  AUTO_COMPACT_PERCENT,
  AUTO_COMPACT_TOKEN_LIMIT,
} from "./profiles.mjs";

test("exposes every registered profile through the registry", () => {
  assert.equal(profileById("opencode-go"), OPENCODE_GO_PROFILE);
  assert.equal(profileById("deepseek-official"), DEEPSEEK_OFFICIAL_PROFILE);
  assert.equal(profileById("unknown-profile"), OPENCODE_GO_PROFILE, "unknown ids fall back to opencode-go");
});

test("lists all profiles as selectable options", () => {
  const options = profileOptions();
  assert.deepEqual(options.map((option) => option.id), ["opencode-go", "deepseek-official"]);
  assert.ok(options.every((option) => typeof option.label === "string" && option.label.length > 0));
});

test("opencode-go profile keeps the Go-specific hardening flags", () => {
  assert.equal(OPENCODE_GO_PROFILE.blockedToolTypes.has("tool_search"), true);
  assert.equal(OPENCODE_GO_PROFILE.blockedToolTypes.has("web_search"), true);
  assert.equal(OPENCODE_GO_PROFILE.compactCompletedToolHistory, undefined, "legacy transform flags are gone");
  assert.equal(OPENCODE_GO_PROFILE.toolSearchAsFunction, undefined, "legacy transform flags are gone");
  assert.equal(OPENCODE_GO_PROFILE.harnessTools, undefined, "harness tool fields are gone");
});

test("deepseek-official profile routes the main model on DeepSeek with harness on the Go camp", () => {
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.blockedToolTypes.size, 0, "official API accepts every Codex local tool as type function");
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.compactCompletedToolHistory, undefined, "legacy transform flags are gone");
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.stripSyntheticReasoningPlaceholder, undefined, "legacy transform flags are gone");
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.harnessTools, undefined, "harness tool fields are gone");
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.baseUrl, "https://api.deepseek.com");
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.tokenEnvName, "DEEPSEEK_API_KEY");
  assert.deepEqual(DEEPSEEK_OFFICIAL_PROFILE.availableModels.map((model) => model.id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.availableModels.every((model) => model.endpoint === "responses"), true);
});

test("model catalog is generated per profile with distinct comp hashes", () => {
  const instructions = "base";
  const goCatalog = OPENCODE_GO_PROFILE.modelCatalog({ mainModel: "deepseek-v4-flash", visionModel: "gpt-5.6-luna", baseInstructions: instructions });
  const officialCatalog = DEEPSEEK_OFFICIAL_PROFILE.modelCatalog({ mainModel: "deepseek-v4-flash", baseInstructions: instructions });
  assert.ok(goCatalog.models.length >= 1, "catalog includes the main model plus every available model");
  assert.equal(goCatalog.models[0].slug, "deepseek-v4-flash");
  assert.equal(goCatalog.models[0].comp_hash, "modeldock-opencode-go-v1");
  assert.equal(goCatalog.models[0].supports_search_tool, false);
  assert.equal(goCatalog.models[0].default_reasoning_level, "high");
  assert.deepEqual(goCatalog.models[0].supported_reasoning_levels.map((level) => level.effort), ["low", "high", "xhigh"]);
  assert.equal(officialCatalog.models[0].comp_hash, "modeldock-deepseek-official-v1");
  assert.equal(officialCatalog.models[0].supports_search_tool, false);
  assert.equal(officialCatalog.models[0].default_reasoning_level, "medium", "DeepSeek official defaults to medium thinking");
  assert.deepEqual(
    officialCatalog.models[0].supported_reasoning_levels.map((level) => level.effort),
    ["none", "minimal", "low", "medium", "high", "xhigh"],
    "DeepSeek official accepts its full reasoning effort ladder",
  );
  assert.notEqual(goCatalog.models[0].comp_hash, officialCatalog.models[0].comp_hash);
});

test("every profile compacts at 80% of the model context window", () => {
  const expected = Math.floor(CONTEXT_WINDOW * AUTO_COMPACT_PERCENT);
  assert.equal(AUTO_COMPACT_TOKEN_LIMIT, expected);
  for (const profile of [OPENCODE_GO_PROFILE, DEEPSEEK_OFFICIAL_PROFILE]) {
    const catalog = profile.modelCatalog({ mainModel: "deepseek-v4-flash", baseInstructions: "base" });
    const model = catalog.models[0];
    assert.equal(model.context_window, 300_000, `${profile.id} declares deepseek-v4-flash at 300k`);
    assert.equal(model.max_context_window, 300_000);
    assert.equal(model.auto_compact_token_limit, Math.floor(300_000 * AUTO_COMPACT_PERCENT), `${profile.id} must auto-compact at 80% of the 300k window`);
  }
});

