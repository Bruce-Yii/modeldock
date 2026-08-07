import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import {
  RouteAffinity,
  applyToolPolicy,
  createUsageTee,
  normalizeGatewayInput,
  pipeGatewayStream,
  redactBearer,
  relayResponses,
  routeGatewayRequest,
  upstreamTargetFor,
} from "./gateway.mjs";

function configStub() {
  return {
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    opencodeBaseUrl: "https://opencode.ai/zen/go/v1",
    deepseekBaseUrl: "https://api.deepseek.com",
    goToken: "go-token",
    tokens: { "opencode-go": "go-token", "deepseek-official": "ds-token" },
    profileId: "opencode-go",
  };
}

function responseStub(res) {
  return {
    statusCode: 200,
    headersSent: false,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    flushHeaders() {
      this.headersSent = true;
    },
    write(chunk) {
      res.write(chunk);
    },
    end(chunk) {
      res.end(chunk);
    },
    destroy() {
      res.destroy?.();
    },
    get bytesWritten() {
      return res.bytesWritten;
    },
  };
}

function collectStream() {
  const chunks = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  writable.chunks = chunks;
  return writable;
}

function readAllFromStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

test("normalizeGatewayInput removes compaction triggers and expands compaction summaries", () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    { type: "compaction_trigger", skipped: true },
    { type: "compaction", encrypted_content: [{ type: "summary_text", text: "earlier context" }] },
  ];
  const normalized = normalizeGatewayInput(input);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].type, "message");
  assert.equal(normalized[1].type, "message");
  assert.equal(normalized[1].role, "user");
  assert.equal(normalized[1].content[0].text, "earlier context");
});

test("normalizeGatewayInput keeps non-compaction items untouched", () => {
  const item = { type: "function_call", call_id: "call_00_x", name: "ls", arguments: "{}" };
  const normalized = normalizeGatewayInput([item]);
  assert.deepEqual(normalized, [item]);
});

test("applyToolPolicy strips hosted tool schemas", () => {
  const tools = [
    { type: "function", name: "shell_command", parameters: {} },
    { type: "web_search", name: "web_search" },
    { type: "tool_search", name: "tool_search" },
    { type: "computer_use", name: "computer_use" },
  ];
  const { tools: kept, stripped } = applyToolPolicy(tools);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].name, "shell_command");
  assert.equal(stripped.hosted, 3);
});

test("applyToolPolicy hides view_image for text-only models", () => {
  const tools = [
    { type: "function", name: "view_image", parameters: {} },
    { type: "function", name: "vision_inspect", parameters: {} },
  ];
  const { tools: kept, stripped } = applyToolPolicy(tools);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].name, "vision_inspect");
  assert.equal(stripped.hidden, 1);
});

test("applyToolPolicy flattens MCP namespaces into qualified functions", () => {
  const tools = [
    {
      type: "namespace",
      name: "namespace:mcp__test",
      tools: [
        { type: "function", name: "hello", parameters: {} },
        { type: "function", name: "view_image", parameters: {} },
      ],
    },
  ];
  const { tools: kept, stripped } = applyToolPolicy(tools);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].type, "function");
  assert.equal(kept[0].name, "namespace:mcp__test__hello");
  assert.equal(stripped.namespaceChildren, 1);
  assert.equal(stripped.hidden, 1);
});

test("upstreamTargetFor routes by owning provider", () => {
  const config = configStub();
  const go = upstreamTargetFor(config, "deepseek-v4-flash");
  assert.equal(go.provider, "opencode-go");
  assert.equal(go.url, "https://opencode.ai/zen/go/v1/responses");
  assert.equal(go.token, "go-token");
  assert.equal(go.opencodeHeaders, true);

  const ds = upstreamTargetFor(config, "deepseek-v4-flash@deepseek-official");
  assert.equal(ds.provider, "deepseek-official");
  assert.equal(ds.model, "deepseek-v4-flash");
  assert.equal(ds.url, "https://api.deepseek.com/responses");
  assert.equal(ds.token, "ds-token");
  assert.equal(ds.opencodeHeaders, false);
});

test("routeGatewayRequest escalates current-turn images to the vision model", () => {
  const source = {
    model: "deepseek-v4-flash",
    input: [
      { type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/x.png" }] },
    ],
  };
  const route = routeGatewayRequest(source, {
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    affinity: new RouteAffinity(),
    knownModels: new Set(["deepseek-v4-flash", "gpt-5.6-luna"]),
  });
  assert.equal(route.model, "gpt-5.6-luna");
  assert.equal(route.directVision, true);
  assert.equal(route.reason, "current_turn_image");
});

test("routeGatewayRequest pins tool continuations to the vision model", () => {
  const affinity = new RouteAffinity();
  affinity.register("call_00_vision", "gpt-5.6-luna");
  const source = {
    model: "deepseek-v4-flash",
    input: [
      { type: "function_call_output", call_id: "call_00_vision", output: "{}" },
    ],
  };
  const route = routeGatewayRequest(source, {
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    affinity,
    knownModels: new Set(["deepseek-v4-flash", "gpt-5.6-luna"]),
  });
  assert.equal(route.model, "gpt-5.6-luna");
  assert.equal(route.reason, "luna_tool_continuation");
});

test("routeGatewayRequest defaults to the main model without images", () => {
  const source = {
    model: "deepseek-v4-flash",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  };
  const route = routeGatewayRequest(source, {
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    affinity: new RouteAffinity(),
    knownModels: new Set(["deepseek-v4-flash", "gpt-5.6-luna"]),
  });
  assert.equal(route.model, "deepseek-v4-flash");
  assert.equal(route.directVision, false);
});

test("createUsageTee extracts usage from response.completed events across chunks", () => {
  const usages = [];
  const tee = createUsageTee((event) => {
    if (event?.type === "response.completed" && event.response?.usage) usages.push(event.response.usage);
  });
  const sse = [
    'event: response.completed\n',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}\n\n',
  ];
  tee.push(sse[0]);
  tee.push(sse[1]);
  tee.end();
  assert.equal(usages.length, 1);
  assert.equal(usages[0].input_tokens, 10);
  assert.equal(usages[0].output_tokens, 5);
});

test("pipeGatewayStream forwards bytes verbatim and feeds the tee", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const teeChunks = [];
  const tee = createUsageTee(() => {});
  const originalPush = tee.push.bind(tee);
  tee.push = (chunk) => {
    teeChunks.push(Buffer.from(chunk));
    originalPush(chunk);
  };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n'));
      controller.enqueue(Buffer.from(": keepalive\n\n"));
      controller.close();
    },
  });
  await pipeGatewayStream(body, res, tee);
  const forwarded = Buffer.concat(sink.chunks).toString("utf8");
  assert.match(forwarded, /response\.output_text\.delta/);
  assert.match(forwarded, /keepalive/);
  assert.equal(Buffer.concat(teeChunks).toString("utf8"), forwarded);
});

test("redactBearer masks upstream tokens in error bodies", () => {
  const text = "Authorization: Bearer sk-abcdef123456, url https://x";
  const redacted = redactBearer(text);
  assert.match(redacted, /Bearer \[redacted\]/);
  assert.doesNotMatch(redacted, /sk-abcdef123456/);
});

test("relayResponses forwards a streamed response and records usage", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const metrics = {
    begin: () => () => {},
    recordResponseTransform: () => {},
    recordResponseUsage: () => {},
  };
  const affinity = new RouteAffinity();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, headers: options.headers });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-5.6-luna","output":[{"type":"function_call","call_id":"call_00_vis","name":"x","arguments":"{}"}],"usage":{"input_tokens":4,"output_tokens":2}}}\n\n'));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const result = await relayResponses(
      {
        model: "deepseek-v4-flash",
        input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/p.png" }] }],
        tools: [{ type: "web_search" }, { type: "function", name: "shell_command", parameters: {} }],
      },
      res,
      {
        config: configStub(),
        metrics,
        routeAffinity: affinity,
        knownModels: new Set(["deepseek-v4-flash", "gpt-5.6-luna"]),
        mainModel: "deepseek-v4-flash",
        visionModel: "gpt-5.6-luna",
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.route.model, "gpt-5.6-luna");
    assert.equal(result.usage.input_tokens, 4);
    assert.match(calls[0].url, /opencode\.ai\/zen\/go\/v1\/responses/);
    assert.equal(affinity.snapshot().activeCallIds, 1);
    const forwarded = Buffer.concat(sink.chunks).toString("utf8");
    assert.match(forwarded, /response\.completed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses redacts upstream errors and never forwards the token", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: "Bearer sk-secret123 rejected" } }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
  try {
    const result = await relayResponses(
      { model: "deepseek-v4-flash", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      res,
      {
        config: configStub(),
        routeAffinity: new RouteAffinity(),
        knownModels: new Set(["deepseek-v4-flash"]),
        mainModel: "deepseek-v4-flash",
        visionModel: "gpt-5.6-luna",
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 400);
    const body = Buffer.concat(sink.chunks).toString("utf8");
    assert.match(body, /Bearer \[redacted\]/);
    assert.doesNotMatch(body, /sk-secret123/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses rejects requests without a configured upstream token", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const config = configStub();
  config.tokens = { "opencode-go": "" };
  config.goToken = "";
  const result = await relayResponses(
    { model: "deepseek-v4-flash", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] },
    res,
    {
      config,
      routeAffinity: new RouteAffinity(),
      knownModels: new Set(["deepseek-v4-flash"]),
      mainModel: "deepseek-v4-flash",
      visionModel: "gpt-5.6-luna",
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 503);
  const body = Buffer.concat(sink.chunks).toString("utf8");
  assert.match(body, /configuration_error/);
});
