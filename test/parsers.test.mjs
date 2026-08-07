import test from "node:test";
import assert from "node:assert/strict";
import { extractUsageFromSse } from "../src/metrics.mjs";
import { extractOutputText, parseMcpTextResult } from "../src/upstreams.mjs";

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
