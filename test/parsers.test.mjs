import test from "node:test";
import assert from "node:assert/strict";
import { extractUsageFromSse } from "../src/metrics.mjs";
import { extractOutputText, parseMcpTextResult } from "../src/upstreams.mjs";
import { adaptGoResponse } from "../src/responses-sse.mjs";

test("parses Exa MCP JSON and SSE text content", () => {
  const json = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "result" }] } });
  assert.equal(parseMcpTextResult(json), "result");
  assert.equal(parseMcpTextResult(`event: message\ndata: ${json}\n\n`), "result");
});

test("extracts usage from Responses SSE completion", () => {
  const event = { type: "response.completed", response: { usage: { input_tokens: 12, output_tokens: 7 } } };
  assert.deepEqual(extractUsageFromSse(`data: ${JSON.stringify(event)}\n\n`), event.response.usage);
});

test("extracts only model-facing output text", () => {
  assert.equal(
    extractOutputText({ output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "OK" }] }] }),
    "OK",
  );
});

test("maps Go function calls back to custom tool calls", () => {
  const adapted = adaptGoResponse(
    {
      id: "resp_2",
      output: [{ id: "call_1", type: "function_call", name: "apply_patch", call_id: "call_1", arguments: '{"patch":"PATCH_OK"}' }],
    },
    { tools: [{ type: "custom", name: "apply_patch" }] },
  );
  assert.deepEqual(adapted.output[0], {
    id: "call_1",
    type: "custom_tool_call",
    name: "apply_patch",
    call_id: "call_1",
    input: "PATCH_OK",
  });
});

test("adds stable item and call IDs when Go omits them", () => {
  const adapted = adaptGoResponse(
    { id: "resp_123", output: [{ type: "function_call", name: "lookup", arguments: "{}" }] },
    { tools: [{ type: "function", name: "lookup" }] },
  );
  assert.equal(adapted.output[0].id, "call_resp_123_0");
  assert.equal(adapted.output[0].call_id, "call_resp_123_0");
});
