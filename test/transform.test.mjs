import test from "node:test";
import assert from "node:assert/strict";
import { MediaStore } from "../src/media-store.mjs";
import { transformResponsesRequest } from "../src/transform.mjs";
import { OPENCODE_GO_PROFILE } from "../src/profiles.mjs";

function store() {
  return new MediaStore({ ttlMs: 60_000, maxBytes: 1024 * 1024, maxEntries: 8 });
}

test("filters Codex hosted tools and normalizes required tool choice", () => {
  const result = transformResponsesRequest(
    {
      input: "hello",
      tools: [
        { type: "function", name: "shell_command", parameters: { type: "object", properties: {} } },
        { type: "tool_search" },
        { type: "web_search" },
      ],
      tool_choice: "required",
    },
    { mediaStore: store(), defaultModel: "deepseek-v4-flash", profile: OPENCODE_GO_PROFILE },
  );

  assert.equal(result.payload.model, "deepseek-v4-flash");
  assert.equal(result.payload.tool_choice, "auto");
  assert.equal(result.payload.parallel_tool_calls, false);
  assert.deepEqual(result.payload.tools.map((tool) => tool.name), ["shell_command", "harness_tool_search", "harness_web_search"]);
  assert.equal(result.payload.input[0].content[0].text, "hello");
  assert.deepEqual(result.report.blocked, { tool_search: 1, web_search: 1 });
});

test("opencode-go profile hides non-core tools and exposes harness_tool_search", () => {
  const result = transformResponsesRequest(
    {
      input: "hello",
      tools: [
        { type: "function", name: "shell_command", parameters: { type: "object", properties: {} } },
        { type: "function", name: "spawn_agent", parameters: { type: "object", properties: {} } },
        { type: "namespace", name: "collaboration", tools: [
          { type: "function", name: "wait_agent", parameters: { type: "object", properties: {} } },
          { type: "function", name: "followup_task", parameters: { type: "object", properties: {} } },
        ] },
      ],
    },
    { mediaStore: store(), defaultModel: "deepseek-v4-flash", profile: OPENCODE_GO_PROFILE },
  );
  const names = result.payload.tools.map((tool) => tool.name);
  assert.ok(names.includes("shell_command"), "core tool stays visible");
  assert.ok(!names.includes("spawn_agent"), "non-core function is hidden");
  assert.ok(!names.includes("collaboration"), "namespace with no core children is hidden");
  assert.ok(names.includes("harness_tool_search"), "search tool injected");
});

test("disclosed tools from history are forwarded alongside core tools", () => {
  const result = transformResponsesRequest(
    {
      input: [
        { role: "user", content: [{ type: "input_text", text: "search" }] },
        { type: "function_call", id: "fc_s", call_id: "call_s", name: "harness_tool_search", arguments: '{"goal":"agents"}' },
        { type: "function_call_output", call_id: "call_s", output: 'TOOL_SEARCH_COMPLETED\nmatched_tools: spawn_agent\n"name":"spawn_agent"' },
      ],
      tools: [
        { type: "function", name: "shell_command", parameters: { type: "object", properties: {} } },
        { type: "function", name: "spawn_agent", parameters: { type: "object", properties: {} } },
      ],
    },
    { mediaStore: store(), defaultModel: "deepseek-v4-flash", profile: OPENCODE_GO_PROFILE },
  );
  const names = result.payload.tools.map((tool) => tool.name);
  assert.ok(names.includes("spawn_agent"), "disclosed tool is forwarded");
  assert.ok(names.includes("harness_tool_search"), "search tool stays injected");
});

test("replaces image data with a stable opaque reference", () => {
  const mediaStore = store();
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
  const request = {
    model: "deepseek-v4-flash",
    input: [{ role: "user", content: [{ type: "input_text", text: "inspect" }, { type: "input_image", image_url: image }] }],
  };
  const first = transformResponsesRequest(request, { mediaStore, defaultModel: "unused" });
  const second = transformResponsesRequest(request, { mediaStore, defaultModel: "unused" });

  assert.equal(first.report.imageRefs.length, 1);
  assert.equal(first.report.imageRefs[0], second.report.imageRefs[0]);
  assert.match(first.payload.input[0].content[1].text, new RegExp(first.report.imageRefs[0]));
  assert.equal(mediaStore.get(first.report.imageRefs[0]).imageUrl, image);
});

test("rejects local and non-HTTPS image URLs", () => {
  const mediaStore = store();
  assert.throws(() => mediaStore.put("http://example.com/image.png"), /Only image data URLs/);
  assert.throws(() => mediaStore.put("https://localhost/image.png"), /Local image URLs/);
});

test("adds IDs required by Go to replayable Responses tool result items", () => {
  const result = transformResponsesRequest(
    {
      model: "deepseek-v4-flash",
      tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
      input: [
        { type: "function_call", call_id: "call_123", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "call_123", output: "done" },
      ],
    },
    { mediaStore: store(), defaultModel: "deepseek-v4-flash" },
  );
  assert.equal(result.payload.input[1].id, "function_call_output_call_123");
});

test("does not invent reasoning content on returned function calls", () => {
  const result = transformResponsesRequest(
    {
      tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
      input: [
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
    },
    { mediaStore: store(), defaultModel: "deepseek-v4-flash" },
  );
  assert.equal(result.payload.input[0].reasoning_content, undefined);
});

test("preserves an existing reasoning_content on returned function calls", () => {
  const result = transformResponsesRequest(
    {
      tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
      input: [
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{}", reasoning_content: "original" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
    },
    { mediaStore: store(), defaultModel: "deepseek-v4-flash" },
  );
  assert.equal(result.payload.input[0].reasoning_content, "original");
});

test("removes the legacy ModelDock reasoning placeholder from history", () => {
  const result = transformResponsesRequest(
    {
      tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
      input: [
        { role: "assistant", content: [{ type: "output_text", text: "Checking." }], reasoning_content: "tool call" },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{}", reasoning_content: "tool call" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
    },
    { mediaStore: store(), defaultModel: "deepseek-v4-flash" },
  );
  assert.equal(result.payload.input[0].reasoning_content, undefined);
  assert.equal(result.payload.input[1].reasoning_content, undefined);
});

test("preserves all completed tool turns as native Responses pairs", () => {
  const result = transformResponsesRequest(
    {
      tools: [
        { type: "function", name: "first", parameters: { type: "object", properties: {} } },
        { type: "function", name: "second", parameters: { type: "object", properties: {} } },
      ],
      input: [
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "first", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "old result" },
        { type: "function_call", id: "fc_2", call_id: "call_2", name: "second", arguments: "{}" },
        { type: "function_call_output", call_id: "call_2", output: "new result" },
      ],
    },
    { mediaStore: store(), defaultModel: "deepseek-v4-flash" },
  );
  assert.equal(result.report.compactedToolResults, 0);
  assert.equal(result.report.nativeToolCalls, 2);
  assert.equal(result.report.nativeToolOutputs, 2);
  assert.deepEqual(result.payload.input.map((item) => item.type), [
    "function_call", "function_call_output", "function_call", "function_call_output",
  ]);
  assert.equal(result.payload.input[1].output, "old result");
  assert.equal(result.payload.input[3].output, "new result");
});

test("replaces image tool outputs with a cached reference instead of base64 text", () => {
  const mediaStore = store();
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
  const result = transformResponsesRequest(
    {
      model: "deepseek-v4-flash",
      tools: [{ type: "function", name: "view_image", parameters: { type: "object", properties: {} } }],
      input: [
        { type: "function_call", id: "call_1", call_id: "call_1", name: "view_image", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: [{ type: "input_image", image_url: image }] },
      ],
    },
    { mediaStore, defaultModel: "deepseek-v4-flash" },
  );
  assert.equal(result.report.imageRefs.length, 1, "image ref should be registered");
  assert.equal(mediaStore.get(result.report.imageRefs[0]).imageUrl, image);
  assert.equal(result.report.compactedToolOutputBytes, 0, "base64 must not be embedded in output bytes");
  const embedded = result.payload.input.some((item) => {
    const text = typeof item?.content === "string" ? item.content : item?.output;
    return typeof text === "string" && text.includes("iVBORw0KGgo");
  });
  assert.equal(embedded, false, "base64 payload must not appear in the forwarded input");
});
