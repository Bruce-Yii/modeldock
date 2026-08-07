import assert from "node:assert/strict";
import test from "node:test";
import { baseInstructionsFor, catalogFor } from "./catalog.mjs";
import { OPENCODE_GO_PROFILE } from "./profiles.mjs";

function configStub() {
  return {
    profile: OPENCODE_GO_PROFILE,
    profileId: "opencode-go",
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
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
  assert.equal(catalog.models[0].context_window, 300_000, "deepseek-v4-flash declares 300k so Codex compacts at 240k");
  assert.equal(catalog.models[0].auto_compact_token_limit, 240_000);
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
  assert.match(instructions, /Design-first workflow \(MANDATORY before any frontend\/UI work\)/);
  assert.match(instructions, /call image_gen first/);
  assert.match(instructions, /call vision_inspect with that path/);
  assert.match(instructions, /translate the vision_inspect observation into HTML\/CSS/);
});
