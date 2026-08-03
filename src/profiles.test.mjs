import test from "node:test";
import assert from "node:assert/strict";
import {
  OPENCODE_GO_PROFILE,
  DEEPSEEK_OFFICIAL_PROFILE,
  profileById,
  profileOptions,
  HARNESS_WEB_SEARCH_TOOL,
  HARNESS_VISION_TOOL,
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

test("deepseek-official profile is a passthrough provider without Go hardening", () => {
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.blockedToolTypes.size, 0);
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.compactCompletedToolHistory, false);
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.stripSyntheticReasoningPlaceholder, false);
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.harnessToolNames.size, 0);
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.harnessTools.webSearch, null);
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.harnessTools.vision, null);
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.baseUrl, "https://api.deepseek.com/responses");
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.tokenEnvName, "DEEPSEEK_API_KEY");
});

test("model catalog is generated per profile with distinct comp hashes", () => {
  const instructions = "base";
  const goCatalog = OPENCODE_GO_PROFILE.modelCatalog({ mainModel: "deepseek-v4-flash", visionModel: "gpt-5.6-luna", baseInstructions: instructions });
  const officialCatalog = DEEPSEEK_OFFICIAL_PROFILE.modelCatalog({ mainModel: "deepseek-v4-flash", baseInstructions: instructions });
  assert.equal(goCatalog.models.length, 1);
  assert.equal(goCatalog.models[0].slug, "deepseek-v4-flash");
  assert.equal(goCatalog.models[0].comp_hash, "modeldock-opencode-go-v1");
  assert.equal(goCatalog.models[0].supports_search_tool, true);
  assert.equal(officialCatalog.models[0].comp_hash, "modeldock-deepseek-official-v1");
  assert.equal(officialCatalog.models[0].supports_search_tool, false);
  assert.notEqual(goCatalog.models[0].comp_hash, officialCatalog.models[0].comp_hash);
});

test("harness tool schemas stay immutable between profiles", () => {
  const before = OPENCODE_GO_PROFILE.harnessTools.webSearch.name;
  const cloned = structuredClone(HARNESS_WEB_SEARCH_TOOL);
  cloned.name = "mutated";
  assert.equal(OPENCODE_GO_PROFILE.harnessTools.webSearch.name, before, "profile schema unaffected by clone mutation");
  assert.equal(HARNESS_WEB_SEARCH_TOOL.name, "harness_web_search");
  assert.equal(HARNESS_VISION_TOOL.name, "harness_vision_inspect");
});
