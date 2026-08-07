// Direct caller for the ModelDock MCP tools.
//
// Use this when the Codex session's MCP connection is unavailable (for example
// after a gateway restart, which the Codex client never re-establishes). It
// bypasses the Codex MCP client and talks straight to the gateway's /mcp
// endpoint, so the tools work in any session.
//
//   node scripts/mcp-call.mjs tools
//   node scripts/mcp-call.mjs search <query> [numResults]
//   node scripts/mcp-call.mjs vision <path> <question> [mode]
//   node scripts/mcp-call.mjs speak <text>
//   node scripts/mcp-call.mjs hear <file>

import { callMcpTool, listMcpTools } from "../src/mcp-client.mjs";

const [command, ...rest] = process.argv.slice(2);

if (command === "tools") {
  const tools = await listMcpTools();
  console.log(JSON.stringify(tools.map((tool) => tool.name), null, 2));
} else if (command === "search") {
  const args = { query: rest[0] };
  if (rest[1]) args.numResults = Number(rest[1]);
  console.log(JSON.stringify(await callMcpTool("web_search_exa", args), null, 2));
} else if (command === "vision") {
  const args = { path: rest[0], question: rest[1] };
  if (rest[2]) args.mode = rest[2];
  console.log(JSON.stringify(await callMcpTool("vision_inspect", args), null, 2));
} else if (command === "speak") {
  console.log(await callMcpTool("speak", { text: rest[0] }));
} else if (command === "hear") {
  console.log(await callMcpTool("hear", { file: rest[0] }));
} else {
  console.error("usage: node scripts/mcp-call.mjs <tools|search|vision|speak|hear> ...");
  process.exitCode = 2;
}
