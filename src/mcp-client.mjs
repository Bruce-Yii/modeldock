// Minimal MCP client for the ModelDock gateway's own /mcp endpoint.
//
// The gateway serves MCP over streamable HTTP in the stateless legacy mode
// (see src/mcp.mjs), so every request stands alone and no session bookkeeping
// is needed. This module is shared by the stdio bridge (src/mcp-standalone.mjs)
// and the direct CLI (scripts/mcp-call.mjs).

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:4097";

export function gatewayBaseUrl() {
  return process.env.MODELDOCK_GATEWAY_URL || DEFAULT_GATEWAY_URL;
}

export async function requestMcp(baseUrl, method, params) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  let message = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      message = JSON.parse(line.slice(5).trim());
      break;
    } catch {
      // Try the next data line.
    }
  }
  if (!message) {
    throw new Error(`MCP ${method} failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  if (message.error) {
    throw new Error(message.error.message || JSON.stringify(message.error));
  }
  return message.result;
}

export async function listMcpTools(baseUrl = gatewayBaseUrl()) {
  const result = await requestMcp(baseUrl, "tools/list", {});
  return result.tools || [];
}

// Returns the tool result text; when that text is itself JSON the parsed value
// is returned so callers can work with the object directly.
export async function callMcpTool(name, args, baseUrl = gatewayBaseUrl()) {
  const result = await requestMcp(baseUrl, "tools/call", { name, arguments: args });
  const text = (result.content || []).find((item) => item.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
