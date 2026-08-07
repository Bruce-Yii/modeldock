import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import {
  RouteAffinity,
  applyToolPolicy,
  createUsageTee,
  currentTurnStartForTesting,
  isNativeModel,
  nativeTarget,
  normalizeNativeInput,
  normalizeGatewayInput,
  pipeGatewayStream,
  redactBearer,
  relayNativeImage,
  relayNativeResponses,
  relayResponses,
  rewriteHistoricalImages,
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

// Decorate the underlying Writable with ServerResponse-shaped helpers instead of
// wrapping it in a plain object: pipeGatewayStream uses stream .pipe(), which
// needs a real Writable target (event emitter, backpressure) on the res side.
function responseStub(res) {
  return Object.assign(res, {
    statusCode: 200,
    headersSent: false,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    flushHeaders() {
      this.headersSent = true;
    },
  });
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

test("currentTurnStart is the item after the last assistant turn", () => {
  const input = [
    { type: "message", role: "user", content: [] },
    { type: "message", role: "assistant", content: [] },
    { type: "message", role: "user", content: [] },
  ];
  assert.equal(currentTurnStartForTesting(input), 2);
  assert.equal(currentTurnStartForTesting([{ type: "message", role: "user", content: [] }]), 0);
});

test("rewriteHistoricalImages replaces only non-current images with refs", () => {
  const mediaStore = {
    put: (url) => `img_${url.length}`,
  };
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "before" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "handled" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "current" }, { type: "input_image", image_url: "data:image/png;base64,BBBB" }] },
  ];
  const rewritten = rewriteHistoricalImages(input, mediaStore);
  assert.match(rewritten[0].content[1].text, /\[Image attachment img_\d+\./);
  assert.equal(rewritten[0].content[1].type, "input_text");
  assert.equal(rewritten[2].content[1].type, "input_image", "current-turn image stays untouched");
  assert.equal(rewritten[1], input[1], "assistant history is untouched");
});

test("rewriteHistoricalImages degrades to a plain placeholder without a media store", () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/x.png" }] },
    { type: "message", role: "assistant", content: [] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
  ];
  const rewritten = rewriteHistoricalImages(input, null);
  assert.equal(rewritten[0].content[0].type, "input_text");
  assert.match(rewritten[0].content[0].text, /handled in a prior turn/);
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
  assert.equal(stripped.toolSearch, 1);
  assert.equal(stripped.webSearch, 1);
  assert.equal(stripped.otherHosted, 1);
  assert.equal(stripped.toolSearch + stripped.webSearch + stripped.otherHosted, 3);
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

  const ds = upstreamTargetFor(config, "deepseek-v4-flash@deepseek-official");
  assert.equal(ds.provider, "deepseek-official");
  assert.equal(ds.model, "deepseek-v4-flash");
  assert.equal(ds.url, "https://api.deepseek.com/responses");
  assert.equal(ds.token, "ds-token");
});

test("upstreamTargetFor routes zen free models to the zen/v1 responses endpoint", () => {
  const config = configStub();
  const free = upstreamTargetFor(config, "deepseek-v4-flash-free");
  assert.equal(free.provider, "opencode-go");
  assert.equal(free.url, "https://opencode.ai/zen/v1/responses");
  assert.equal(free.token, "go-token");

  const mimo = upstreamTargetFor(config, "mimo-v2.5-free");
  assert.equal(mimo.url, "https://opencode.ai/zen/v1/responses");
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

test("createUsageTee extracts usage and output from a full non-streaming JSON body on end", () => {
  const events = [];
  const tee = createUsageTee((event) => events.push(event));
  const body = JSON.stringify({
    id: "resp_x",
    object: "response",
    status: "completed",
    output: [{ type: "function_call", call_id: "call_00_nonstream", name: "ls", arguments: "{}" }],
    usage: { input_tokens: 33, output_tokens: 9, total_tokens: 42 },
  });
  tee.push(body);
  tee.end();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "response.completed");
  assert.equal(events[0].response.usage.input_tokens, 33);
  assert.equal(events[0].response.output[0].call_id, "call_00_nonstream");
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

test("pipeGatewayStream settles when the client disconnects mid-stream", async () => {
  // A client disconnect emits "close" without "finish". The pipe must settle
  // (not hang forever) and must destroy the upstream reader so the fetch body
  // stops being consumed.
  let upstreamCancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("data: first\n\n"));
      // Never closes: simulates an upstream still streaming.
    },
    cancel() {
      upstreamCancelled = true;
    },
  });
  const sink = collectStream();
  const res = responseStub(sink);
  const piping = pipeGatewayStream(body, res, null);
  // Give the first chunk a tick to flow, then drop the client.
  await new Promise((resolve) => setTimeout(resolve, 20));
  res.emit("close");
  await piping;
  assert.equal(upstreamCancelled, true, "upstream body must be cancelled on client disconnect");
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
  const blockedReports = [];
  const finishResults = [];
  const metrics = {
    begin: () => (result) => finishResults.push(result),
    recordResponseTransform: (report) => blockedReports.push(report.blocked),
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
        recordUsage: () => {},
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
    const sentHeaders = Object.keys(calls[0].headers || {});
    assert.ok(!sentHeaders.some((name) => name.startsWith("x-opencode-")), "no opencode session spoofing headers are sent");
    assert.equal(affinity.snapshot().activeCallIds, 1);
    const forwarded = Buffer.concat(sink.chunks).toString("utf8");
    assert.match(forwarded, /response\.completed/);
    const blocked = blockedReports[blockedReports.length - 1];
    assert.deepEqual(blocked, { tool_search: 0, web_search: 1 }, "web_search is counted separately from tool_search");
    // The dashboard's context-token waveform reads recent[].inputTokens, which
    // comes from the finish() payload - regression guard for the flat-line bug.
    const finished = finishResults[finishResults.length - 1];
    assert.equal(finished.inputTokens, 4, "finish must carry input tokens onto the trace record");
    assert.equal(finished.outputTokens, 2, "finish must carry output tokens onto the trace record");
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
        recordUsage: () => {},
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
      recordUsage: () => {},
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

test("isNativeModel distinguishes catalog slugs from native GPT ids", () => {
  const known = new Set(["deepseek-v4-flash", "gpt-5.6-luna"]);
  assert.equal(isNativeModel("gpt-5.6-sol", known), true);
  assert.equal(isNativeModel("gpt-5.5", known), true);
  assert.equal(isNativeModel("deepseek-v4-flash", known), false);
  assert.equal(isNativeModel("gpt-5.6-luna", known), false);
  assert.equal(isNativeModel("", known), false, "an empty model id stays on the routed path");
  assert.equal(isNativeModel(undefined, known), false);
});

test("nativeTarget strips the keyed and bare /v1 prefixes", () => {
  assert.equal(nativeTarget("/c/k123/v1/responses", ""), "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(nativeTarget("/v1/responses", ""), "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(nativeTarget("/v1/images/generations", "?model=x"), "https://chatgpt.com/backend-api/codex/images/generations?model=x");
});

test("normalizeNativeInput strips non-opaque reasoning and expands summaries", () => {
  const input = [
    { type: "reasoning", encrypted_content: "local plaintext reasoning with spaces", summary: "kept" },
    { type: "reasoning", encrypted_content: "gAAAAABopaque_token_without_spaces", summary: "kept" },
    { type: "compaction", encrypted_content: [{ type: "summary_text", text: "earlier context" }] },
    { type: "compaction", encrypted_content: "gAAAAABopaque_fernettoken" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
  ];
  const out = normalizeNativeInput(input);
  assert.equal(out[0].encrypted_content, undefined, "non-opaque reasoning blob is stripped");
  assert.equal(out[0].summary, "kept");
  assert.equal(out[1].encrypted_content, "gAAAAABopaque_token_without_spaces", "opaque native token passes through");
  assert.equal(out[2].type, "message");
  assert.match(out[2].content[0].text, /earlier context/);
  assert.equal(out[3].encrypted_content, "gAAAAABopaque_fernettoken", "opaque compaction token passes through");
  assert.equal(out[4], input[4]);
});

test("relayNativeResponses forwards native GPT traffic to the ChatGPT backend", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":9,"output_tokens":3}}}\n\n'));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const result = await relayNativeResponses(
      {
        model: "gpt-5.6-sol",
        input: [
          { type: "reasoning", encrypted_content: "local plaintext reasoning" },
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        ],
        previous_response_id: "resp_old",
        tools: [{ type: "web_search" }],
      },
      res,
      {
        recordUsage: () => {},
        metrics: { begin: () => () => {}, recordResponseUsage: () => {} },
        incomingHeaders: {
          authorization: "Bearer chatgpt-token",
          "chatgpt-account-id": "acct-1",
          "x-oai-attestation": "attest",
          "x-codex-window-id": "w1",
          host: "127.0.0.1:4097",
        },
        requestUrl: "/c/key123/v1/responses",
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.upstream, "openai");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(calls[0].headers.authorization, "Bearer chatgpt-token");
    assert.equal(calls[0].headers["chatgpt-account-id"], "acct-1");
    assert.equal(calls[0].headers["x-oai-attestation"], "attest");
    assert.equal(calls[0].headers["x-codex-window-id"], "w1");
    assert.equal(calls[0].headers.host, undefined, "loopback bookkeeping headers are not forwarded");
    assert.equal(calls[0].body.previous_response_id, undefined, "previous_response_id is dropped for native");
    assert.equal(calls[0].body.model, "gpt-5.6-sol");
    assert.equal(calls[0].body.input[0].encrypted_content, undefined, "non-opaque reasoning is stripped");
    assert.equal(calls[0].body.input[1].content[0].text, "hi");
    assert.equal(result.usage.input_tokens, 9);
    const forwarded = Buffer.concat(sink.chunks).toString("utf8");
    assert.match(forwarded, /response\.completed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayNativeResponses forwards native errors untouched", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: "native says no" } }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
  try {
    const result = await relayNativeResponses(
      { model: "gpt-5.6-sol", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      res,
      {
        recordUsage: () => {},
        metrics: { begin: () => () => {}, recordResponseUsage: () => {} },
        incomingHeaders: { authorization: "Bearer chatgpt-token" },
        requestUrl: "/v1/responses",
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 401);
    const body = Buffer.concat(sink.chunks).toString("utf8");
    assert.match(body, /native says no/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses routes unknown slugs to the native leg instead of default_main", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ error: { message: "x" } }), { status: 401 });
  };
  try {
    const result = await relayResponses(
      { model: "gpt-5.5", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      res,
      {
        recordUsage: () => {},
        config: configStub(),
        metrics: { begin: () => () => {}, recordResponseUsage: () => {} },
        routeAffinity: new RouteAffinity(),
        knownModels: new Set(["deepseek-v4-flash", "gpt-5.6-luna"]),
        mainModel: "deepseek-v4-flash",
        visionModel: "gpt-5.6-luna",
        incomingHeaders: { authorization: "Bearer chatgpt-token" },
        requestUrl: "/v1/responses",
      },
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0], /chatgpt\.com\/backend-api\/codex\/responses/);
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayNativeImage forwards image generation to the native backend", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ data: [{ b64_json: "abc" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const result = await relayNativeImage(
      { model: "gpt-image-2", prompt: "a dashboard mockup", size: "1536x1024" },
      res,
      {
        incomingHeaders: { authorization: "Bearer chatgpt-token" },
        requestUrl: "/c/key123/v1/images/generations",
      },
    );
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://chatgpt.com/backend-api/codex/images/generations");
    assert.equal(calls[0].body.prompt, "a dashboard mockup");
    const forwarded = Buffer.concat(sink.chunks).toString("utf8");
    assert.match(forwarded, /b64_json/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
