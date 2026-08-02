import { test } from "node:test";
import assert from "node:assert/strict";
import { createUpstreams, parseMcpTextResult, extractOutputText } from "./upstreams.mjs";

test("parseMcpTextResult parses a plain JSON tools/call result", () => {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "the answer" }] },
  });
  assert.equal(parseMcpTextResult(body), "the answer");
});

test("parseMcpTextResult parses SSE-wrapped messages", () => {
  const body = [
    "event: message",
    'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"sse answer"}]}}',
    "",
  ].join("\n");
  assert.equal(parseMcpTextResult(body), "sse answer");
});

test("parseMcpTextResult picks the first payload with text content", () => {
  const body = [
    'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"image","data":"x"}]}}',
    'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"winner"}]}}',
  ].join("\n");
  assert.equal(parseMcpTextResult(body), "winner");
});

test("parseMcpTextResult returns empty string for unusable bodies", () => {
  assert.equal(parseMcpTextResult(""), "");
  assert.equal(parseMcpTextResult("{not json"), "");
  assert.equal(parseMcpTextResult(JSON.stringify({ result: { content: [] } })), "");
  assert.equal(parseMcpTextResult(JSON.stringify({ result: {} })), "");
  assert.equal(parseMcpTextResult(undefined), "");
});

test("extractOutputText joins message text parts", () => {
  const response = {
    output: [
      { type: "message", content: [{ type: "output_text", text: "first" }] },
      { type: "message", content: [{ type: "text", text: "second" }] },
      { type: "function_call", name: "x" },
    ],
  };
  assert.equal(extractOutputText(response), "first\nsecond");
});

test("extractOutputText skips non-text parts and non-message items", () => {
  const response = {
    output: [
      { type: "message", content: [{ type: "reasoning", text: "hidden" }, { type: "output_text", text: "visible" }] },
      { type: "message", content: [{ type: "output_text", text: "" }] },
      { type: "message", content: [] },
    ],
  };
  assert.equal(extractOutputText(response), "visible");
});

test("extractOutputText returns empty string for empty responses", () => {
  assert.equal(extractOutputText({ output: [] }), "");
  assert.equal(extractOutputText(undefined), "");
  assert.equal(extractOutputText({}), "");
});

test("searchWeb passes through and parses Exa response", async () => {
  const calls = [];
  const upstreams = createUpstreams({
    config: {
      exaMcpUrl: "https://mcp.exa.ai/mcp",
      exaApiKey: "",
      goToken: "t",
      goBaseUrl: "https://go.example.com/v1",
      visionTimeoutMs: 90_000,
      visionModel: "v",
      visionFallbackModel: "f",
    },
    metrics: new (await import("./metrics.mjs")).Metrics({ recentLimit: 10 }),
    mediaStore: { get: () => undefined },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "exa result" }] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const output = await upstreams.searchWeb({ query: "test query", numResults: 3 });
    assert.equal(output, "exa result");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://mcp.exa.ai/mcp");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.method, "tools/call");
    assert.equal(body.params.name, "web_search_exa");
    assert.equal(body.params.arguments.query, "test query");
    assert.equal(body.params.arguments.numResults, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("searchWeb appends exaApiKey as query param when configured", async () => {
  const calls = [];
  const upstreams = createUpstreams({
    config: {
      exaMcpUrl: "https://mcp.exa.ai/mcp",
      exaApiKey: "secret-key",
      goToken: "t",
      goBaseUrl: "https://go.example.com/v1",
      visionTimeoutMs: 90_000,
      visionModel: "v",
      visionFallbackModel: "f",
    },
    metrics: new (await import("./metrics.mjs")).Metrics({ recentLimit: 10 }),
    mediaStore: { get: () => undefined },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ result: { content: [{ type: "text", text: "x" }] } }), { status: 200 });
  };
  try {
    await upstreams.searchWeb({ query: "q" });
    assert.equal(calls[0], "https://mcp.exa.ai/mcp?exaApiKey=secret-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("searchWeb surfaces upstream errors and redacts bearer tokens", async () => {
  const upstreams = createUpstreams({
    config: {
      exaMcpUrl: "https://mcp.exa.ai/mcp",
      exaApiKey: "k",
      goToken: "t",
      goBaseUrl: "https://go.example.com/v1",
      visionTimeoutMs: 90_000,
      visionModel: "v",
      visionFallbackModel: "f",
    },
    metrics: new (await import("./metrics.mjs")).Metrics({ recentLimit: 10 }),
    mediaStore: { get: () => undefined },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('error: Authorization: Bearer abc123tokenxyz', { status: 500 });
  try {
    await assert.rejects(() => upstreams.searchWeb({ query: "q" }), /Bearer \[redacted\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
