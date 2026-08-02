# ModelDock OpenCode Go Gate

A narrow, loopback-only bridge for running the Codex harness against OpenCode Go's Responses facade.

```text
Codex --Responses--> 127.0.0.1:4097 --Responses--> OpenCode Go / deepseek-v4-flash
                               |--local function loop--> Exa hosted MCP
                               `--local function loop--> Go / gpt-5.6-luna (Kimi fallback)
```

The gate does four jobs:

- removes hosted `tool_search` and `web_search` schemas that OpenCode Go rejects;
- exposes web search and image inspection to DeepSeek as ordinary functions executed by the local harness;
- normalizes Codex Responses history for Go, including removing empty assistant placeholder messages;
- turns Go's partial SSE into a live, complete Responses lifecycle for Codex.

It is not a model router, a Chat Completions converter, or a local search engine. Exa and all Go models are cloud services; only the orchestration and metering run locally.

## Start

Requirements: Node.js 22+ and an OpenCode Go bearer token.

```powershell
npm install
npm start
```

Credential resolution order:

1. `OPENCODE_GO_TOKEN` from the environment or `.env`;
2. the newest `~/.codex/config.toml` or `config.toml.bak*` containing an `opencode`, `opencode_go`, or `console_go` provider token.

Only the credential source label is exposed in `/api/status`; the path and token are never returned to the browser or logs.

Open [http://127.0.0.1:4097](http://127.0.0.1:4097). The service refuses non-loopback bind addresses.

## Codex config switch

The dashboard switch defaults to Off. Turning it On:

1. backs up the current user-level `~/.codex/config.toml`;
2. changes the top-level `model`, `model_provider`, and `web_search` values;
3. adds `[model_providers.modeldock_go]` pointing at `http://127.0.0.1:4097/v1`;
4. preserves all other Codex settings and asks for a full Codex restart.

Turning it Off restores only ModelDock-managed fields. Unrelated changes made while the gate was active, such as plugin or desktop settings, are preserved. Restore is blocked only if the managed provider fields themselves conflict. If Codex or the user already restored the file externally, ModelDock recognizes that state and safely reconciles to Off.

Switch state lives under `~/.codex/modeldock/`. Config contents and credentials are never rendered in the dashboard.

## Responses normalization

For each request, the gate:

1. normalizes string input to Responses message input;
2. replaces `tool_search`/`web_search` with `harness_web_search`;
3. rewrites `tool_choice: "required"` to `"auto"` for Go thinking-mode compatibility;
4. forces `parallel_tool_calls: false`;
5. compacts completed local tool call/output pairs into marked untrusted-data messages;
6. drops assistant messages with neither non-empty text nor tool calls;
7. adds stable IDs and the non-empty reasoning marker required by Go's facade;
8. replaces images with opaque `img_` references and injects `harness_vision_inspect`;
9. executes up to four internal web/vision tool rounds;
10. forwards JSON responses directly or emits live normalized SSE.

Go streams text deltas in real time but omits several lifecycle events expected by Codex. ModelDock forwards each delta as it arrives and supplies `response.created`, item/content start and done events, `response.completed`, and `[DONE]`. Successful streaming traces report `streamMode: "live-normalized"`.

## Dashboard and diagnostics

`GET /` shows request, token, byte, schema-filter, search, vision, and fallback meters. Click any recent trace row to inspect its sanitized raw evidence, including `inputShape`, `responseShape`, stream mode, filtered tool count, and internal tool rounds. Prompt text, tool output, images, and credentials are excluded.

Other endpoints:

- `POST /v1/responses` - Codex Responses gateway;
- `GET /v1/models` - local Codex model catalog;
- `POST /mcp` - direct MCP access to `web_search_exa` and `vision_inspect`;
- `GET /api/status` - sanitized runtime and recent trace JSON;
- `GET /api/config` - config switch status.

## Verification

```powershell
npm test
npm run probe:live
```

The deterministic suite includes a timing-controlled assertion that the downstream client receives a text delta before the mock upstream completes. The live probe exercises OpenCode Go, Exa, MCP, streaming, and vision without printing the bearer token.

## Security boundary

- The service binds only to `127.0.0.1`, `localhost`, or `::1`.
- Config mutation endpoints require JSON and reject other browser origins.
- Incoming local Authorization headers are never forwarded upstream.
- Prompt and media contents are not included in telemetry.
- Image data, entry count, TTL, and upstream timeouts are bounded.

The dashboard is local operational telemetry, not an authentication boundary. Do not publish it through a reverse proxy. Remote HTTPS image fetching still needs private-network blocking and a streamed response byte cap before this should be treated as hardened against hostile local callers.
