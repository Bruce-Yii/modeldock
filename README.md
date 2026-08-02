# ModelDock OpenCode Go Gate

A deliberately narrow local bridge that lets the Codex harness use OpenCode Go without sending the two hosted-tool schemas that the Go Responses façade rejects.

It provides three surfaces from one loopback-only Node process:

- `POST /v1/responses` — filters incompatible hosted tools, rewrites image attachments to opaque references, forwards requests to OpenCode Go, and meters usage.
- `POST /mcp` — optional diagnostic/reuse surface exposing `web_search_exa` and `vision_inspect` over Streamable HTTP MCP.
- `GET /` — a small operational dashboard for request, token, byte, schema-filter, search, vision, and fallback metrics.

## Runtime flow

```text
Codex ──Responses──> local gate ──Responses──> OpenCode Go / deepseek-v4-flash
                          │  internal standard-function loop
                          ├──> Exa hosted MCP
                          └──> OpenCode Go / gpt-5.6-luna
                                                └─ fallback: kimi-k2.5
```

The service does not implement a search engine, a Chat Completions converter, provider management, or a general replacement for Codex `tool_search`.

## Requirements

- Node.js 22 or newer.
- An OpenCode Go bearer token.
- Codex configured to use the custom local Responses provider.

## Start

```powershell
npm install
Copy-Item .env.example .env
```

Set `OPENCODE_GO_TOKEN` in `.env`, then:

```powershell
npm start
```

Open [http://127.0.0.1:4097](http://127.0.0.1:4097). The server intentionally refuses non-loopback bind addresses.

The **Use OpenCode Go in Codex** switch is off by default. When enabled from the dashboard, ModelDock:

1. makes a timestamped, byte-for-byte backup beside the user-level `~/.codex/config.toml`;
2. changes only the top-level model/provider/web defaults and adds `[model_providers.modeldock_go]`;
3. preserves other Codex settings such as plugins, MCP servers, projects, sandbox settings, and features;
4. displays a persistent **Restart required** notice.

Disable the switch to restore the exact backup, then restart Codex again. If the managed config was edited outside ModelDock, automatic restore is locked rather than overwriting those edits. Switch state is stored under `~/.codex/modeldock/`; neither config contents nor tokens are returned to the browser.

[`config/codex.example.toml`](config/codex.example.toml) remains available as a manual fallback. Its token is a harmless local placeholder; the service uses only `OPENCODE_GO_TOKEN` for upstream Authorization.

## What the gate changes

For each Responses request, the gate:

1. normalizes string `input` to a Responses message array;
2. replaces rejected `tool_search`/`web_search` capability with standard `harness_web_search`;
3. changes `tool_choice = "required"` to `"auto"` because Go thinking mode rejects `required`;
4. sets `parallel_tool_calls = false` so Go thinking-mode tool state can be continued reliably;
5. folds completed tool call/output pairs into clearly marked untrusted-data messages, avoiding hidden thinking state that Go's Responses façade does not return;
6. drops assistant messages that carry neither text content nor tool calls — the empty placeholder shells Codex emits during tool loops, which Go's façade rejects;
7. adds a neutral, non-empty `reasoning_content = "tool call"` compatibility marker when Go's façade omitted its hidden thinking field;
8. converts `input_image` data into an opaque, content-addressed `img_…` reference for DeepSeek;
9. injects `harness_vision_inspect` when an image was attached and preserves other ordinary `function`, `custom`, and `namespace` tools;
10. executes harness functions locally and feeds their untrusted results back to DeepSeek for up to four internal rounds;
11. forwards non-streaming JSON directly; for `stream: true`, requests buffered JSON from Go and emits the complete Responses SSE lifecycle Codex expects.

The buffered stream adapter is intentional. Go's current stream can omit item lifecycle events that Codex requires before text deltas. The response remains Responses-native—there is no Chat Completions translation—but the first token arrives only after Go has completed the response. The dashboard marks these requests as `buffered`.

The image reference is stable for identical content and remains only in an in-memory, TTL-bound cache. DeepSeek calls `harness_vision_inspect`; the gate sends the original image to Luna and returns the textual result through its internal tool loop.

The local Codex catalog advertises `text + image` because the gate itself accepts images. The gate always removes image content before the DeepSeek request and exposes only the opaque reference plus `harness_vision_inspect`.

## Harness tools

DeepSeek sees `harness_web_search` and, when an image exists, `harness_vision_inspect` as ordinary Responses functions. The gate executes them; Codex does not need an MCP server entry.

The same backends are also exposed at `/mcp` as `web_search_exa` and `vision_inspect` for direct testing or other local clients.

### `harness_web_search` / `web_search_exa`

Calls the same unauthenticated Exa hosted MCP route used by OpenCode. `EXA_API_KEY` is optional. Search output remains untrusted external content and should be treated as evidence, never as developer instructions.

### `harness_vision_inspect` / `vision_inspect`

Inputs:

- `image_ref` — reference inserted by the Responses gate;
- `compare_image_ref` — optional second reference;
- `question`;
- `mode` — `general`, `ocr`, `ui`, `chart`, or `compare`.

The default model is `gpt-5.6-luna`. HTTP errors, timeouts, invalid JSON, and empty output trigger the `kimi-k2.5` fallback.

## Verification

Local deterministic tests:

```powershell
npm test
```

Real Go, Exa, SSE, MCP, and vision calls:

```powershell
npm run probe:live
```

The live probe prints only short outputs and counters. It never prints the bearer token.

## Security boundaries

- Binds only to `127.0.0.1`, `localhost`, or `::1`.
- Uses MCP SDK Host and Origin validation against DNS rebinding.
- Never forwards the incoming local Authorization header upstream.
- Never renders prompts, image data, or secrets on the dashboard.
- Config mutation endpoints require JSON and reject browser requests from other origins; the service remains loopback-only.
- Every enable operation creates a new backup, and restore refuses to overwrite a config that changed after activation.
- Accepts image data URLs and non-loopback HTTPS image URLs; rejects loopback and plain HTTP image URLs.
- Limits image size, cache entries, cache lifetime, and upstream timeouts.

The dashboard is operational telemetry, not an authentication boundary. Do not expose it through a public reverse proxy.
