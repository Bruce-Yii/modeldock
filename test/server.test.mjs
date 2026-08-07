import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
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
  const catalog = codexModelCatalog({
    mainModel: "deepseek-v4-flash",
    // Keep the schema check hermetic: without a configured native catalog file
    // the merge would read the real ~/.modeldock capture on a dev machine and
    // the provider-grouped order would put a native GPT model first.
    nativeCatalogFile: path.join(os.tmpdir(), "modeldock-test-native-missing.json"),
  });
  assert.equal(catalog.models[0].slug, "deepseek-v4-flash");
  assert.equal(catalog.models[0].supports_reasoning_summaries, true);
  assert.match(catalog.models[0].base_instructions, /coding agent/);
  assert.equal(catalog.models[0].model_messages.instructions_variables.personality_pragmatic, "");
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
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ["hear", "speak", "vision_inspect", "web_search_exa"]);
});
