import test from "node:test";
import assert from "node:assert/strict";
import { MediaStore } from "../src/media-store.mjs";
import { transformResponsesRequest } from "../src/transform.mjs";

function store() {
  return new MediaStore({ ttlMs: 60_000, maxBytes: 1024 * 1024, maxEntries: 8 });
}

test("filters Codex hosted tools and normalizes required tool choice", () => {
  const result = transformResponsesRequest(
    {
      input: "hello",
      tools: [
        { type: "function", name: "keep_me", parameters: { type: "object", properties: {} } },
        { type: "tool_search" },
        { type: "web_search" },
      ],
      tool_choice: "required",
    },
    { mediaStore: store(), defaultModel: "deepseek-v4-flash" },
  );

  assert.equal(result.payload.model, "deepseek-v4-flash");
  assert.equal(result.payload.tool_choice, "auto");
  assert.equal(result.payload.parallel_tool_calls, false);
  assert.deepEqual(result.payload.tools.map((tool) => tool.name), ["keep_me", "harness_web_search"]);
  assert.equal(result.payload.input[0].content[0].text, "hello");
  assert.deepEqual(result.report.blocked, { tool_search: 1, web_search: 1 });
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
