import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createApp, createServices, codexModelCatalog } from "./server.mjs";

function baseConfig() {
  return {
    host: "127.0.0.1",
    port: 0,
    goBaseUrl: "https://go.example.com/v1",
    goToken: "test-token",
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    visionFallbackModel: "kimi-k2.5",
    visionTimeoutMs: 90_000,
    mediaTtlMs: 60_000,
    mediaMaxBytes: 10 * 1024 * 1024,
    mediaMaxEntries: 64,
    exaMcpUrl: "https://mcp.exa.ai/mcp",
    exaApiKey: "",
    recentLimit: 50,
    messagingMode: "streaming",
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  return server.address().port;
}

async function startApp(configOverrides = {}) {
  const config = { ...baseConfig(), ...configOverrides };
  if (configOverrides.goToken === null) delete config.goToken;
  const services = createServices(config);
  const { app } = createApp(services);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, server, services, stop: async () => { await services.mediaStore.cleanup(); server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); } };
}

function jsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    (async () => {
      for await (const chunk of req) chunks.push(chunk);
      resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    })();
  });
}

function sendSse(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

const okResponse = { id: "resp_1", object: "response", status: "completed", output: [], usage: { input_tokens: 111, output_tokens: 22 } };

test("without token: healthz and responses return 503, local models catalog still works", async (t) => {
  const instance = await startApp({ goToken: null });
  t.after(instance.stop);
  assert.equal((await fetch(`${instance.base}/healthz`)).status, 503);
  const models = await fetch(`${instance.base}/v1/models`);
  assert.equal(models.status, 200, "models catalog is local and does not need the token");
  assert.equal((await models.json()).models[0].slug, "deepseek-v4-flash");
  const responses = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "hi" }),
  });
  assert.equal(responses.status, 503);
  assert.equal((await responses.json()).error.type, "configuration_error");
});

test("with token: healthz returns 200", async (t) => {
  const instance = await startApp();
  t.after(instance.stop);
  const response = await fetch(`${instance.base}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("messaging mode is exposed and can switch at runtime", async (t) => {
  const instance = await startApp({ messagingMode: "buffered" });
  t.after(instance.stop);

  const initial = await (await fetch(`${instance.base}/api/status`)).json();
  assert.equal(initial.messaging.mode, "buffered");

  const invalid = await fetch(`${instance.base}/api/messaging`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "sometimes" }),
  });
  assert.equal(invalid.status, 400);

  const changed = await fetch(`${instance.base}/api/messaging`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "streaming" }),
  });
  assert.deepEqual(await changed.json(), { mode: "streaming" });
  const final = await (await fetch(`${instance.base}/api/status`)).json();
  assert.equal(final.messaging.mode, "streaming");
});

test("model API exposes selectable main and vision-capable options", async (t) => {
  const instance = await startApp();
  t.after(instance.stop);
  const initial = await (await fetch(`${instance.base}/api/models`)).json();
  assert.equal(initial.selected.mainModel, "deepseek-v4-flash");
  assert.deepEqual(initial.options.filter((model) => model.supportsVision).map((model) => model.id), ["gpt-5.6-luna", "kimi-k2.5"]);
  const changed = await fetch(`${instance.base}/api/models`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mainModel: "gpt-5.6-luna", visionModel: "kimi-k2.5" }) });
  assert.equal(changed.status, 200);
  assert.deepEqual((await changed.json()).selected, { mainModel: "gpt-5.6-luna", visionModel: "kimi-k2.5" });
  const invalid = await fetch(`${instance.base}/api/models`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visionModel: "deepseek-v4-flash" }) });
  assert.equal(invalid.status, 400);
});

test("non-streaming relay: forwards normalized body with auth and parses usage", async (t) => {
  let received;
  let auth;
  const upstream = createServer(async (req, res) => {
    auth = req.headers.authorization;
    received = await jsonBody(req);
    res.setHeader("content-type", "application/json");
    res.setHeader("x-request-id", "req-123");
    res.end(JSON.stringify(okResponse));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${upstreamPort}` });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "hello", tools: [{ type: "web_search" }] }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), "req-123");
  assert.equal((await response.json()).id, "resp_1");
  assert.equal(auth, "Bearer test-token");
  assert.equal(received.model, "deepseek-v4-flash");
  assert.equal(received.parallel_tool_calls, false);
  assert.deepEqual(received.input, [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]);
  assert.deepEqual(received.tools.map((tool) => tool.name), ["harness_web_search"]);

  const snap = instance.services.metrics.snapshot();
  assert.equal(snap.responses.total, 1);
  assert.equal(snap.responses.ok, 1);
  assert.equal(snap.responses.inputTokens, 111);
  assert.equal(snap.responses.outputTokens, 22);
  assert.equal(snap.responses.filteredWebSearch, 1);
});

test("executes harness web search inside the Responses loop", async (t) => {
  let goCalls = 0;
  let continuedInput;
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    res.setHeader("content-type", "application/json");
    if (req.url === "/mcp") {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "Source https://opencode.ai/docs/go/" }] } }));
      return;
    }
    goCalls += 1;
    if (goCalls === 1) {
      res.end(
        JSON.stringify({
          id: "resp_tool",
          output: [
            {
              id: "fc_web",
              type: "function_call",
              name: "harness_web_search",
              call_id: "call_web",
              arguments: JSON.stringify({ queries: ["OpenCode Go docs"] }),
            },
          ],
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      );
      return;
    }
    continuedInput = body.input;
    res.end(
      JSON.stringify({
        id: "resp_final",
        output: [{ id: "msg_final", type: "message", role: "assistant", content: [{ type: "output_text", text: "DONE" }] }],
        usage: { input_tokens: 20, output_tokens: 3 },
      }),
    );
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}`, exaMcpUrl: `http://127.0.0.1:${port}/mcp` });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "search", tools: [{ type: "tool_search" }] }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.output[0].content[0].text, "DONE");
  assert.equal(goCalls, 2);
  assert.match(continuedInput.at(-1).content[0].text, /https:\/\/opencode\.ai\/docs\/go\//);
  assert.equal(body.usage.input_tokens, 30);
  assert.equal(instance.services.metrics.web.ok, 1);
  const responseTrace = instance.services.metrics.recent.find((item) => item.kind === "responses");
  assert.equal(responseTrace.harnessToolRounds, 1);
});

test("upstream 4xx is relayed with status and body, metrics count error", async (t) => {
  const upstream = createServer((req, res) => {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: "model not found", type: "invalid_request_error" } }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${upstreamPort}` });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "x" }),
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.message, "model not found");
  const snap = instance.services.metrics.snapshot();
  assert.equal(snap.responses.errors, 1);
  assert.equal(snap.recent[0].httpStatus, 404);
});

test("upstream network failure returns 502", async (t) => {
  const upstream = createServer(() => {});
  const upstreamPort = await listen(upstream);
  const port = upstreamPort;
  upstream.close();

  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "x" }),
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.type, "upstream_error");
});

test("invalid request body returns 400 before calling upstream", async (t) => {
  let upstreamCalled = false;
  const upstream = createServer((req, res) => {
    upstreamCalled = true;
    res.end("{}");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${upstreamPort}` });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([]),
  });
  assert.equal(response.status, 400);
  assert.equal(upstreamCalled, false);
});

test("second-turn Codex assistant arrays are stringified for strict Console Go", async (t) => {
  let receivedAssistant;
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    receivedAssistant = body.input.find((item) => item?.role === "assistant");
    if (receivedAssistant && typeof receivedAssistant.content !== "string") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "Invalid assistant message: content or tool_calls must be set" } }));
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    sendSse(res, "response.output_text.delta", { id: "resp_second", delta: "SECOND_TURN_OK", response: { id: "resp_second", model: body.model } });
    sendSse(res, "response.completed", { id: "resp_second", response: { id: "resp_second", usage: { input_tokens: 12, output_tokens: 3 } } });
    res.end("data: [DONE]\n\n");
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stream: true,
      input: [
        { type: "message", id: "msg_previous", role: "assistant", content: [{ type: "output_text", text: "Previous answer" }] },
        { type: "message", id: "msg_current", role: "user", content: [{ type: "input_text", text: "Continue" }] },
      ],
    }),
  });
  const sse = await response.text();
  assert.equal(response.status, 200);
  assert.equal(receivedAssistant.content, "Previous answer");
  assert.match(sse, /SECOND_TURN_OK/);
  const trace = instance.services.metrics.recent.find((item) => item.kind === "responses");
  assert.equal(trace.stringifiedAssistantMessages, 1);
  assert.equal(trace.inputShape.find((item) => item.role === "assistant").contentKind, "string");
});

test("compresses completed Codex tool history to ordered receipts for Go", async (t) => {
  let received;
  const upstream = createServer(async (req, res) => {
    received = await jsonBody(req);
    res.setHeader("content-type", "text/event-stream");
    sendSse(res, "response.output_text.delta", { id: "resp_history", delta: "HISTORY_OK", response: { id: "resp_history", model: received.model } });
    sendSse(res, "response.completed", { id: "resp_history", response: { id: "resp_history", usage: { input_tokens: 20, output_tokens: 2 } } });
    res.end("data: [DONE]\n\n");
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stream: true,
      tools: [{ type: "custom", name: "shell_command", description: "run a command" }],
      input: [
        { role: "user", content: [{ type: "input_text", text: "Run both checks" }] },
        { role: "assistant", content: [] },
        { id: "ctc_1", type: "custom_tool_call", call_id: "call_1", name: "shell_command", input: "first" },
        { type: "custom_tool_call_output", call_id: "call_1", output: "first result" },
        { role: "assistant", content: [{ type: "output_text", text: "Running the second check" }] },
        { id: "ctc_2", type: "custom_tool_call", call_id: "call_2", name: "shell_command", input: "second" },
        { type: "custom_tool_call_output", call_id: "call_2", output: "second result" },
        { role: "user", content: [{ type: "input_text", text: "Finish" }] },
      ],
    }),
  });
  const sse = await response.text();
  assert.equal(response.status, 200);
  assert.match(sse, /HISTORY_OK/);
  assert.deepEqual(received.input.map((item) => item.role || item.type), [
    "user", "user", "assistant", "user", "user",
  ]);
  assert.equal(received.input.some((item) => Array.isArray(item.tool_calls)), false);
  assert.deepEqual(received.input.filter((item) => item.role === "user").map((item) => item.content?.[0]?.text).filter((text) => text?.includes("tool_output_begin")), [
    received.input[1].content[0].text,
    received.input[3].content[0].text,
  ]);
  const trace = instance.services.metrics.recent.find((item) => item.kind === "responses");
  assert.equal(trace.nativeToolCalls, 0);
  assert.equal(trace.nativeToolOutputs, 0);
  assert.equal(trace.compactedToolResults, 2);
  assert.equal(trace.fallbackToolResults, 0);
  assert.equal(trace.droppedAssistantMessages, 1);
});

test("buffered relay asks Go for JSON and emits one complete Codex SSE response", async (t) => {
  let received;
  const upstream = createServer(async (req, res) => {
    received = await jsonBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "resp_buffered",
      object: "response",
      status: "completed",
      model: received.model,
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Buffered answer." }] },
        { type: "function_call", name: "apply_patch", call_id: "call_patch", arguments: JSON.stringify({ patch: "PATCH_OK" }) },
      ],
      usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
    }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${upstreamPort}`, messagingMode: "buffered" });
  t.after(instance.stop);
  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      input: "apply a change",
      stream: true,
      tools: [{ type: "custom", name: "apply_patch", description: "apply a patch" }],
    }),
  });
  const sse = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-modeldock-stream-mode"), "buffered");
  assert.equal(received.stream, false);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.match(sse, /event: response\.created/);
  assert.match(sse, /event: response\.completed/);
  assert.match(sse, /Buffered answer\./);
  assert.match(sse, /custom_tool_call/);
  assert.match(sse, /PATCH_OK/);
  assert.match(sse, /data: \[DONE\]/);
  const completed = [...sse.matchAll(/^data: (\{.*\})$/gm)]
    .map((match) => JSON.parse(match[1]))
    .find((event) => event.type === "response.completed");
  assert.deepEqual(completed.response.output.map((item) => item.type), ["message", "custom_tool_call"]);
  const trace = instance.services.metrics.recent.find((item) => item.kind === "responses");
  assert.equal(trace.streamMode, "buffered");
  assert.equal(instance.services.metrics.responses.inputTokens, 12);
  assert.equal(instance.services.metrics.responses.outputTokens, 5);
});

test("streaming relay emits the first delta before upstream completion", async (t) => {
  let received;
  let releaseCompletion;
  const completionGate = new Promise((resolve) => { releaseCompletion = resolve; });
  let upstreamCompleted = false;
  const upstream = createServer(async (req, res) => {
    received = await jsonBody(req);
    res.setHeader("content-type", "text/event-stream");
    res.flushHeaders();
    sendSse(res, "response.output_text.delta", { id: "resp_s", delta: "live ", response: { id: "resp_s", model: "deepseek-v4-flash" } });
    await completionGate;
    upstreamCompleted = true;
    sendSse(res, "response.output_text.delta", { id: "resp_s", delta: "hello", response: { id: "resp_s", model: "deepseek-v4-flash" } });
    sendSse(res, "response.completed", { id: "resp_s", response: { id: "resp_s", model: "deepseek-v4-flash", usage: { input_tokens: 333, output_tokens: 44, total_tokens: 377 } } });
    res.end("data: [DONE]\n\n");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${upstreamPort}` });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ input: "hi", stream: true }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-modeldock-stream-mode"), "live-normalized");
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.equal(received.stream, true, "upstream must stay streaming");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  assert.equal(upstreamCompleted, false, "the client received bytes before the provider completed");
  assert.match(first, /response\.(created|in_progress|output_item\.added|content_part\.added|output_text\.delta)/);
  releaseCompletion();
  let sse = first;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    sse += decoder.decode(value, { stream: true });
  }

  const types = [...sse.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(types, [
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ]);
  assert.match(sse, /live /);
  assert.match(sse, /hello/);
  assert.match(sse, /data: \[DONE\]/);

  const snap = instance.services.metrics.snapshot();
  assert.equal(snap.responses.streaming, 1);
  assert.equal(snap.responses.inputTokens, 333);
  assert.equal(snap.responses.outputTokens, 44);
});

test("streaming relay keeps preamble text and a following tool call at distinct output indexes", async (t) => {
  const upstream = createServer((req, res) => {
    res.setHeader("content-type", "text/event-stream");
    sendSse(res, "response.output_text.delta", { id: "resp_mixed", delta: "I will verify this now: ", response: { id: "resp_mixed", model: "deepseek-v4-flash" } });
    sendSse(res, "response.output_item.added", {
      output_index: 1,
      item: { id: "fc_verify", type: "function_call", name: "shell_command", call_id: "call_verify", arguments: "" },
    });
    sendSse(res, "response.function_call_arguments.delta", { output_index: 1, delta: '{"command":"pwd"}' });
    sendSse(res, "response.completed", { id: "resp_mixed", response: { id: "resp_mixed", usage: { input_tokens: 10, output_tokens: 4 } } });
    res.end("data: [DONE]\n\n");
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: "locate the current session",
      stream: true,
      tools: [{ type: "function", name: "shell_command", description: "run shell", parameters: { type: "object", properties: {} } }],
    }),
  });
  const sse = await response.text();
  assert.equal(response.status, 200);
  const events = [...sse.matchAll(/^data: (\{.*\})$/gm)].map((match) => JSON.parse(match[1]));
  const added = events.filter((event) => event.type === "response.output_item.added");
  const done = events.filter((event) => event.type === "response.output_item.done");
  const completed = events.find((event) => event.type === "response.completed");
  assert.deepEqual(added.map((event) => [event.output_index, event.item.type]), [[0, "message"], [1, "function_call"]]);
  assert.equal(added[1].item.id, "call_verify");
  assert.equal(added[1].item.id, added[1].item.call_id);
  assert.deepEqual(done.map((event) => [event.output_index, event.item.type]), [[0, "message"], [1, "function_call"]]);
  assert.deepEqual(completed.response.output.map((item) => item.type), ["message", "function_call"]);
  assert.equal(new Set(added.map((event) => event.output_index)).size, 2);
  assert.match(sse, /I will verify this now/);
  assert.match(sse, /call_verify/);
});

test("streaming relay keeps preamble text and a following custom tool call at distinct output indexes", async (t) => {
  const upstream = createServer((req, res) => {
    res.setHeader("content-type", "text/event-stream");
    sendSse(res, "response.output_text.delta", { id: "resp_custom_mixed", delta: "I will apply the change: ", response: { id: "resp_custom_mixed", model: "deepseek-v4-flash" } });
    sendSse(res, "response.output_item.added", {
      output_index: 1,
      item: { id: "fc_patch", type: "function_call", name: "apply_patch", call_id: "call_patch", arguments: "" },
    });
    sendSse(res, "response.function_call_arguments.delta", { output_index: 1, delta: '{"patch":"PATCH_OK"}' });
    sendSse(res, "response.completed", { id: "resp_custom_mixed", response: { id: "resp_custom_mixed", usage: { input_tokens: 10, output_tokens: 4 } } });
    res.end("data: [DONE]\n\n");
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: "apply the patch",
      stream: true,
      tools: [{ type: "custom", name: "apply_patch", description: "apply a patch" }],
    }),
  });
  const sse = await response.text();
  assert.equal(response.status, 200);
  const events = [...sse.matchAll(/^data: (\{.*\})$/gm)].map((match) => JSON.parse(match[1]));
  const added = events.filter((event) => event.type === "response.output_item.added");
  const done = events.filter((event) => event.type === "response.output_item.done");
  const completed = events.find((event) => event.type === "response.completed");
  assert.deepEqual(added.map((event) => [event.output_index, event.item.type]), [[0, "message"], [1, "custom_tool_call"]]);
  assert.equal(added[1].item.id, "call_patch");
  assert.equal(added[1].item.id, added[1].item.call_id);
  assert.deepEqual(done.map((event) => [event.output_index, event.item.type]), [[0, "message"], [1, "custom_tool_call"]]);
  assert.deepEqual(completed.response.output.map((item) => item.type), ["message", "custom_tool_call"]);
  assert.equal(new Set(added.map((event) => event.output_index)).size, 2);
  assert.match(sse, /I will apply the change/);
  assert.match(sse, /PATCH_OK/);
});

test("streaming relay hides a harness web round and streams only the final answer", async (t) => {
  let goCalls = 0;
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    if (req.url === "/mcp") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "Evidence https://example.test/source" }] } }));
      return;
    }
    goCalls += 1;
    res.setHeader("content-type", "text/event-stream");
    if (goCalls === 1) {
      sendSse(res, "response.output_item.added", {
        output_index: 0,
        item: { id: "fc_web", type: "function_call", name: "harness_web_search", call_id: "call_web", arguments: "" },
      });
      sendSse(res, "response.function_call_arguments.delta", { output_index: 0, delta: '{"queries":["example"]}' });
      sendSse(res, "response.completed", { id: "resp_web", response: { id: "resp_web", usage: { input_tokens: 10, output_tokens: 2 } } });
      res.end("data: [DONE]\n\n");
      return;
    }
    assert.match(body.input.at(-1).content[0].text, /example\.test\/source/);
    sendSse(res, "response.output_text.delta", { id: "resp_final", delta: "FINAL", response: { id: "resp_final", model: body.model } });
    sendSse(res, "response.completed", { id: "resp_final", response: { id: "resp_final", usage: { input_tokens: 20, output_tokens: 3 } } });
    res.end("data: [DONE]\n\n");
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}`, exaMcpUrl: `http://127.0.0.1:${port}/mcp` });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "search", stream: true, tools: [{ type: "tool_search" }] }),
  });
  const sse = await response.text();
  assert.equal(response.status, 200);
  assert.equal(goCalls, 2);
  assert.match(sse, /FINAL/);
  assert.doesNotMatch(sse, /harness_web_search/);
  const trace = instance.services.metrics.recent.find((item) => item.kind === "responses");
  assert.equal(trace.harnessToolRounds, 1);
  assert.equal(instance.services.metrics.responses.inputTokens, 30);
  assert.equal(instance.services.metrics.responses.outputTokens, 5);
});

test("streaming upstream errors preserve the provider message in the trace", async (t) => {
  const upstream = createServer((req, res) => {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "specific provider validation failure" } }));
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "bad history", stream: true }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.message, "specific provider validation failure");
  const trace = instance.services.metrics.recent.find((item) => item.kind === "responses");
  assert.equal(trace.error, "specific provider validation failure");
});

test("function calls from Go map to custom tool calls for Codex", async (t) => {
  const upstream = createServer((req, res) => {
    res.setHeader("content-type", "text/event-stream");
    sendSse(res, "response.output_item.added", {
      output_index: 0,
      item: { id: "call_1", type: "function_call", name: "apply_patch", call_id: "call_1", arguments: "" },
    });
    sendSse(res, "response.function_call_arguments.delta", { output_index: 0, delta: '{"patch":"PATCH_OK"}' });
    sendSse(res, "response.completed", { id: "resp_custom", response: { id: "resp_custom", model: "deepseek-v4-flash", usage: {} } });
    res.end("data: [DONE]\n\n");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${upstreamPort}` });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      stream: true,
      tools: [{ type: "custom", name: "apply_patch", description: "patch" }],
      input: "make the change",
    }),
  });
  assert.equal(response.status, 200);
  const sse = await response.text();
  assert.match(sse, /event: response\.custom_tool_call_input\.done/);
  assert.match(sse, /"type":"custom_tool_call"/);
  assert.match(sse, /PATCH_OK/);
});

test("images are replaced and stored in media store", async (t) => {
  const upstream = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(okResponse));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${upstreamPort}` });
  t.after(instance.stop);

  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [{ role: "user", content: [{ type: "input_image", image_url: dataUrl }] }],
    }),
  });
  assert.equal(response.status, 200);
  const snap = instance.services.metrics.snapshot();
  assert.equal(snap.responses.imageAttachments, 1);
  assert.equal(instance.services.mediaStore.snapshot().entries, 1);
});

test("a visual turn is sent intact to Luna and exposed in route evidence", async (t) => {
  let received;
  const upstream = createServer(async (req, res) => {
    received = await jsonBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "resp_luna",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "I can see it." }] }],
      usage: { input_tokens: 10, output_tokens: 4 },
    }));
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);

  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      input: [{ role: "user", content: [
        { type: "input_text", text: "What is visible?" },
        { type: "input_image", image_url: dataUrl },
      ] }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-modeldock-route"), "current_turn_image");
  assert.equal(response.headers.get("x-modeldock-model"), "gpt-5.6-luna");
  assert.equal(received.model, "gpt-5.6-luna");
  assert.equal(received.input[0].content[1].type, "input_image");
  assert.equal(received.tools?.some((tool) => tool.name === "harness_vision_inspect") || false, false);
  const trace = instance.services.metrics.recent.find((item) => item.kind === "responses");
  assert.equal(trace.model, "gpt-5.6-luna");
  assert.equal(trace.directVision, true);
  assert.equal(trace.routeReason, "current_turn_image");
});

test("Luna tool calls stay on Luna, then the next independent turn returns to DeepSeek", async (t) => {
  const receivedModels = [];
  const receivedBodies = [];
  let call = 0;
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    receivedBodies.push(body);
    receivedModels.push(body.model);
    call += 1;
    res.setHeader("content-type", "application/json");
    if (call === 1) {
      res.end(JSON.stringify({ id: "resp_luna_call", output: [{
        id: "fc_luna", type: "function_call", name: "shell_command", call_id: "call_luna", arguments: "{}",
      }] }));
      return;
    }
    res.end(JSON.stringify({ id: `resp_${call}`, output: [{
      type: "message", role: "assistant", content: [{ type: "output_text", text: call === 2 ? "Visual tool work finished." : "Back on main." }],
    }] }));
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";

  const first = await fetch(`${instance.base}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: [{ role: "user", content: [{ type: "input_image", image_url: dataUrl }] }] }),
  });
  assert.equal(first.status, 200);
  assert.equal(instance.services.routeAffinity.snapshot().activeCallIds, 1);

  const second = await fetch(`${instance.base}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: [
      { role: "user", content: [{ type: "input_image", image_url: dataUrl }] },
      { role: "assistant", content: [] },
      { type: "custom_tool_call", name: "shell_command", call_id: "call_luna", input: "{}" },
      { type: "custom_tool_call_output", call_id: "call_luna", output: "ok" },
    ] }),
  });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("x-modeldock-route"), "luna_tool_continuation");

  const third = await fetch(`${instance.base}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: [
      { role: "user", content: [{ type: "input_image", image_url: dataUrl }] },
      { role: "assistant", content: [{ type: "output_text", text: "Visual tool work finished." }] },
      { role: "user", content: [{ type: "input_text", text: "Now implement the fix." }] },
    ] }),
  });
  assert.equal(third.status, 200);
  assert.equal(third.headers.get("x-modeldock-route"), "default_main");
  assert.deepEqual(receivedModels, ["gpt-5.6-luna", "gpt-5.6-luna", "deepseek-v4-flash"]);
  assert.equal(receivedBodies[2].tools?.some((tool) => tool.name === "harness_vision_inspect") || false, false);
  assert.match(receivedBodies[2].input[0].content[0].text, /Earlier image attachment/);
});

test("DeepSeek fallback vision receives an explicit Luna observation and cannot repeat it in the same loop", async (t) => {
  let mainCalls = 0;
  let continuation;
  let actualRef;
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    res.setHeader("content-type", "application/json");
    if (body.model === "gpt-5.6-luna") {
      assert.equal(body.max_output_tokens, 4_096);
      res.end(JSON.stringify({ id: "resp_small_luna", output: [{
        type: "message", role: "assistant", content: [{ type: "output_text", text: "The button is covered by a modal." }],
      }] }));
      return;
    }
    mainCalls += 1;
    if (mainCalls === 1) {
      res.end(JSON.stringify({ id: "resp_vision_call", output: [{
        type: "function_call",
        name: "harness_vision_inspect",
        call_id: "call_vision",
        arguments: JSON.stringify({ image_ref: actualRef, question: "Why is the button hidden?", mode: "ui" }),
      }] }));
      return;
    }
    continuation = body;
    res.end(JSON.stringify({ id: "resp_final", output: [{
      type: "message", role: "assistant", content: [{ type: "output_text", text: "Use a higher z-index." }],
    }] }));
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);
  actualRef = instance.services.mediaStore.put("data:image/png;base64,iVBORw0KGgo=");

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: "Continue the task.",
      tools: [{ type: "function", name: "harness_vision_inspect", description: "vision", parameters: { type: "object", properties: {} } }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(mainCalls, 2);
  const observation = continuation.input.at(-1).content[0].text;
  assert.match(observation, /LOCAL VISION OBSERVATION/);
  assert.match(observation, /VISION_INSPECTION_COMPLETED/);
  assert.match(observation, /vision_model: gpt-5\.6-luna/);
  assert.match(observation, /visual_evidence_begin[\s\S]*button is covered by a modal[\s\S]*visual_evidence_end/);
  assert.equal(continuation.tools.some((tool) => tool.name === "harness_vision_inspect"), false);
  const trace = instance.services.metrics.recent.find((item) => item.kind === "responses");
  assert.equal(trace.harnessToolRounds, 1);
});

test("models endpoint serves the local Codex catalog", async (t) => {
  const instance = await startApp();
  t.after(instance.stop);
  const response = await fetch(`${instance.base}/v1/models`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.models[0].slug, "deepseek-v4-flash");
  assert.equal(body.models[0].supports_parallel_tool_calls, false);
  assert.deepEqual(body.models[0].supported_reasoning_levels.map((level) => level.effort), ["low", "high", "max"]);
  assert.match(body.models[0].base_instructions, /coding agent/);
});

test("codexModelCatalog matches Codex schema requirements", () => {
  const catalog = codexModelCatalog({ mainModel: "deepseek-v4-flash" });
  const model = catalog.models[0];
  assert.equal(model.slug, "deepseek-v4-flash");
  assert.equal(model.supports_reasoning_summaries, true);
  assert.equal(model.model_messages.instructions_variables.personality_pragmatic, "");
  assert.equal(model.apply_patch_tool_type, "freeform");
  assert.equal(model.web_search_tool_type, "text");
  assert.equal(model.multi_agent_version, "v2");
});

test("api/status returns expected shape", async (t) => {
  const instance = await startApp();
  t.after(instance.stop);
  const response = await fetch(`${instance.base}/api/status`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ready, true);
  assert.equal(body.config.mainModel, "deepseek-v4-flash");
  assert.equal(body.config.tokenConfigured, true);
  assert.ok(body.responses);
  assert.ok(body.web);
  assert.ok(body.vision);
  assert.ok(Array.isArray(body.recent));
  assert.ok(body.media);
});

test("config API defaults off and performs reversible user-triggered switching", async (t) => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "modeldock-server-switch-"));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const configPath = path.join(codexHome, "config.toml");
  const original = 'model = "gpt-5.6-sol"\n\n[features]\nmulti_agent = true\n';
  await writeFile(configPath, original, "utf8");
  const instance = await startApp({ codexHome });
  t.after(instance.stop);

  assert.equal((await (await fetch(`${instance.base}/api/config`)).json()).enabled, false);
  const blocked = await fetch(`${instance.base}/api/config/enable`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://not-local.example" },
    body: "{}",
  });
  assert.equal(blocked.status, 403);

  const enabled = await fetch(`${instance.base}/api/config/enable`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).restartRequired, true);
  assert.match(await readFile(configPath, "utf8"), /model_provider = "modeldock_go"/);

  const disabled = await fetch(`${instance.base}/api/config/disable`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(disabled.status, 200);
  assert.equal(await readFile(configPath, "utf8"), original);
});

test("api/events streams an initial snapshot", async (t) => {
  const instance = await startApp();
  t.after(instance.stop);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${instance.base}/api/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const { value } = await response.body.getReader().read();
  assert.match(new TextDecoder().decode(value), /^data: \{/);
});

test("unknown routes return 404 json", async (t) => {
  const instance = await startApp();
  t.after(instance.stop);
  const response = await fetch(`${instance.base}/nope`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.message, "Not found");
});

test("GET / serves the dashboard", async (t) => {
  const instance = await startApp();
  t.after(instance.stop);
  const response = await fetch(`${instance.base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(await response.text(), /ModelDock/);
});
