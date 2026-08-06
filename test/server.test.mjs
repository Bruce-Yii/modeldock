import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { codexModelCatalog, createApp, createServices } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  return server.address().port;
}

test("publishes a complete Codex model catalog schema", () => {
  const catalog = codexModelCatalog({ mainModel: "deepseek-v4-flash" });
  assert.equal(catalog.models[0].slug, "deepseek-v4-flash");
  assert.equal(catalog.models[0].supports_reasoning_summaries, true);
  assert.match(catalog.models[0].base_instructions, /coding agent/);
  assert.equal(catalog.models[0].model_messages.instructions_variables.personality_pragmatic, "");
});

test("proxies Responses while filtering unsupported hosted tool schemas", async (t) => {
  let received;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (received.stream) {
      res.setHeader("content-type", "text/event-stream");
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", id: "resp_stream", delta: "stream", response: { id: "resp_stream", model: received.model } })}\n\n`);
      res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", id: "resp_stream", response: { id: "resp_stream", model: received.model, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "resp_test", status: "completed", output: [], usage: { input_tokens: 5, output_tokens: 2 } }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const base = loadConfig();
  const config = {
    ...base,
    goToken: "test-token",
    goBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    opencodeBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    profile: { ...base.profile, chatCampOverride: "responses" },
    debug: { ...base.debug, noSessionCheck: true },
  };
  const instance = createApp(createServices(config));
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await instance.close();
    server.close();
  });

  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: "hello",
      tool_choice: "required",
      tools: [{ type: "tool_search" }, { type: "web_search" }, { type: "function", name: "shell_command", parameters: { type: "object" } }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(received.model, "deepseek-v4-flash");
  assert.equal(received.tool_choice, "auto");
  // tool_search is bridged to a function tool (client-side MCP elicitation); web_search is
  // blocked and replaced by the harness; the node_repl tools are guaranteed.
  assert.deepEqual(received.tools.map((tool) => tool.name), ["tool_search", "shell_command", "mcp__node_repl__js", "mcp__node_repl__js_add_node_module_dir", "mcp__node_repl__js_reset", "harness_web_search", "vision_inspect", "speak", "hear"]);

  const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
  assert.equal(status.responses.filteredToolSearch, 0);
  assert.equal(status.responses.filteredWebSearch, 1);
  assert.equal(status.responses.inputTokens, 5);
  assert.equal(status.responses.outputTokens, 2);

  const streamed = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ input: "stream", stream: true }),
  });
  const sse = await streamed.text();
  assert.match(streamed.headers.get("content-type"), /text\/event-stream/);
  assert.equal(streamed.headers.get("x-modeldock-stream-mode"), "live-normalized");
  assert.equal(received.stream, true, "streaming is the default upstream mode");
  assert.match(sse, /event: response\.created/);
  assert.match(sse, /event: response\.completed/);
});

test("serves both local MCP tools over Streamable HTTP", async (t) => {
  const config = { ...loadConfig(), goToken: "test-token" };
  const instance = createApp(createServices(config));
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await instance.close();
    server.close();
  });

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  t.after(() => client.close());
  const result = await client.listTools();
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ["vision_inspect", "web_search_exa"]);
});
