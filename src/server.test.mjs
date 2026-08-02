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
