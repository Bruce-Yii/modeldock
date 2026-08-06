import { test } from "node:test";
import assert from "node:assert/strict";
import { transformResponsesRequest } from "./transform.mjs";
import { OPENCODE_GO_PROFILE } from "./profiles.mjs";

const NATIVE_PAIR_PROFILE = { ...OPENCODE_GO_PROFILE, compactCompletedToolHistory: false };
const UNFILTERED_GO_PROFILE = { ...OPENCODE_GO_PROFILE };

function fakeStore() {
  const puts = [];
  const seen = new Map();
  return {
    puts,
    put(imageUrl) {
      if (!seen.has(imageUrl)) {
        puts.push(imageUrl);
        seen.set(imageUrl, `img_${seen.size + 1}`);
      }
      return seen.get(imageUrl);
    },
  };
}

const IMAGE_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
const IMAGE_DATA_URL_2 = "data:image/png;base64,AAAABBBBCCCC=";

function baseRequest() {
  return {
    model: "deepseek-v4-flash",
    stream: true,
    tools: [
      { type: "function", name: "shell_command", description: "runs shell", parameters: { type: "object", properties: {} } },
    ],
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
  };
}

test("keeps a plain request intact and adds the resident vision tool on the main-model path", () => {
  const source = baseRequest();
  const { payload, report } = transformResponsesRequest(source, {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: fakeStore(), defaultModel: "deepseek-v4-flash" });
  assert.equal(payload.model, "deepseek-v4-flash");
  assert.equal(payload.stream, true);
  // vision_inspect is resident on DeepSeek turns; the node_repl tools are guaranteed so
  // the Computer Use entry point never disappears from the session.
  assert.deepEqual(payload.tools.map((t) => t.name), ["shell_command", "mcp__node_repl__js", "mcp__node_repl__js_add_node_module_dir", "mcp__node_repl__js_reset", "harness_web_search", "vision_inspect", "speak", "hear"]);
  assert.deepEqual(report.blocked, { tool_search: 0, web_search: 0 });
  assert.equal(report.originalToolCount, 1);
  assert.equal(report.forwardedToolCount, 8);
  assert.deepEqual(report.injectedHarnessTools, ["harness_web_search", "vision_inspect", "speak", "hear"]);
  assert.equal(report.toolChoiceRewritten, false);
  assert.deepEqual(report.imageRefs, []);
});

test("bridges tool_search to a function tool and still blocks web_search", () => {
  const source = baseRequest();
  source.tools = [
    { type: "web_search" },
    { type: "tool_search" },
    { type: "function", name: "f1", description: "d" },
    { type: "web_search" },
  ];
  const { payload, report } = transformResponsesRequest(source, {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
  const names = payload.tools.map((t) => t.name);
  assert.ok(names.includes("tool_search"), "tool_search is bridged to a function tool (client-side MCP elicitation)");
  assert.equal(payload.tools.find((t) => t.name === "tool_search").type, "function", "bridged tool_search is function-typed so the Go camp accepts it");
  assert.ok(names.includes("f1"), "regular function tools pass through");
  assert.ok(names.includes("harness_web_search"), "web search harness still injected for blocked web_search");
  assert.deepEqual(report.blocked, { tool_search: 0, web_search: 2 }, "only web_search is counted as blocked");
  assert.equal(report.originalToolCount, 4);
});

test("rewrites tool_choice required to auto", () => {
  const source = baseRequest();
  source.tool_choice = "required";
  const { payload, report } = transformResponsesRequest(source, {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
  assert.equal(payload.tool_choice, "auto");
  assert.equal(report.toolChoiceRewritten, true);
});

test("leaves tool_choice auto and none untouched", () => {
  for (const value of ["auto", "none"]) {
    const source = baseRequest();
    source.tool_choice = value;
    const { payload, report } = transformResponsesRequest(source, {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
    assert.equal(payload.tool_choice, value);
    assert.equal(report.toolChoiceRewritten, false);
  }
});

test("defaults model when absent", () => {
  const source = baseRequest();
  delete source.model;
  const { payload } = transformResponsesRequest(source, {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: fakeStore(), defaultModel: "fallback-model" });
  assert.equal(payload.model, "fallback-model");
});

test("normalizes string input into a user message", () => {
  const { payload } = transformResponsesRequest({ input: "just a string" }, {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
  assert.equal(payload.input.length, 1);
  assert.equal(payload.input[0].role, "user");
  assert.deepEqual(payload.input[0].content, [{ type: "input_text", text: "just a string" }]);
});

test("replaces input_image with placeholder text and registers media ref", () => {
  const store = fakeStore();
  const source = baseRequest();
  source.input = [
    {
      role: "user",
      content: [
        { type: "input_text", text: "what is in this image?" },
        { type: "input_image", image_url: IMAGE_DATA_URL },
      ],
    },
  ];
  const { payload, report } = transformResponsesRequest(source, {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: store, defaultModel: "d" });
  const parts = payload.input[0].content;
  assert.equal(parts.length, 2);
  assert.equal(parts[0].type, "input_text");
  assert.equal(parts[1].type, "input_text");
  assert.match(parts[1].text, /\[Image attachment img_1/);
  assert.match(parts[1].text, /Use vision_inspect with image_ref "img_1" before making visual claims\./);
  assert.deepEqual(report.imageRefs, ["img_1"]);
  assert.deepEqual(store.puts, [IMAGE_DATA_URL]);
});

test("direct vision route keeps the real current-turn image for Luna and injects no harness tool", () => {
  const store = fakeStore();
  const source = baseRequest();
  source.input = [{ role: "user", content: [
    { type: "input_text", text: "inspect this" },
    { type: "input_image", image_url: IMAGE_DATA_URL },
  ] }];
  const { payload, report } = transformResponsesRequest(source, {
    mediaStore: store,
    defaultModel: "deepseek-v4-flash",
    targetModel: "gpt-5.6-luna",
    directVision: true,
    profile: UNFILTERED_GO_PROFILE,
  });
  assert.equal(payload.model, "gpt-5.6-luna");
  // Luna is vision-capable, so the current-turn image is forwarded as-is (never rewritten to a reference).
  assert.equal(payload.input[0].content[1].type, "input_image", "the vision model receives the real image");
  assert.equal(payload.input[0].content[1].image_url, IMAGE_DATA_URL);
  assert.equal(payload.tools.some((tool) => tool.name === "vision_inspect"), false, "Luna sees the image directly and needs no harness vision tool");
  assert.deepEqual(report.imageRefs, ["img_1"], "still cached for the dashboard / later reference");
  assert.equal(report.directVision, true);
});

test("historical images compress to a reference while the resident vision tool stays available", () => {
  const source = baseRequest();
  source.input = [
    { role: "user", content: [{ type: "input_image", image_url: IMAGE_DATA_URL }] },
    { role: "assistant", content: [{ type: "output_text", text: "The image shows a covered button." }] },
    { role: "user", content: [{ type: "input_text", text: "Now implement the fix." }] },
  ];
  const { payload, report } = transformResponsesRequest(source, {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: fakeStore(), defaultModel: "deepseek-v4-flash" });
  assert.match(payload.input[0].content[0].text, /Earlier image attachment/);
  assert.match(payload.input[0].content[0].text, /following assistant observation/);
  // Main-model turn: the tool is resident so DeepSeek can re-inspect the referenced image on a new visual question.
  assert.equal(payload.tools.some((tool) => tool.name === "vision_inspect"), true);
  assert.deepEqual(report.imageRefs, ["img_1"]);
  assert.deepEqual(report.currentImageRefs, []);
});

test("handles multiple images across multiple messages", () => {
  const store = fakeStore();
  const source = {
    input: [
      { role: "user", content: [{ type: "input_image", image_url: IMAGE_DATA_URL }] },
      { role: "user", content: [{ type: "input_image", image_url: IMAGE_DATA_URL_2 }] },
    ],
  };
  const { payload, report } = transformResponsesRequest(source, {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: store, defaultModel: "d" });
  assert.deepEqual(report.imageRefs, ["img_1", "img_2"]);
  assert.equal(payload.input[1].content[0].type, "input_text");
  assert.deepEqual(store.puts, [IMAGE_DATA_URL, IMAGE_DATA_URL_2]);
});

test("deduplicates image refs in the report when the same url repeats", () => {
  const store = fakeStore();
  const source = {
    input: [
      { role: "user", content: [{ type: "input_image", image_url: IMAGE_DATA_URL }] },
      { role: "user", content: [{ type: "input_image", image_url: IMAGE_DATA_URL }] },
    ],
  };
  const { report } = transformResponsesRequest(source, {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: store, defaultModel: "d" });
  assert.deepEqual(report.imageRefs, ["img_1"]);
});

test("keeps string elements in input arrays untouched", () => {
  const store = fakeStore();
  const source = { input: ["plain string", { role: "user", content: [{ type: "input_text", text: "x" }] }] };
  const { payload } = transformResponsesRequest(source, {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: store, defaultModel: "d" });
  assert.equal(payload.input[0], "plain string");
  assert.equal(payload.input[1].role, "user");
});

test("keeps items without content arrays untouched", () => {
  const source = {
    input: [
      { type: "message", role: "user", content: "text-only-string-content" },
    ],
  };
  const { payload } = transformResponsesRequest(source, {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
  assert.equal(payload.input[0].content, "text-only-string-content");
});

test("rejects null body", () => {
  assert.throws(() => transformResponsesRequest(null, {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" }), /must be a JSON object/);
});

test("rejects array body", () => {
  assert.throws(() => transformResponsesRequest([], {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" }), /must be a JSON object/);
});

test("propagates media store errors for invalid image urls", () => {
  const store = {
    put() {
      throw new Error("Only image data URLs and public HTTPS URLs are supported");
    },
  };
  const source = { input: [{ role: "user", content: [{ type: "input_image", image_url: "http://x/y.png" }] }] };
  assert.throws(() => transformResponsesRequest(source, {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: store, defaultModel: "d" }), /Only image data URLs/);
});

test("handles a missing tools array by creating one for the resident vision tool", () => {
  const source = baseRequest();
  delete source.tools;
  const { payload, report } = transformResponsesRequest(source, {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
  assert.deepEqual((payload.tools || []).map((t) => t.name), ["harness_web_search", "vision_inspect", "speak", "hear"]);
  assert.equal(report.originalToolCount, 0);
  assert.equal(report.forwardedToolCount, 4);
  assert.deepEqual(report.blocked, { tool_search: 0, web_search: 0 });
});

test("does not mutate the source object", () => {
  const store = fakeStore();
  const source = baseRequest();
  source.tools.push({ type: "web_search" });
  source.input[0].content.push({ type: "input_image", image_url: IMAGE_DATA_URL });
  const before = JSON.stringify(source);
  transformResponsesRequest(source, {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: store, defaultModel: "d" });
  assert.equal(JSON.stringify(source), before);
});

test("forces parallel_tool_calls to false and reports the rewrite", () => {
  for (const incoming of [true, false, undefined]) {
    const source = baseRequest();
    if (incoming !== undefined) source.parallel_tool_calls = incoming;
    const { payload, report } = transformResponsesRequest(source, {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
    assert.equal(payload.parallel_tool_calls, false);
    assert.equal(report.parallelToolCallsRewritten, incoming !== false);
  }
});

test("a vision-capable main model keeps tool-output screenshots for direct vision", () => {
  const source = {
    model: "gpt-5.6-luna",
    tools: [{ type: "function", name: "computer_use", parameters: { type: "object", properties: {} } }],
    input: [
      { type: "function_call", call_id: "call_shot", name: "computer_use", arguments: "{}" },
      { type: "function_call_output", call_id: "call_shot", output: [{ type: "input_text", text: "screen captured" }, { type: "input_image", image_url: IMAGE_DATA_URL }] },
    ],
  };
  const { payload, report } = transformResponsesRequest(source, {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: fakeStore(), defaultModel: "deepseek-v4-flash", targetModel: "gpt-5.6-luna" });
  const output = payload.input.find((item) => item.type === "function_call_output")?.output;
  assert.ok(Array.isArray(output), "tool output stays an array for the vision model");
  assert.ok(output.some((part) => part?.type === "input_image" && part.image_url === IMAGE_DATA_URL), "the real screenshot pixels reach Luna");
  assert.equal(report.imageRefs.length, 1, "still registered for the dashboard / later reference");
});

test("a text-only main model still compresses tool-output images to references", () => {
  const source = {
    tools: [{ type: "function", name: "computer_use", parameters: { type: "object", properties: {} } }],
    input: [
      { type: "function_call", call_id: "call_shot", name: "computer_use", arguments: "{}" },
      { type: "function_call_output", call_id: "call_shot", output: [{ type: "input_text", text: "screen captured" }, { type: "input_image", image_url: IMAGE_DATA_URL }] },
    ],
  };
  const { payload, report } = transformResponsesRequest(source, {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: fakeStore(), defaultModel: "deepseek-v4-flash", targetModel: "deepseek-v4-flash" });
  const output = payload.input.find((item) => item.type === "function_call_output")?.output;
  assert.equal(typeof output, "string", "text models get a reference string");
  assert.match(output, /Image attachment img_1/);
  assert.equal(report.imageRefs.length, 1);
});

test("flattens mcp__ namespaces to qualified function tools so calls dispatch", () => {
  const source = {
    model: "gpt-5.6-luna",
    tools: [
      { type: "namespace", name: "mcp__node_repl", tools: [
        { type: "function", name: "js", description: "run js", parameters: { type: "object", properties: {} } },
        { type: "function", name: "js_reset", description: "reset", parameters: { type: "object", properties: {} } },
      ] },
      { type: "namespace", name: "collaboration", tools: [
        { type: "function", name: "spawn_agent", description: "spawn", parameters: { type: "object", properties: {} } },
      ] },
    ],
    input: [
      { type: "function_call", call_id: "call_js", name: "mcp__node_repl__js", arguments: "{}" },
      { type: "function_call_output", call_id: "call_js", output: "hello from js" },
    ],
  };
  const { payload } = transformResponsesRequest(source, {
      profile: UNFILTERED_GO_PROFILE,
      mediaStore: fakeStore(), defaultModel: "deepseek-v4-flash", targetModel: "gpt-5.6-luna" });
  const names = payload.tools.map((tool) => `${tool.type}:${tool.name || tool.type === "namespace" ? tool.name : ""}`);
  assert.ok(payload.tools.some((tool) => tool.type === "function" && tool.name === "mcp__node_repl__js"), "mcp child flattened with qualified name");
  assert.ok(payload.tools.some((tool) => tool.type === "function" && tool.name === "mcp__node_repl__js_reset"), "second mcp child flattened too");
  const collaboration = payload.tools.find((tool) => tool.type === "namespace");
  assert.equal(collaboration?.name, "collaboration", "app namespaces stay nested");
  const pair = payload.input.find((item) => item.type === "function_call_output");
  assert.equal(pair.output, "hello from js", "qualified MCP call pairs replay natively, not as receipts");
});

test("injects ids into replayable native tool result items for Go", () => {
  const source = {
    tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
    input: [
      { type: "function_call", call_id: "call_123", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_123", output: "done" },
    ],
  };
  const { payload } = transformResponsesRequest(source, {
      profile: NATIVE_PAIR_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
  assert.equal(payload.input[1].id, "function_call_output_call_123");
});

test("sanitizes call ids used in injected item ids", () => {
  const source = {
    tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
    input: [
      { type: "function_call", call_id: "weird id/with spaces", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "weird id/with spaces", output: "done" },
    ],
  };
  const { payload } = transformResponsesRequest(source, {
      profile: NATIVE_PAIR_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
  assert.equal(payload.input[1].id, "function_call_output_weird_id_with_spaces");
});

test("canonicalizes function item ids to call ids and preserves output ids", () => {
  const source = {
    tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
    input: [
      { type: "function_call", id: "call_has_id", call_id: "c1", name: "lookup", arguments: "{}" },
      { id: "already_has_id", type: "function_call_output", call_id: "c1", output: "x" },
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ],
  };
  const { payload } = transformResponsesRequest(source, {
      profile: NATIVE_PAIR_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
  assert.equal(payload.input[0].id, "c1");
  assert.equal(payload.input[1].id, "already_has_id");
  assert.equal(payload.input[2].id, undefined);
});

test("repairs mismatched temporary streaming item ids for Go history replay", () => {
  const source = {
    tools: [{ type: "function", name: "shell_command", parameters: { type: "object", properties: {} } }],
    input: [
      { type: "function_call", id: "fc_tmp_wj6q2wobvr", call_id: "call_YaC6ucV1O2LnEtfbcQxSYycc", name: "shell_command", arguments: "{}" },
      { type: "function_call_output", id: "fco_result", call_id: "call_YaC6ucV1O2LnEtfbcQxSYycc", output: "ok" },
    ],
  };
  const { payload, report } = transformResponsesRequest(source, {
      profile: NATIVE_PAIR_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
  assert.equal(payload.input[0].id, "call_YaC6ucV1O2LnEtfbcQxSYycc");
  assert.equal(payload.input[0].id, payload.input[0].call_id);
  assert.equal(payload.input[1].call_id, payload.input[0].call_id);
  assert.equal(report.canonicalizedToolCallIds, 1);
});

test("reports input shape for inspection", () => {
  const source = baseRequest();
  const { report } = transformResponsesRequest(source, {
      profile: NATIVE_PAIR_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
  assert.ok(Array.isArray(report.inputShape));
  assert.equal(report.inputShape[0].role, "user");
  assert.equal(report.inputShape[0].contentKind, "array");
  assert.deepEqual(report.inputShape[0].contentTypes, ["input_text"]);
});

test("drops empty assistant shells and preserves native Responses tool pairs", () => {
  const source = {
    tools: [{ type: "function", name: "shell_command", parameters: { type: "object", properties: {} } }],
    input: [
      { role: "user", content: [{ type: "input_text", text: "run the test" }] },
      { role: "assistant", content: [] },
      { type: "function_call", call_id: "call_1", name: "shell_command", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
      { role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
  };
  const { payload, report } = transformResponsesRequest(source, {
      profile: NATIVE_PAIR_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
  const roles = payload.input.map((item) => item.role || item.type);
  assert.deepEqual(roles, ["user", "function_call", "function_call_output", "user"]);
  assert.equal(payload.input[1].call_id, "call_1");
  assert.equal(payload.input[2].call_id, "call_1");
  assert.equal(report.nativeToolCalls, 1);
  assert.equal(report.nativeToolOutputs, 1);
  assert.equal(report.compactedToolResults, 0);
  assert.equal(report.droppedAssistantMessages, 1);
});

test("preserves interleaved assistant and tool-result chronology across repeated calls", () => {
  const source = {
    tools: [{ type: "custom", name: "shell_command", description: "run a command" }],
    input: [
      { role: "user", content: [{ type: "input_text", text: "check once" }] },
      { role: "assistant", content: [{ type: "output_text", text: "running first check" }] },
      { type: "custom_tool_call", call_id: "call_1", name: "shell_command", input: "{}" },
      { type: "custom_tool_call_output", call_id: "call_1", output: "first result" },
      { role: "assistant", content: [{ type: "output_text", text: "running second check" }] },
      { type: "custom_tool_call", call_id: "call_2", name: "shell_command", input: "{}" },
      { type: "custom_tool_call_output", call_id: "call_2", output: "second result" },
    ],
  };
  const { payload, report } = transformResponsesRequest(source, {
      profile: NATIVE_PAIR_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
  assert.deepEqual(payload.input.map((item) => item.role || item.type), [
    "user", "assistant", "function_call", "function_call_output", "assistant", "function_call", "function_call_output",
  ]);
  assert.equal(payload.input[1].content, "running first check");
  assert.deepEqual(payload.input.slice(2, 4).map((item) => item.type), ["function_call", "function_call_output"]);
  assert.equal(payload.input[2].call_id, "call_1");
  assert.equal(payload.input[2].arguments, "{}");
  assert.equal(payload.input[3].output, "first result");
  assert.equal(payload.input[4].content, "running second check");
  assert.equal(payload.input[5].call_id, "call_2");
  assert.equal(payload.input[6].output, "second result");
  assert.equal(report.nativeToolCalls, 2);
  assert.equal(report.nativeToolOutputs, 2);
  assert.equal(report.compactedToolResults, 0);
  assert.equal(report.compactedToolOutputBytes, 0);
});

test("repairs a custom call whose streamed assistant preamble was recorded before its output", () => {
  const source = {
    tools: [{ type: "custom", name: "apply_patch", description: "apply a patch" }],
    input: [
      { role: "user", content: [{ type: "input_text", text: "rewrite the README" }] },
      { id: "ctc_1", type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: "patch text" },
      { role: "assistant", content: [{ type: "output_text", text: "I will simplify the README." }] },
      { type: "custom_tool_call_output", call_id: "call_patch", output: "Success" },
    ],
  };
  const { payload, report } = transformResponsesRequest(source, {
      profile: NATIVE_PAIR_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
  assert.deepEqual(payload.input.map((item) => item.role || item.type), [
    "user", "assistant", "function_call", "function_call_output",
  ]);
  assert.equal(payload.input[1].content, "I will simplify the README.");
  assert.equal(payload.input[2].call_id, "call_patch");
  assert.equal(payload.input[3].call_id, "call_patch");
  assert.equal(report.nativeToolCalls, 1);
  assert.equal(report.nativeToolOutputs, 1);
});

test("falls back to a receipt when historical tool declaration is unavailable", () => {
  const source = {
    input: [
      { type: "custom_tool_call", call_id: "call_old", name: "lazy_tool", input: "raw input" },
      { type: "custom_tool_call_output", call_id: "call_old", output: "historical result" },
    ],
  };
  const { payload, report } = transformResponsesRequest(source, {
      profile: NATIVE_PAIR_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
  assert.deepEqual(payload.input.map((item) => item.role || item.type), ["assistant"]);
  assert.match(payload.input[0].content, /I executed a tool call[\s\S]*lazy_tool[\s\S]*historical result/);
  assert.equal(report.nativeToolCalls, 0);
  assert.equal(report.fallbackToolResults, 1);
  assert.equal(report.compactedToolResults, 1);
});

test("keeps assistant messages with text content", () => {
  const source = {
    input: [{ role: "assistant", content: [{ type: "output_text", text: "I will check" }] }],
  };
  const { payload } = transformResponsesRequest(source, {
      profile: NATIVE_PAIR_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
  assert.equal(payload.input.length, 1);
  assert.equal(payload.input[0].content, "I will check", "Go accepts historical assistant content only as a string");
});

test("joins multiple assistant text parts into Go-compatible string content", () => {
  const source = {
    input: [{ type: "message", id: "msg_old", role: "assistant", content: [
      { type: "output_text", text: "first" },
      { type: "output_text", text: "second" },
    ] }],
  };
  const { payload, report } = transformResponsesRequest(source, {
      profile: NATIVE_PAIR_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
  assert.equal(payload.input[0].content, "first\nsecond");
  assert.equal(report.stringifiedAssistantMessages, 1);
  assert.equal(report.inputShape[0].contentKind, "string");
});

test("converts a complete Chat tool pair into native Responses items", () => {
  const source = {
    tools: [{ type: "function", name: "x", parameters: { type: "object", properties: {} } }],
    input: [
      { role: "assistant", content: [], tool_calls: [{ id: "t1", type: "function", function: { name: "x", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t1", content: "ok" },
    ],
  };
  const { payload } = transformResponsesRequest(source, {
      profile: NATIVE_PAIR_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
  assert.deepEqual(payload.input.map((item) => item.type), ["function_call", "function_call_output"]);
  assert.equal(payload.input[0].call_id, "t1");
  assert.equal(payload.input[1].call_id, "t1");
});

test("drops assistant messages with reasoning-only content", () => {
  const source = {
    input: [{ role: "assistant", content: [{ type: "reasoning", summary: ["thinking"] }] }],
  };
  const { payload } = transformResponsesRequest(source, {
      profile: NATIVE_PAIR_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
  assert.equal(payload.input.length, 0, "reasoning-only content counts as empty");
});

test("drops assistant messages with string empty content", () => {
  const source = {
    input: [
      { role: "assistant", content: "" },
      { role: "user", content: "hi" },
    ],
  };
  const { payload } = transformResponsesRequest(source, {
      profile: NATIVE_PAIR_PROFILE,
      mediaStore: fakeStore(), defaultModel: "d" });
  assert.deepEqual(payload.input.map((item) => item.role), ["user"]);
});
