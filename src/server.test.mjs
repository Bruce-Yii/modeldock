import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createApp, createServices, codexModelCatalog } from "./server.mjs";
import { OPENCODE_GO_PROFILE, DEEPSEEK_OFFICIAL_PROFILE } from "./profiles.mjs";

const TEST_PROFILE = { ...OPENCODE_GO_PROFILE, chatCampOverride: "responses" };

function baseConfig() {
  return {
    host: "127.0.0.1",
    port: 0,
    profile: TEST_PROFILE,
    profileId: TEST_PROFILE.id,
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
    debug: { noSessionCheck: true },
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

test("debug mode is exposed and can toggle at runtime", async (t) => {
  const instance = await startApp();
  t.after(instance.stop);

  const initial = await (await fetch(`${instance.base}/api/status`)).json();
  assert.equal(initial.config.debug.enabled, false);

  const changed = await fetch(`${instance.base}/api/debug`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.deepEqual(await changed.json(), { enabled: true });

  const enabled = await (await fetch(`${instance.base}/api/status`)).json();
  assert.equal(enabled.config.debug.enabled, true);

  const disabled = await fetch(`${instance.base}/api/debug`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.deepEqual(await disabled.json(), { enabled: false });
  const final = await (await fetch(`${instance.base}/api/status`)).json();
  assert.equal(final.config.debug.enabled, false);
});

test("model API exposes selectable main and vision-capable options", async (t) => {
  const instance = await startApp();
  t.after(instance.stop);
  const initial = await (await fetch(`${instance.base}/api/models`)).json();
  assert.equal(initial.selected.mainModel, "deepseek-v4-flash");
  assert.deepEqual(initial.options.filter((model) => model.supportsVision).map((model) => model.id), ["gpt-5.6-luna", "grok-4.5", "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "mimo-v2.5", "mimo-v2.5-free", "minimax-m3", "qwen3.5-plus", "qwen3.6-plus", "qwen3.7-plus", "qwen3.8-max"]);
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
  assert.deepEqual(received.tools.map((tool) => tool.name), ["harness_web_search", "vision_inspect"]);

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
  // Chat camp keeps the most recent tool pairs native (RECENT_TOOL_PAIRS=4); both pairs
  // here are within the window, so they stay as function_call/function_call_output for
  // the chat bridge to convert into tool_calls.
  assert.deepEqual(received.input.map((item) => item.role || item.type), [
    "user", "function_call", "function_call_output", "assistant", "function_call", "function_call_output", "user",
  ]);
  const trace = instance.services.metrics.recent.find((item) => item.kind === "responses");
  assert.equal(trace.nativeToolCalls, 2);
  assert.equal(trace.nativeToolOutputs, 2);
  assert.equal(trace.compactedToolResults, 0);
  assert.equal(trace.fallbackToolResults, 0);
  assert.equal(trace.droppedAssistantMessages, 1);
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

test("streaming relay adapts a DeepSeek-style custom_tool_call item with input deltas", async (t) => {
  const upstream = createServer((req, res) => {
    res.setHeader("content-type", "text/event-stream");
    sendSse(res, "response.output_item.added", {
      output_index: 0,
      item: { id: "ds_patch", type: "custom_tool_call", call_id: "call_ds_patch", name: "apply_patch", input: "" },
    });
    sendSse(res, "response.custom_tool_call_input.delta", { output_index: 0, delta: "*** Begin Patch\n" });
    sendSse(res, "response.custom_tool_call_input.delta", { output_index: 0, delta: "*** End Patch\n" });
    sendSse(res, "response.completed", { id: "resp_ds", response: { id: "resp_ds", model: "deepseek-v4-flash", usage: { input_tokens: 12, output_tokens: 3 } } });
    res.end("data: [DONE]\n\n");
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}`, deepseekBaseUrl: `http://127.0.0.1:${port}` });
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
  const done = events.find((event) => event.type === "response.custom_tool_call_input.done");
  const completed = events.find((event) => event.type === "response.completed");
  assert.deepEqual(added.map((event) => [event.output_index, event.item.type]), [[0, "custom_tool_call"]]);
  assert.equal(added[0].item.id, "call_ds_patch");
  assert.equal(done.input, "*** Begin Patch\n*** End Patch\n");
  assert.equal(completed.response.output[0].type, "custom_tool_call");
  assert.match(JSON.stringify(completed.response.output), /Begin Patch/);
  assert.match(sse, /data: \[DONE\]/);
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

test("a visual turn routes to Luna with image references and vision tooling", async (t) => {
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
  assert.equal(received.input[0].content[1].type, "input_image", "the vision model receives the real image, not a reference");
  assert.equal(received.input[0].content[1].image_url, dataUrl);
  assert.equal(received.tools?.some((tool) => tool.name === "vision_inspect") || false, false, "Luna sees the image directly and gets no harness vision tool");
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
  // Third turn is back on DeepSeek (main model): the resident vision tool lets it re-inspect the earlier image.
  assert.equal(receivedBodies[2].tools?.some((tool) => tool.name === "vision_inspect") || false, true);
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
        name: "vision_inspect",
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
      tools: [{ type: "function", name: "vision_inspect", description: "vision", parameters: { type: "object", properties: {} } }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(mainCalls, 2);
  const observation = continuation.input.at(-1).content[0].text;
  assert.match(observation, /LOCAL VISION OBSERVATION/);
  assert.match(observation, /VISION_INSPECTION_COMPLETED/);
  assert.match(observation, /vision_model: gpt-5\.6-luna/);
  assert.match(observation, /visual_evidence_begin[\s\S]*button is covered by a modal[\s\S]*visual_evidence_end/);
  assert.equal(continuation.tools.some((tool) => tool.name === "vision_inspect"), false);
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

test("debug mode strips reasoning from the upstream request", async (t) => {
  let receivedReasoning;
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    receivedReasoning = body.reasoning;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(okResponse));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${upstreamPort}`, debug: { enabled: true, noReasoning: true, dumpDir: "" } });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "hello", stream: false, reasoning: { effort: "high" } }),
  });
  assert.equal(response.status, 200);
  assert.equal(receivedReasoning, undefined, "reasoning field must be stripped in debug noReasoning mode");
});

test("deepseek-official forwards the reasoning effort untouched", async (t) => {
  const received = [];
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    const role = req.headers["x-modeldock-role"] || null;
    received.push({ url: req.url, reasoning: body.reasoning, role });
    if (role === "coordinator") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "resp_check", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"completed": true}' }] }], usage: {} }));
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    sendSse(res, "response.output_text.delta", { id: "resp_ds", delta: "REASONING_OK", response: { id: "resp_ds", model: "deepseek-v4-flash" } });
    sendSse(res, "response.completed", { id: "resp_ds", response: { id: "resp_ds", model: "deepseek-v4-flash", usage: { input_tokens: 1, output_tokens: 1 } } });
    res.end("data: [DONE]\n\n");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({
    profile: DEEPSEEK_OFFICIAL_PROFILE,
    profileId: "deepseek-official",
    goBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    deepseekBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    mainModel: "deepseek-v4-flash",
    visionModel: "mimo-v2.5",
    visionFallbackModel: "mimo-v2.5",
    tokens: { "opencode-go": "opencode-token", "deepseek-official": "deepseek-token" },
  });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "hello", stream: true, reasoning: { effort: "high" } }),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(received[0].reasoning?.effort, "high", "deepseek-official must forward the reasoning effort to the Responses API");
});

test("deepseek-official refills reasoning.content from the echoed summary", async (t) => {
  let received;
  const upstream = createServer(async (req, res) => {
    received = await jsonBody(req);
    res.setHeader("content-type", "text/event-stream");
    sendSse(res, "response.output_text.delta", { id: "resp_ds", delta: "OK", response: { id: "resp_ds", model: "deepseek-v4-flash" } });
    sendSse(res, "response.completed", { id: "resp_ds", response: { id: "resp_ds", model: "deepseek-v4-flash", usage: { input_tokens: 1, output_tokens: 1 } } });
    res.end("data: [DONE]\n\n");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({
    profile: DEEPSEEK_OFFICIAL_PROFILE,
    profileId: "deepseek-official",
    goBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    deepseekBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    mainModel: "deepseek-v4-flash",
    tokens: { "opencode-go": "opencode-token", "deepseek-official": "deepseek-token" },
  });
  t.after(instance.stop);

  // Exactly the shape Codex re-posts: our summary survives, `content` comes back null.
  // DeepSeek 400s on that ("reasoning_text ... must be passed back"), verified live.
  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stream: true,
      input: [
        { role: "user", content: [{ type: "input_text", text: "go on" }] },
        { type: "reasoning", id: "rs_abc123", summary: [{ type: "summary_text", text: "I need to check the version." }], content: null, encrypted_content: null },
        { type: "function_call", id: "fc_1", call_id: "call_00_real", name: "shell_command", arguments: "{}" },
        { type: "function_call_output", call_id: "call_00_real", output: "v22\nExit code: 0" },
      ],
    }),
  });
  assert.equal(response.status, 200);
  await response.text();
  const reasoning = received.input.find((item) => item.type === "reasoning");
  assert.deepEqual(reasoning.content, [{ type: "reasoning_text", text: "I need to check the version." }], "content must be refilled from the summary");
  assert.equal(reasoning.summary, undefined, "the summary must be moved, not copied — sending both bills the text twice");
  assert.equal(reasoning.encrypted_content, undefined, "the empty encrypted_content placeholder is dropped too");
});

test("debug dump writes the transformed upstream payload to disk", async (t) => {
  const dumpDir = await mkdtemp(path.join(os.tmpdir(), "modeldock-dump-"));
  t.after(() => rm(dumpDir, { recursive: true, force: true }));
  const upstream = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(okResponse));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${upstreamPort}`, debug: { enabled: true, noReasoning: false, dumpDir } });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "dump me", stream: false, model: "deepseek-v4-flash" }),
  });
  assert.equal(response.status, 200);
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(dumpDir);
  assert.equal(files.length, 1, "one dump file written");
  const dumped = JSON.parse(await readFile(path.join(dumpDir, files[0]), "utf8"));
  assert.equal(dumped.model, "deepseek-v4-flash");
});

test("api/status exposes debug flags without dump path leaks", async (t) => {
  const instance = await startApp({ debug: { enabled: true, noReasoning: true, dumpDir: "" } });
  t.after(instance.stop);
  const response = await fetch(`${instance.base}/api/status`);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.config.debug.enabled, true);
  assert.equal(status.config.debug.noReasoning, true);
  assert.equal(status.config.debug.dumpDir, "");
});

test("web search harness works alongside disclosure filtering", async (t) => {
  let mainCalls = 0;
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    if (req.url === "/mcp") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "Evidence https://example.test/source" }] } }));
      return;
    }
    if (req.headers["x-modeldock-role"] === "coordinator") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "c1", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"completed": true}' }] }], usage: {} }));
      return;
    }
    mainCalls += 1;
    const toolNames = (body.tools || []).map((tool) => tool.name);
    res.setHeader("content-type", "text/event-stream");
    if (mainCalls === 1) {
      assert.ok(toolNames.includes("harness_web_search"), `harness_web_search must be present, got ${JSON.stringify(toolNames)}`);
      assert.ok(toolNames.includes("vision_inspect"), `vision tool is resident on the main-model path, got ${JSON.stringify(toolNames)}`);
      sendSse(res, "response.output_item.added", { output_index: 0, item: { id: "fc_w", type: "function_call", name: "harness_web_search", call_id: "call_w", arguments: "" } });
      sendSse(res, "response.function_call_arguments.delta", { output_index: 0, delta: '{"queries":["modeldock"]}' });
    } else {
      sendSse(res, "response.output_text.delta", { id: "r2", delta: "FINAL ANSWER", response: { id: "r2", model: body.model } });
    }
    sendSse(res, "response.completed", { id: `r${mainCalls}`, response: { id: `r${mainCalls}`, usage: { input_tokens: 5, output_tokens: 2 } } });
    res.end("data: [DONE]\n\n");
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}`, exaMcpUrl: `http://127.0.0.1:${port}/mcp`, profile: TEST_PROFILE });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: "search the web",
      stream: true,
      tools: [
        { type: "function", name: "shell_command", parameters: { type: "object", properties: {} } },
        { type: "tool_search" },
        { type: "web_search" },
      ],
    }),
  });
  const sse = await response.text();
  assert.equal(response.status, 200);
  assert.equal(mainCalls, 2, "web harness round then final text");
  assert.match(sse, /FINAL ANSWER/);
  assert.doesNotMatch(sse, /harness_web_search/, "harness round must be hidden from Codex");
});

test("image requests route to the vision model and keep the image in the forwarded input", async (t) => {
  let upstreamModel;
  let receivedInput;
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    if (req.headers["x-modeldock-role"] === "coordinator") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "c1", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"completed": true}' }] }], usage: {} }));
      return;
    }
    upstreamModel = body.model;
    receivedInput = body.input;
    res.setHeader("content-type", "text/event-stream");
    sendSse(res, "response.output_text.delta", { id: "rv", delta: "I see a chart in the image.", response: { id: "rv", model: body.model } });
    sendSse(res, "response.completed", { id: "rv", response: { id: "rv", usage: { input_tokens: 5, output_tokens: 2 } } });
    res.end("data: [DONE]\n\n");
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);

  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [{ role: "user", content: [{ type: "input_text", text: "What is in this image?" }, { type: "input_image", image_url: image }] }],
      stream: true,
      tools: [{ type: "function", name: "shell_command", parameters: { type: "object", properties: {} } }],
    }),
  });
  const sse = await response.text();
  assert.equal(response.status, 200);
  assert.equal(upstreamModel, "gpt-5.6-luna", "image routes to the vision model");
  assert.match(sse, /I see a chart/);
  const forwardedText = JSON.stringify(receivedInput);
  assert.equal(forwardedText.includes("input_image"), true, "the real image is forwarded to the vision model on the direct route");
  assert.ok(forwardedText.includes(image), "the vision model receives the actual base64 image, not a reference");
});

test("main model on DeepSeek with vision + harness on OpenCode Go: per-provider endpoint and token routing", async (t) => {
  const calls = [];
  let actualRef = "";
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    const auth = req.headers.authorization || "";
    const camp = auth.includes("deepseek-token") ? "deepseek" : auth.includes("opencode-token") ? "opencode" : "unknown";
    calls.push({ camp, model: body.model, url: req.url, auth, tools: (body.tools || []).map((tool) => tool.name || `:${tool.type}`), input: body.input });
    res.setHeader("content-type", "application/json");
    const deepseekCount = calls.filter((c) => c.camp === "deepseek").length;
    if (camp === "deepseek" && deepseekCount === 1) {
      res.end(JSON.stringify({ id: "resp_ds1", output: [{ type: "function_call", name: "vision_inspect", call_id: "call_v", arguments: JSON.stringify({ image_ref: actualRef, question: "What does the chart show?" }) }], usage: {} }));
      return;
    }
    if (camp === "opencode") {
      res.end(JSON.stringify({ id: "resp_oc", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "The chart shows revenue rising." }] }], usage: {} }));
      return;
    }
    res.end(JSON.stringify({ id: "resp_ds2", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "DONE_ON_DEEPSEEK" }] }], usage: { input_tokens: 10, output_tokens: 4 } }));
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({
    profile: DEEPSEEK_OFFICIAL_PROFILE,
    profileId: "deepseek-official",
    goBaseUrl: `http://127.0.0.1:${port}/go`,
    deepseekBaseUrl: `http://127.0.0.1:${port}`,
    mainModel: "deepseek-v4-flash",
    visionModel: "mimo-v2.5",
    visionFallbackModel: "mimo-v2.5",
    tokens: { "opencode-go": "opencode-token", "deepseek-official": "deepseek-token" },
  });
  t.after(instance.stop);
  actualRef = instance.services.mediaStore.put("data:image/png;base64,iVBORw0KGgo=");

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [{ role: "user", content: [{ type: "input_text", text: "Look at the chart image and tell me what it shows." }] }],
      tools: [
        { type: "function", name: "shell_command", parameters: { type: "object", properties: {} } },
        { type: "tool_search" },
        { type: "web_search" },
      ],
      stream: false,
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.match(JSON.stringify(body), /DONE_ON_DEEPSEEK/);

  const deepseekCalls = calls.filter((c) => c.camp === "deepseek");
  const opencodeCalls = calls.filter((c) => c.camp === "opencode");
  assert.equal(deepseekCalls.length, 2, "two DeepSeek turns: harness call then final");
  assert.equal(opencodeCalls.length, 1, "one OpenCode vision observation");
  assert.equal(deepseekCalls[0].model, "deepseek-v4-flash");
  assert.equal(opencodeCalls[0].model, "mimo-v2.5");
  assert.match(deepseekCalls[0].auth, /Bearer deepseek-token/, "main-model requests carry the DeepSeek token");
  assert.match(opencodeCalls[0].auth, /Bearer opencode-token/, "vision requests carry the OpenCode Go token");
  assert.match(deepseekCalls[0].url, /\/responses$/, "DeepSeek camp uses the responses wire style");
  assert.match(opencodeCalls[0].url, /\/go\/responses$/, "vision model routes to its own provider base");
  assert.ok(deepseekCalls[0].tools.includes("vision_inspect"), "harness vision tool is resident on the DeepSeek main-model path");
  assert.ok(deepseekCalls[0].tools.includes(":tool_search"), "hosted tool_search is forwarded (DeepSeek ignores it silently)");
  assert.ok(deepseekCalls[0].tools.includes(":web_search"), "hosted web_search is forwarded (DeepSeek supports it natively)");
  assert.equal(deepseekCalls[0].tools.includes("harness_web_search"), false, "no Exa harness search is injected when hosted schemas pass through");
  assert.ok(deepseekCalls[0].tools.includes("shell_command"), "function-type Codex local tools are forwarded to DeepSeek");
  assert.match(JSON.stringify(deepseekCalls[1].input ?? ""), /VISION_INSPECTION_COMPLETED/, "the Luna observation is fed back into the DeepSeek turn");
});

test("anti-breakpoint revival splices summary + last text + tools, no side API call", async (t) => {
  let mainCalls = 0;
  let upstreamRequests = 0;
  let secondMainInput = null;
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    // No checker side-call may ever reach the upstream: the revival is local.
    if (body.stream === false) throw new Error("checker must not make an API call");
    upstreamRequests += 1;
    mainCalls += 1;
    if (mainCalls > 1) secondMainInput = body.input;
    res.setHeader("content-type", "text/event-stream");
    sendSse(res, "response.output_text.delta", { id: "resp_check", delta: "wheels done", response: { id: "resp_check", model: body.model } });
    sendSse(res, "response.completed", { id: "resp_check", response: { id: "resp_check", model: body.model, usage: { input_tokens: 9, output_tokens: 4 } } });
    res.end("data: [DONE]\n\n");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const instance = await startApp({
    goBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    debug: { noSessionCheck: false },
  });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stream: true,
      input: [
        { role: "user", content: [{ type: "input_text", text: "Assemble the car" }] },
      ],
      tools: [{ type: "function", name: "shell_command", parameters: { type: "object", properties: {} } }],
    }),
  });
  const sse = await response.text();
  assert.equal(response.status, 200);
  assert.equal(mainCalls, 2, "the plain-text end was revived into a second upstream round");
  assert.equal(upstreamRequests, 2, "no side checker API call, only the two main rounds");
  const revivalText = JSON.stringify(secondMainInput ?? "");
  assert.match(revivalText, /session continuation/);
  assert.match(revivalText, /YOUR LAST TEXT/);
  assert.match(revivalText, /wheels done/, "this turn's own text is echoed back");
  assert.match(revivalText, /AVAILABLE TOOLS/);
  assert.match(revivalText, /shell_command/, "tool names are listed");
  assert.match(sse, /wheels done/);
  const check = instance.services.sessionChecks?.get("default");
  assert.equal(check?.state, "continue");
});

test("revival also fires on question-ending text (no verdict logic, upstream decides)", async (t) => {
  let mainCalls = 0;
  let upstreamRequests = 0;
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    if (body.stream === false) throw new Error("checker must not make an API call");
    upstreamRequests += 1;
    mainCalls += 1;
    res.setHeader("content-type", "text/event-stream");
    sendSse(res, "response.output_text.delta", { id: "resp_ask", delta: "Which color do you want?", response: { id: "resp_ask", model: body.model } });
    sendSse(res, "response.completed", { id: "resp_ask", response: { id: "resp_ask", model: body.model, usage: { input_tokens: 5, output_tokens: 3 } } });
    res.end("data: [DONE]\n\n");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const instance = await startApp({
    goBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    debug: { noSessionCheck: false },
  });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "Paint the car" }] }],
    }),
  });
  await response.text();
  assert.equal(response.status, 200);
  assert.equal(mainCalls, 2, "question-ending text is revived once; the upstream decides whether to continue");
  assert.equal(upstreamRequests, 2, "no side API call, just the revival round");
  assert.equal(instance.services.sessionChecks?.get("default")?.state, "continue");
});

test("revival is rate-limited to once per session per 30s", async (t) => {
  let mainCalls = 0;
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    if (body.stream === false) throw new Error("checker must not make an API call");
    mainCalls += 1;
    res.setHeader("content-type", "text/event-stream");
    sendSse(res, "response.output_text.delta", { id: "resp_rl", delta: "still going", response: { id: "resp_rl", model: body.model } });
    sendSse(res, "response.completed", { id: "resp_rl", response: { id: "resp_rl", model: body.model, usage: { input_tokens: 5, output_tokens: 2 } } });
    res.end("data: [DONE]\n\n");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const instance = await startApp({
    goBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    debug: { noSessionCheck: false },
  });
  t.after(instance.stop);

  // First request revives; the second plain-text round hits the 30s window and ends.
  const run = (i) => fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: `round ${i}` }] }],
    }),
  }).then((r) => r.text());
  await run(1);
  assert.equal(mainCalls, 2, "first request revives once");
  const state = instance.services.sessionChecks?.get("default");
  assert.ok(state && Date.now() - state.at < 30_000, "check window is fresh");
  await run(2);
  assert.equal(mainCalls, 3, "second request's text turn is inside the 30s window, no second revival");
});
