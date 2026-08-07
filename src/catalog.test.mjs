import assert from "node:assert/strict";
import test from "node:test";
import { baseInstructionsFor, catalogFor, enabledProvidersFor } from "./catalog.mjs";
import { OPENCODE_GO_PROFILE } from "./profiles.mjs";
import { isNativeModel } from "./gateway.mjs";

function configStub() {
  return {
    profile: OPENCODE_GO_PROFILE,
    profileId: "opencode-go",
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    goToken: "go-token",
    tokens: { "opencode-go": "go-token", "deepseek-official": "" },
  };
}

test("catalogFor declares image input for the text-only main model (image escalation)", () => {
  const catalog = catalogFor(configStub());
  const main = catalog.models.find((entry) => entry.slug === "deepseek-v4-flash");
  assert.ok(main, "main model entry exists");
  assert.deepEqual(main.input_modalities, ["text", "image"], "endpoint handles images by escalating to the vision model");
  assert.equal(main.supports_search_tool, false, "search is the MCP tool, not a hosted schema");
  assert.equal(main.supports_parallel_tool_calls, false);
  assert.equal(main.reasoning_summary_format, "experimental");
});

test("catalogFor keeps the main model first with the profile comp hash", () => {
  const catalog = catalogFor(configStub());
  assert.equal(catalog.models[0].slug, "deepseek-v4-flash");
  assert.equal(catalog.models[0].comp_hash, "modeldock-opencode-go-v1");
  assert.equal(catalog.models[0].context_window, 400_000, "deepseek-v4-flash declares 400k so Codex compacts at 320k");
  assert.equal(catalog.models[0].auto_compact_token_limit, 320_000);
});

test("catalogFor covers every available model", () => {
  const catalog = catalogFor(configStub());
  const available = OPENCODE_GO_PROFILE.availableModels.filter((model) => model.status !== "unavailable").length;
  assert.ok(catalog.models.length >= available, `catalog lists at least the ${available} available models`);
  for (const entry of catalog.models) {
    assert.deepEqual(entry.input_modalities, ["text", "image"], `${entry.slug} declares image input at the endpoint`);
  }
});

test("baseInstructionsFor includes the vision and restart guidance", () => {
  const instructions = baseInstructionsFor(configStub());
  assert.match(instructions, /TEXT-ONLY model and CANNOT see images/);
  assert.match(instructions, /call vision_inspect/);
  assert.match(instructions, /restart\.ps1/);
});

test("baseInstructionsFor includes the design-first workflow", () => {
  const instructions = baseInstructionsFor(configStub());
  assert.match(instructions, /Design-first workflow \(MANDATORY for frontend\/UI work\)/);
  assert.match(instructions, /run image_gen first/);
  assert.match(instructions, /read the output with vision_inspect/);
  assert.match(instructions, /implement by translating structure, palette, and hierarchy/);
});

test("enabledProvidersFor includes the active profile and any provider with a token", () => {
  const ids = enabledProvidersFor(configStub());
  assert.deepEqual([...ids].sort(), ["opencode-go"]);

  const withDeepSeek = {
    ...configStub(),
    tokens: { "opencode-go": "go-token", "deepseek-official": "ds-token" },
  };
  assert.deepEqual([...enabledProvidersFor(withDeepSeek)].sort(), ["deepseek-official", "opencode-go"]);
});

test("catalogFor publishes only models owned by enabled providers", () => {
  const catalog = catalogFor(configStub());
  const slugs = catalog.models.map((entry) => entry.slug);
  assert.ok(slugs.includes("deepseek-v4-flash"));
  assert.ok(!slugs.some((slug) => slug.endsWith("@deepseek-official")), "DeepSeek official models are hidden without a token");

  const withDeepSeek = {
    ...configStub(),
    tokens: { "opencode-go": "go-token", "deepseek-official": "ds-token" },
  };
  const withDeepSeekCatalog = catalogFor(withDeepSeek);
  assert.ok(withDeepSeekCatalog.models.some((entry) => entry.slug === "deepseek-v4-flash@deepseek-official"));
});

test("the bare gpt-5.6-luna slot stays reserved for the native GPT pipeline", () => {
  const catalog = catalogFor(configStub());
  const slugs = catalog.models.map((entry) => entry.slug);
  assert.ok(slugs.includes("gpt-5.6-luna@opencode-go"), "our Luna is published under the owner suffix");
  assert.ok(!slugs.includes("gpt-5.6-luna"), "the bare id stays free for the native backend's GPT-5.6-Luna");
  const known = new Set(slugs);
  assert.equal(isNativeModel("gpt-5.6-luna", known), true, "a native request for the bare id passes through to ChatGPT");
  assert.equal(isNativeModel("gpt-5.6-luna@opencode-go", known), false, "our qualified slug stays on the routed path");
});

test("catalogFor never publishes chat-dialect models even if marked available", () => {
  const profile = {
    ...OPENCODE_GO_PROFILE,
    availableModels: [
      ...OPENCODE_GO_PROFILE.availableModels.filter((m) => m.id !== "qwen3.8-max"),
      { id: "qwen3.8-max", label: "Qwen 3.8 Max", endpoint: "chat", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 160, speedTier: "medium", status: "available" },
    ],
  };
  const catalog = catalogFor({ ...configStub(), profile });
  assert.ok(!catalog.models.some((entry) => entry.slug === "qwen3.8-max"), "chat vision model must not be published");
});
