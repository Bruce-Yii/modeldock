import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { createApp, createServices } from "./server.mjs";
import { OPENCODE_GO_PROFILE } from "./profiles.mjs";

const TEST_PROFILE = { ...OPENCODE_GO_PROFILE };

function baseConfig() {
  return {
    host: "127.0.0.1",
    port: 0,
    profile: TEST_PROFILE,
    profileId: TEST_PROFILE.id,
    goBaseUrl: "https://go.example.com/v1",
    opencodeBaseUrl: "https://go.example.com/v1",
    deepseekBaseUrl: "https://ds.example.com",
    goToken: "go-token",
    tokens: { "opencode-go": "go-token", "deepseek-official": "ds-token" },
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
    callerKey: "test-caller-key-0123456789abcdefghij",
  };
}

async function startApp(configOverrides = {}) {
  const config = { ...baseConfig(), ...configOverrides };
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-gateway-test-"));
  config.summariesFile = path.join(dir, "summaries.json");
  const services = createServices(config);
  const { app } = createApp(services);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    server,
    services,
    stop: async () => {
      await services.mediaStore.cleanup();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function jsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  return server.address().port;
}

function sseResponse(events) {
  const body = events.map(({ type, data }) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

test("gateway: image turns escalate to the vision model and tool continuations stay pinned", async (t) => {
  const seen = [];
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    seen.push({ model: body.model, input: body.input, auth: req.headers.authorization });
    if (body.input.some((item) => item.type === "function_call_output")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "resp_final",
        output: [{ id: "msg_final", type: "message", role: "assistant", content: [{ type: "output_text", text: "DONE" }] }],
        usage: { input_tokens: 3, output_tokens: 1 },
      }));
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    res.write('event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-5.6-luna","output":[{"type":"function_call","call_id":"call_00_viz","name":"shell_command","arguments":"{}"}],"usage":{"input_tokens":10,"output_tokens":5}}}\n\n');
    res.end();
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}`, opencodeBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);

  const imageTurn = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/p.png" }] }],
    }),
  });
  assert.equal(imageTurn.status, 200);
  await imageTurn.text();
  assert.equal(seen[0].model, "gpt-5.6-luna", "image turn is escalated to the vision model");
  assert.equal(seen[0].input[0].content[0].type, "input_image", "image bytes are forwarded untouched");

  const continuation = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      input: [{ type: "function_call_output", call_id: "call_00_viz", output: "{}" }],
    }),
  });
  assert.equal(continuation.status, 200);
  await continuation.text();
  assert.equal(seen[1].model, "gpt-5.6-luna", "tool continuation stays on the vision model");

  const textTurn = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }),
  });
  assert.equal(textTurn.status, 200);
  await textTurn.text();
  assert.equal(seen[2].model, "deepseek-v4-flash", "a fresh text turn returns to the main model");
});

test("gateway: deepseek-official models route to the DeepSeek upstream with its token", async (t) => {
  const seen = [];
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    seen.push({ url: `${req.headers.host}${req.url}`, model: body.model, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "resp_ds",
      output: [{ id: "msg", type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ deepseekBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash@deepseek-official",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, "deepseek-v4-flash", "owner suffix is stripped before the upstream");
  assert.equal(seen[0].auth, "Bearer ds-token");
  assert.match(seen[0].url, /127\.0\.0\.1:\d+\/responses/);
});

test("gateway: SSE bytes pass through verbatim and usage reaches the meter", async (t) => {
  const upstream = createServer((_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hel"}\n\n');
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo"}\n\n');
    res.write('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":22,"output_tokens":7}}}\n\n');
    res.end();
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}`, opencodeBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }),
  });
  const body = await response.text();
  assert.match(body, /response\.output_text\.delta/);
  assert.match(body, /"delta":"hel"/);
  assert.match(body, /"delta":"lo"/);
  const snap = instance.services.metrics.snapshot();
  assert.equal(snap.responses.inputTokens, 22);
  assert.equal(snap.responses.outputTokens, 7);
});

test("gateway: hosted tool schemas are stripped before reaching the upstream", async (t) => {
  let received;
  const upstream = createServer(async (req, res) => {
    received = await jsonBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "resp_t",
      output: [{ id: "msg", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: {},
    }));
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}`, opencodeBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);

  await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [
        { type: "web_search", name: "web_search" },
        { type: "function", name: "shell_command", parameters: {} },
      ],
    }),
  });
  const names = (received.tools || []).map((tool) => tool.name);
  assert.deepEqual(names, ["shell_command"]);
});

test("gateway: historical images are replaced with refs, current images stay for the vision model", async (t) => {
  const seen = [];
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    seen.push({ model: body.model, input: body.input });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: `resp_${seen.length}`,
      output: [{ id: "msg", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: {},
    }));
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}`, opencodeBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);

  // Turn 1: image in the current turn -> escalated to the vision model, image bytes kept.
  const imageUrl = "data:image/png;base64,AAAA";
  await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: imageUrl }] }],
    }),
  });
  assert.equal(seen[0].model, "gpt-5.6-luna");
  assert.equal(seen[0].input[0].content[0].type, "input_image", "current-turn image reaches the vision model");

  // Turn 2: the same image now lives in history plus a text question.
  // The main model must not receive the image bytes again.
  await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      input: [
        { type: "message", role: "user", content: [{ type: "input_image", image_url: imageUrl }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "The image shows a chart." }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "What was the y-axis?" }] },
      ],
    }),
  });
  assert.equal(seen[1].model, "deepseek-v4-flash", "text-only follow-up returns to the main model");
  const historyPart = seen[1].input[0].content[0];
  assert.equal(historyPart.type, "input_text", "historical image is not re-sent as bytes");
  assert.match(historyPart.text, /\[Image attachment img_[a-f0-9]+/);
  assert.equal(seen[1].input[2].content[0].type, "input_text");
  const hasImageAnywhere = seen[1].input.some((item) => item.content?.some((part) => part.type === "input_image"));
  assert.equal(hasImageAnywhere, false, "the main model request carries no input_image at all");
});

test("caller-key routes: correct key relays, wrong key and enforced bare path 401", async (t) => {
  const upstream = createServer((req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\ndata: [DONE]\n\n');
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}`, opencodeBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);
  const body = JSON.stringify({ model: "deepseek-v4-flash", stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] });
  const headers = { "content-type": "application/json" };

  const keyed = await fetch(`${instance.base}/c/test-caller-key-0123456789abcdefghij/v1/responses`, { method: "POST", headers, body });
  assert.equal(keyed.status, 200, "the keyed path relays");
  await keyed.text();

  const wrong = await fetch(`${instance.base}/c/wrong-key-00000000000000000000000/v1/responses`, { method: "POST", headers, body });
  assert.equal(wrong.status, 401, "a wrong key is rejected");

  const models = await fetch(`${instance.base}/c/test-caller-key-0123456789abcdefghij/v1/models`);
  assert.equal(models.status, 200, "the keyed models path serves the catalog");

  process.env.MODELDOCK_REQUIRE_CALLER_KEY = "1";
  t.after(() => { delete process.env.MODELDOCK_REQUIRE_CALLER_KEY; });
  const bare = await fetch(`${instance.base}/v1/responses`, { method: "POST", headers, body });
  assert.equal(bare.status, 401, "bare path is refused once enforcement is on");
});
