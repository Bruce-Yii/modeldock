import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { fileURLToPath } from "node:url";

const STANDALONE = fileURLToPath(new URL("./mcp-standalone.mjs", import.meta.url));

function startMockGateway() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const message = JSON.parse(body);
      calls.push(message);
      let result = {};
      if (message.method === "tools/call") {
        result.content = [
          { type: "text", text: JSON.stringify({ forwarded: message.params.name, args: message.params.arguments }) },
        ];
      } else if (message.method === "tools/list") {
        result.tools = [];
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, result })}\n\n`);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function startBridge(gatewayUrl) {
  const child = spawn(process.execPath, [STANDALONE], {
    env: { ...process.env, MODELDOCK_GATEWAY_URL: gatewayUrl },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return { child, stderr: () => stderr };
}

function rpc(bridge, id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method} response`)), 8_000);
    const onData = (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.id === id) {
          clearTimeout(timer);
          bridge.child.stdout.off("data", onData);
          resolve(parsed);
          return;
        }
      }
    };
    bridge.child.stdout.on("data", onData);
    bridge.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(bridge, method, params) {
  bridge.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

async function stopBridge(bridge) {
  if (bridge.child.exitCode !== null) return;
  bridge.child.stdin.end();
  await Promise.race([once(bridge.child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (bridge.child.exitCode === null) bridge.child.kill();
}

test("stdio bridge lists the four tools locally without a gateway round trip", async () => {
  const gateway = await startMockGateway();
  const bridge = startBridge(gateway.url);
  try {
    const init = await rpc(bridge, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    assert.equal(init.result.serverInfo.name, "modeldock-opencode-go");
    notify(bridge, "notifications/initialized", {});
    const listed = await rpc(bridge, 2, "tools/list", {});
    const names = listed.result.tools.map((tool) => tool.name);
    assert.deepEqual(names.sort(), ["hear", "speak", "vision_inspect", "web_search_exa"]);
    assert.equal(gateway.calls.some((m) => m.method === "tools/list"), false, "tools/list is served locally");
  } finally {
    await stopBridge(bridge);
    await gateway.close();
  }
});

test("stdio bridge forwards web_search_exa calls to the gateway", async () => {
  const gateway = await startMockGateway();
  const bridge = startBridge(gateway.url);
  try {
    await rpc(bridge, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    notify(bridge, "notifications/initialized", {});
    const called = await rpc(bridge, 2, "tools/call", {
      name: "web_search_exa",
      arguments: { query: "hello", numResults: 3 },
    });
    const text = called.result.content[0].text;
    const parsed = JSON.parse(text);
    assert.equal(parsed.forwarded, "web_search_exa");
    assert.deepEqual(parsed.args, { query: "hello", numResults: 3 });
    const forward = gateway.calls.find((m) => m.method === "tools/call");
    assert.equal(forward.params.name, "web_search_exa");
    assert.deepEqual(forward.params.arguments, { query: "hello", numResults: 3 });
  } finally {
    await stopBridge(bridge);
    await gateway.close();
  }
});

test("stdio bridge exits when the parent closes stdin", async () => {
  const gateway = await startMockGateway();
  const bridge = startBridge(gateway.url);
  try {
    await rpc(bridge, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    bridge.child.stdin.end();
    const [code] = await Promise.race([
      once(bridge.child, "exit"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("bridge did not exit after stdin closed")), 3_000)),
    ]);
    assert.equal(code, 0);
  } finally {
    await gateway.close();
  }
});
