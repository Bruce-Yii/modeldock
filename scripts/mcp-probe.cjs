// Asserts the installed stdio bridge exposes the ModelDock tool set over a real
// tools/list round trip. Used by verify-release-install.ps1; kept as a file so
// the release verifier never has to write an inline script to a temp dir.
"use strict";

const { spawn } = require("node:child_process");

const bridge = process.argv[2];
const gatewayUrl = process.argv[3];
const expected = ["web_search_exa", "vision_inspect", "speak", "hear", "recall_memory", "store_memory"];

const child = spawn(process.execPath, [bridge], {
  env: { ...process.env, MODELDOCK_GATEWAY_URL: gatewayUrl },
  stdio: ["pipe", "pipe", "pipe"],
});
let out = "";
let err = "";
child.stdout.on("data", (d) => { out += d.toString(); });
child.stderr.on("data", (d) => { err += d.toString(); });
child.on("close", (code) => {
  const names = out
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line).result?.tools?.map((t) => t.name);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .flat();
  const missing = expected.filter((name) => !names.includes(name));
  if (missing.length) {
    console.log(`MCP_TOOLS_FAIL missing=${missing.join(",")} got=${names.join(",")} stderr=${err}`);
    process.exit(1);
  }
  console.log(`MCP_TOOLS_OK ${names.join(",")}`);
  process.exit(0);
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n");
child.stdin.end();
setTimeout(() => {
  console.log(`MCP_TOOLS_TIMEOUT stderr=${err}`);
  process.exit(1);
}, 15000);
