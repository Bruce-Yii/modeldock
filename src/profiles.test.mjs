import test from "node:test";
import assert from "node:assert/strict";
import {
  OPENCODE_GO_PROFILE,
  DEEPSEEK_OFFICIAL_PROFILE,
  profileById,
  profileOptions,
  HARNESS_WEB_SEARCH_TOOL,
  HARNESS_VISION_TOOL,
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
  assert.equal(OPENCODE_GO_PROFILE.compactCompletedToolHistory, true);
  assert.equal(OPENCODE_GO_PROFILE.canonicalizeCallIds, true);
  assert.equal(OPENCODE_GO_PROFILE.stripSyntheticReasoningPlaceholder, true);
  assert.equal(OPENCODE_GO_PROFILE.harnessToolNames.has("harness_web_search"), true);
  assert.equal(OPENCODE_GO_PROFILE.harnessToolNames.has("harness_vision_inspect"), true);
  assert.ok(OPENCODE_GO_PROFILE.harnessTools.webSearch, "web search harness tool defined");
  assert.ok(OPENCODE_GO_PROFILE.harnessTools.vision, "vision harness tool defined");
});

test("deepseek-official profile routes the main model on DeepSeek with harness on the Go camp", () => {
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.blockedToolTypes.has("tool_search"), true);
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.blockedToolTypes.has("web_search"), true);
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.compactCompletedToolHistory, true);
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.stripSyntheticReasoningPlaceholder, true);
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.harnessToolNames.has("harness_web_search"), true);
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.harnessToolNames.has("harness_vision_inspect"), true);
  assert.ok(DEEPSEEK_OFFICIAL_PROFILE.harnessTools.webSearch, "web search harness tool defined");
  assert.ok(DEEPSEEK_OFFICIAL_PROFILE.harnessTools.vision, "vision harness tool defined");
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.coreTools.has("apply_patch"), true, "apply_patch is the only Codex local tool DeepSeek accepts");
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.coreTools.has("shell_command"), false, "shell_command is rejected by the DeepSeek Responses API");
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.baseUrl, "https://api.deepseek.com");
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.tokenEnvName, "DEEPSEEK_API_KEY");
  assert.deepEqual(DEEPSEEK_OFFICIAL_PROFILE.availableModels.map((model) => model.id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.availableModels.every((model) => model.endpoint === "responses"), true);
});

test("model catalog is generated per profile with distinct comp hashes", () => {
  const instructions = "base";
  const goCatalog = OPENCODE_GO_PROFILE.modelCatalog({ mainModel: "deepseek-v4-flash", visionModel: "gpt-5.6-luna", baseInstructions: instructions });
  const officialCatalog = DEEPSEEK_OFFICIAL_PROFILE.modelCatalog({ mainModel: "deepseek-v4-flash", baseInstructions: instructions });
  assert.equal(goCatalog.models.length, 1);
  assert.equal(goCatalog.models[0].slug, "deepseek-v4-flash");
  assert.equal(goCatalog.models[0].comp_hash, "modeldock-opencode-go-v1");
  assert.equal(goCatalog.models[0].supports_search_tool, true);
  assert.equal(goCatalog.models[0].default_reasoning_level, "high");
  assert.deepEqual(goCatalog.models[0].supported_reasoning_levels.map((level) => level.effort), ["low", "high", "max"]);
  assert.equal(officialCatalog.models[0].comp_hash, "modeldock-deepseek-official-v1");
  assert.equal(officialCatalog.models[0].supports_search_tool, false);
  assert.equal(officialCatalog.models[0].default_reasoning_level, "medium", "DeepSeek official defaults to medium thinking");
  assert.deepEqual(
    officialCatalog.models[0].supported_reasoning_levels.map((level) => level.effort),
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
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
    assert.equal(model.context_window, CONTEXT_WINDOW);
    assert.equal(model.max_context_window, CONTEXT_WINDOW);
    assert.equal(model.auto_compact_token_limit, expected, `${profile.id} must auto-compact at 80% of context`);
  }
});

test("harness tool schemas stay immutable between profiles", () => {
  const before = OPENCODE_GO_PROFILE.harnessTools.webSearch.name;
  const cloned = structuredClone(HARNESS_WEB_SEARCH_TOOL);
  cloned.name = "mutated";
  assert.equal(OPENCODE_GO_PROFILE.harnessTools.webSearch.name, before, "profile schema unaffected by clone mutation");
  assert.equal(HARNESS_WEB_SEARCH_TOOL.name, "harness_web_search");
  assert.equal(HARNESS_VISION_TOOL.name, "harness_vision_inspect");
});
