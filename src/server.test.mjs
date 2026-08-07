import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createApp, createServices, codexModelCatalog } from "./server.mjs";
import { OPENCODE_GO_PROFILE, DEEPSEEK_OFFICIAL_PROFILE } from "./profiles.mjs";

const TEST_PROFILE = { ...OPENCODE_GO_PROFILE };

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
  // Isolate the persisted-summaries file: tests must never read or write the real
  // ~/.modeldock/summaries.json (a run of npm test was polluting the live gate's
  // file with 260 fake ses_ entries).
  if (!config.summariesFile) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-summaries-"));
    config.summariesFile = path.join(dir, "summaries.json");
  }
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
  assert.deepEqual(initial.options.filter((model) => model.supportsVision).map((model) => model.id), ["gpt-5.6-luna@opencode-go", "grok-4.5", "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "mimo-v2.5", "mimo-v2.5-free"]);
  const changed = await fetch(`${instance.base}/api/models`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mainModel: "gpt-5.6-luna@opencode-go", visionModel: "kimi-k2.5" }) });
  assert.equal(changed.status, 200);
  assert.deepEqual((await changed.json()).selected, { mainModel: "gpt-5.6-luna@opencode-go", visionModel: "kimi-k2.5" });
  const invalid = await fetch(`${instance.base}/api/models`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visionModel: "deepseek-v4-flash" }) });
  assert.equal(invalid.status, 400);
});

test("models endpoint serves the local Codex catalog", async (t) => {
  const instance = await startApp();
  t.after(instance.stop);
  const response = await fetch(`${instance.base}/v1/models`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.models[0].slug, "deepseek-v4-flash");
  assert.equal(body.models[0].supports_parallel_tool_calls, false);
  assert.deepEqual(body.models[0].supported_reasoning_levels.map((level) => level.effort), ["low", "high", "xhigh"]);
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
  assert.match(await readFile(configPath, "utf8"), /openai_base_url = "http:\/\/127\.0\.0\.1:\d+\/c\/[^"]+\/v1"/);

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

test("image generation posts pass through to the native backend", async (t) => {
  const instance = await startApp();
  t.after(instance.stop);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("http://127.0.0.1:")) return originalFetch(url, options);
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ data: [{ b64_json: "abc" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const response = await fetch(`${instance.base}/v1/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer chatgpt-token" },
    body: JSON.stringify({ model: "gpt-image-2", prompt: "dashboard mockup" }),
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /chatgpt\.com\/backend-api\/codex\/images\/generations/);
  assert.equal(calls[0].headers.authorization, "Bearer chatgpt-token");
  assert.equal(calls[0].body.prompt, "dashboard mockup");
  assert.match(await response.text(), /b64_json/);
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

test("host guard rejects non-loopback Host headers (DNS rebinding)", async (t) => {
  const instance = await startApp({});
  t.after(instance.stop);

  // fetch() strips Host overrides, so speak raw HTTP to actually spoof the header.
  const { request } = await import("node:http");
  const port = new URL(instance.base).port;
  const spoofed = await new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/api/status", headers: { host: "evil.example.com" } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    req.end();
  });
  // createMcpExpressApp({ host }) enforces this app-wide; keep it pinned by test so a
  // framework upgrade cannot silently drop the DNS-rebinding protection.
  assert.equal(spoofed.status, 403);
  assert.match(spoofed.body, /Invalid Host/i);

  const legit = await fetch(`${instance.base}/api/status`);
  assert.equal(legit.status, 200);
});
