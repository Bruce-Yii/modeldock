# ModelDock Architecture (Rewrite)

Status: implemented design for the 2026-08-07 rewrite; this file is the
tracked source of truth for how the gateway behaves.
Date: 2026-08-07
Scope: the ModelDock gateway (D:\projects\modeldock) is a single standalone
tool for DeepSeek (official API and OpenCode Go) plus a native GPT passthrough
leg, with a thin Responses gateway, an MCP sidecar that adds web / vision /
audio tools, a dashboard with observability, and a Codex config switch.

## 1. Positioning

ModelDock is a standalone tool. It is the only bridge between Codex and the
configured upstreams (OpenCode Go and DeepSeek official); it does not rely on
codex-router and it does not need to coexist with it. When ModelDock is
enabled, the Codex config points at ModelDock's loopback endpoint and nothing
else manages that provider section.

The product is optimized for DeepSeek V4 Flash (and the other text-only models
in the OpenCode Go pool): stable multi-turn tool loops, streaming output,
vision / web / audio delivered as tools, and a dashboard that shows exactly
what the bridge is doing. DeepSeek official is a first-class upstream for
users who have a DeepSeek API key.

## 2. Why this rewrite

The previous implementation tried to translate between two dialects of the
Responses protocol. Every translation step was a point of failure:

| Translation step (previous code) | Upstream error observed |
| --- | --- |
| `LiveResponsesWriter` repackaged Go `reasoning_text` into `summary` items sent to Codex; Codex echoed them back with `content: null` | `The reasoning_content in the thinking mode must be passed back to the API` |
| `compactCompletedToolHistory` collapsed completed tool pairs into user receipts | Model ended turns early, or tool-loop context was lost |
| `normalizeAssistantMessages` dropped empty assistant messages | `content or tool_calls must be set` |
| Call-id normalization and tool_calls re-parenting | `tool_calls must be followed by tool messages` |
| Buffered SSE resynthesis (`responses-sse.mjs`) | Tool events arrived in shapes Codex or Go rejected |

Live probing against the OpenCode Go upstream (2026-08-06) confirmed the fix:

- Go streams reasoning as `response.reasoning_text.delta` and returns reasoning
  items with `content: [{type: "reasoning_text", ...}]` and an empty `summary`.
- Echoing that reasoning back verbatim, omitting it, or substituting a
  placeholder all pass Go validation on `/responses` today.
- Go accepts standard function definitions, tool history, and custom tools when
  the request is in the Go dialect.

The same passthrough behavior was proven end-to-end by codex-router's
Responses channel over weeks of stable sessions. ModelDock adopts that lesson:
stop translating conversation history entirely. Capabilities that a text-only
model lacks (vision, audio, web) are delivered as tools, not as rewritten
request content.

## 3. Goals and non-goals

Goals:

- Keep the Codex-to-Go conversation history stable except for the surgical,
  documented rewrites in section 9: orphaned tool rows a compact slice severs
  are dropped or re-paired, and remote compaction is synthesized for routed
  models. Never rewrite messages, reasoning items, call ids, or tool history
  otherwise.
- Support two upstream families over the same passthrough pipeline: OpenCode Go
  (`opencode.ai/zen/go/v1`) and DeepSeek official (`api.deepseek.com`). Both
  speak the Responses protocol, so the gateway code path is identical.
- Provide web search, vision inspection, TTS, and STT to text-only models through
  an MCP sidecar that Codex drives natively.
- Stream responses by piping upstream SSE through unchanged; never buffer and
  resynthesize events.
- Keep the service small: remove the transform pipeline, memory rewriting,
  chat bridge, session checker, and anti-breakpoint machinery.
- Keep the dashboard and config switch, adapted to the single-bridge model.

Non-goals:

- Do not integrate with codex-router or route through it. ModelDock is the
  bridge; codex-router is not installed or consulted when ModelDock is active.
- Do not route Codex's own subscription. The model channel is OpenCode Go only.
- Do not invent a new tool-loop execution engine inside the gateway. The tool
  loop belongs to Codex.
- Do not add history compaction, reasoning caching, or context management to the
  gateway. Context management is Codex's job (declared context window).

## 4. Target architecture

```
  Codex (desktop)  <--responses-->  ModelDock (:4097)
                                    |-- thin gateway  /v1/responses, /v1/models
                                    |-- MCP sidecar   /mcp (streamable HTTP)
                                    |-- dashboard     /  + /api/*
                                    `-- config switch (~/.codex/config.toml)
                                          |-- OpenCode Go (opencode.ai/zen/go/v1)
                                          |-- DeepSeek official (api.deepseek.com)
                                          `-- ChatGPT native (chatgpt.com/backend-api/codex)

  MCP sidecar tools:
    web_search_exa   -> Exa hosted MCP
    vision_inspect   -> vision model (MODELDOCK_VISION_MODEL) over OpenCode Go
    speak / hear     -> local TTS (msedge-tts) / local STT (Windows SAPI)
```

There is exactly one mode. The gateway and the MCP sidecar run in the same
process and listen on the same loopback port.

## 5. Core invariants

1. The gateway never rewrites `input` items except for the allowed
   transformations in section 6.1.
2. The upstream SSE body is piped to Codex as bytes. No event buffering, no
   re-emission, no `reasoning_text` to `summary` translation. A tee observer
   may scan the byte stream for usage events, but it never alters it.
   Observation is not translation.
3. Tool execution happens inside the MCP sidecar. The gateway does not intercept
   function calls and does not append tool results to the request.
4. All model capability declarations must be consistent: if the catalog says a
   model cannot do X, the gateway must not silently try to make X work.
5. Configuration switching is explicit, reversible, and ModelDock is the sole
   manager of its managed `openai_base_url` block in the Codex config.

## 6. Components

### 6.1 Thin gateway (`src/gateway.mjs`)

Handles `POST /v1/responses`, `GET /v1/models`, and the native image endpoints.
Request handling:

1. Read the JSON body.
2. Map the requested model name to the upstream model name (identity by default,
   catalog override allowed). The model's owning provider decides the upstream:
   OpenCode Go models go to `opencode.ai/zen/go/v1`, DeepSeek models go to
   `api.deepseek.com`. Same shape, same pipeline.
3. Apply the tool policy:
   - Keep standard `function` and `custom` tool definitions.
   - Flatten MCP namespace tools (`mcp__*`) into plain `function` definitions
     so text-only models see the sidecar tools as ordinary functions.
   - Defensively strip Codex hosted / special tool types that Go rejects
     (for example `web_search`, `computer_use`, `browser_use`, `artifact`) from
     `payload.tools`. The primary control is the catalog declaration
     (`supports_search_tool: false`, curated `experimental_supported_tools`);
     the strip is a safety net, not the mechanism.
   - Never inject harness tools. Codex obtains them from the MCP server.
4. Forward the body unchanged to the upstream `/responses` endpoint.
5. Pipe the upstream response (headers and body) back to Codex as bytes. Set
   `Content-Type: text/event-stream`. Do not parse, buffer, re-emit, or inject
   synthetic keepalive events: an idle upstream must surface as an idle or
   closed stream so Codex's own timeout remains the only stall safety net.
6. Tee observer (out of band): a parallel consumer reads the same byte stream,
   extracts usage from `response.completed`, and records it for the meter and
   token display. The tee never delays, drops, or modifies the bytes forwarded
   to Codex. This is how "byte passthrough" and "token display" coexist.
7. On upstream error, forward status and body with the token redacted.
8. Native GPT passthrough (the parallel leg): native slugs are merged into the
   published catalog (see `src/native-catalog.mjs`) so the App picker keeps
   listing them beside ours, and the gateway routes any request for those slugs
   to ChatGPT's native backend instead of an external upstream. The request is
   forwarded verbatim to `https://chatgpt.com/backend-api/codex` with the
   client's signed-in headers (authorization, chatgpt-account-id,
   x-oai-attestation, x-codex-*, session and thread ids). No tool policy, no
   historical-image rewrite, no image escalation: the native backend owns hosted
   tools, history images, and its own vision. Non-opaque `reasoning` blobs and
   compaction summaries are normalized for replay, and `previous_response_id`
   is dropped. Image generation and edits (`/v1/images/generations`,
   `/v1/images/edits`) pass through the same way so the built-in `image_gen`
   tool works on the ChatGPT subscription without a Platform API key.
9. Remote compaction (v1/v2) is synthesized for routed models. Transparent mode
   makes Codex believe it is talking to the native backend, so its compact task
   expects a `compaction` output item back (v2, a Responses request whose last
   input item is `compaction_trigger`) or replacement history (v1, `POST
   /responses/compact`) instead of a plain summary - a protocol DeepSeek does
   not speak. `relayCompaction` intercepts both shapes before they reach the
   upstream, runs a separate non-streaming summarize call (COMPACT_PROMPT
   appended, `stream: false`, `tools: []`, `tool_choice: "none"`), and answers
   Codex with the summary wrapped in a `kcr1:` base64 `encrypted_content` (v2,
   JSON or SSE) or with replacement history under `{ output }` (v1). On replay
   the `kcr1:` payload is decoded back into a continuation message by both
   `normalizeGatewayInput` and `normalizeNativeInput`. Native models are never
   intercepted: the native backend owns the protocol and handles compaction
   items itself.

Allowed `input` transformations (the complete list):

- Drop unpaired tool items (`dropUnpairedToolItems`, both dialects). A
  `function_call` / `custom_tool_call` with no matching output, or an output
  with no matching call, is removed. Codex produces such orphans when a remote
  compact task slices history at a call/output boundary, and Go rejects the
  whole request on the first unpaired call ("No tool output found for tool
  call ..."). The chat dialect pairs the same way: assistant messages carrying
  a `tool_calls` array are matched against `role:"tool"` messages with
  `tool_call_id`; an assistant message whose calls were all severed is dropped
  entirely when it carries no other text (an empty assistant turn is rejected
  upstream too).
- Re-pair severed tool rows (`relocateToolOutputs`). Existence pairing is not
  enough: Go's Responses->chat translation rejects a tool result that does not
  directly follow the assistant message that declared its call. A compact slice
  can leave a call and its output in the history with an assistant text message
  between them; `relocateToolOutputs` moves each output right after its call
  group (parallel calls keep their group, interleaved text moves after the
  outputs, duplicate outputs are dropped). Same intent as codex-router's
  `coalesceAssistantMessages` + `ensureToolResultsForCalls`, applied on the
  Responses shape we forward.
- Delete `previous_response_id` on both legs. The input array is the
  authoritative history; server-side continuation state could still carry the
  orphaned call this filter just cleaned, so strict upstreams (Go) would reject
  the request again.
- Remove `compaction_trigger` items, and turn `compaction` items into plain user
  summary messages. The native leg expands compaction items the same way and
  additionally strips non-opaque `reasoning` blobs before replay.
- Replace `input_image` parts in non-current turns with a lightweight
  `image_ref` placeholder text; the media store keeps the image so
  `vision_inspect` can re-read it. Current-turn images stay untouched (they are
  either escalated to the vision model or read by a vision-capable main model).
  Without this, a pasted screenshot would be re-sent to the text-only main model
  on every later turn (hundreds of KB per request) and silently ignored
  (DeepSeek official returns `NO_IMAGE_RECEIVED`; Go rejects it), with no way to
  recover the pixels except `vision_inspect`.
- Delete `client_metadata` on the routed leg (Codex-side metadata is not part
  of the upstream contract).

Direct image escalation (pasted images and tool screenshots):

- If the current turn's `input` contains an `input_image` part, route the whole
  request to the configured vision model (`MODELDOCK_VISION_MODEL`) by changing
  only `payload.model`. The `input` bytes are forwarded verbatim, including the
  image: the vision model sees the real pixels, so no placeholder or image
  rewriting is needed for this path.
- The catalog entry for the text-only main model declares `input_modalities:
  ["text","image"]` so Codex allows pasting; the declaration describes the
  endpoint's effective capability (images are handled by the vision model via
  escalation), not the main model's native modality.
- Tool-call affinity: if the vision model emits a tool call during an image
  turn, register its call id and route subsequent requests carrying that call's
  `function_call_output` back to the vision model until the call pair
  completes (same semantics as the previous `RouteAffinity`). Without this,
  the text-only main model would receive an orphan tool call and Go would
  reject the pair.
- The response `model` field is left honest (the vision model's id). Codex
  bookkeeps by request model and tolerates the mismatch; the dashboard trace
  shows which model actually served the turn.
- After the image turn, requests without an image route back to the main model
  normally. The media store keeps an `image_ref` for the pasted image so
  `vision_inspect` remains available for follow-up visual questions.

### 6.2 MCP sidecar (`src/mcp.mjs` + `src/upstreams.mjs`)

Exposes tools over MCP (streamable HTTP, loopback). Codex lists them as ordinary
functions, the model calls them, Codex attaches results as
`function_call_output`. The gateway is not involved.

| Tool | Backend | Notes |
| --- | --- | --- |
| `web_search_exa(query, numResults, livecrawl, type, contextMaxCharacters)` | Exa hosted MCP (`EXA_MCP_URL`, `EXA_API_KEY`) | Existing implementation in `upstreams.mjs` |
| `vision_inspect(path, compare_image_ref?, question, mode)` | Vision model over OpenCode Go (`MODELDOCK_VISION_MODEL`) | Text answer returned; image never enters the main request |
| `speak(text, voice?, output?)` | `msedge-tts` (on-demand install) | Returns absolute audio path |
| `hear(file, language?, output?)` | Windows SAPI (System.Speech) | Returns text + confidence |

`vision_inspect` is path-first: the model passes a local file path (for example
a screenshot it just took). `compare_image_ref` is optional and only relevant
when the media store is enabled for dashboard-uploaded images.

Vision routing: there are two complementary paths. (1) Direct image escalation:
when a request's current turn contains an `input_image` (pasted image or tool
screenshot), the gateway routes that request to the configured vision model
and pipes its reply back; the text-only main model never receives the image.
(2) `vision_inspect`: when the main model wants to inspect a local file or a
stored `image_ref`, it calls the MCP tool and the sidecar runs the vision model
out of band, returning text. When the main model itself is vision capable and
the turn is visual, Codex sends images directly and neither path is involved.

### 6.3 Model catalog and context declaration (`src/catalog.mjs`)

Replaces the catalog-building half of `profiles.mjs`. This is the single place
that answers "what can this model do" for Codex. It is served by `/v1/models`
and emitted to `model_catalog_json`. See section 8 for the exact fields.

`src/native-catalog.mjs` captures the Codex desktop CLI's bundled native model
catalog (`codex debug models --bundled`, newest installed CLI under
`%LOCALAPPDATA%\OpenAI\Codex\bin`), caches it at
`~/.modeldock/native-catalog.json`, and refreshes it at gateway startup and on
the model refresh timer. `catalogFor` merges the `visibility: list` native
entries into the published catalog (labelled `OpenAI - <model>`) so the App
picker keeps showing them beside ours, then `orderCatalogByProvider` re-orders
the whole list by provider label (DeepSeek Official, OpenAI, OpenCode Go) and
renumbers `priority` sequentially. The Codex picker sorts by `priority`, and
the native entries carry their own priorities (1, 2, 3, 7, 29...) that would
otherwise interleave with ours and scatter the native models across the list.
Picker-hidden entries stay out of the list, but requests for their slugs are
still routed to the native backend. A missing or stale cache degrades to the
curated catalog alone. Overrides: `MODELDOCK_NATIVE_CATALOG_FILE` (cache path) and
`MODELDOCK_REFRESH_NATIVE_CATALOG=0` (disable the desktop-CLI capture, e.g. in
CI).

### 6.4 Dashboard and events (`public/`, `src/server.mjs`)

The dashboard shows:

- Gateway health and upstream reachability.
- The active upstream (OpenCode Go or DeepSeek official) as read from the
  Codex config and from the last routed request.
- MCP tool availability and last-call results.
- Main model row: read-only display of provider and model, read from the current
  Codex config (never edited in ModelDock). The layout keeps the existing
  provider + model pair, just switches from a selector to a display.
- Vision model: a picker restricted to models declared vision-capable. Audio
  tools (`speak` / `hear`) stay available as MCP tools.
- Provider visibility: only providers with a configured token are shown and
  published. The active profile is always shown (its token may resolve from the
  Codex config backup); other providers appear only when their key is set in
  `.env`. A provider with no key cannot serve requests, so it stays hidden from
  the dashboard and the Codex model catalog.
- Meter: per-tool counters, latency, upstream usage from `response.completed`,
  and recent request/error trace.
- Config switch state and the backup/restore status.
- Route and token display: for the most recent routed request, show the
  upstream route taken (OpenCode Go or DeepSeek official), the wire style
  (`responses`), and the token breakdown (input, output, reasoning, total)
  captured by the tee observer from `response.completed` usage events. The
  byte stream forwarded to Codex is never parsed or altered for this purpose.

Vision capability fields (`supportsVision`, `visionScore`, `visionTier`) are
hand-maintained constants in the catalog. They were originally produced by the
`vision-eval.mjs` benchmark; the probe now lives in `scripts/vision-probe.mjs`
as a dev-only tool to regenerate scores manually when the model pool changes.
No automated probe runs at startup.

`GET /api/events` stays an SSE channel that pushes the status payload on change
(existing mechanism).

### 6.5 Config switch (`src/config-switcher.mjs`)

The switch writes `~/.codex/config.toml`. Behavior:

- Single target: a `# BEGIN modeldock-managed` block that keeps the built-in
  openai provider and only redirects `openai_base_url` to the gate
  (`http://127.0.0.1:4097/c/<key>/v1`), plus `model_catalog_json` and the
  realtime endpoint overrides; the top-level `model` key selects the active
  slug. ModelDock is the only manager of that block. This is the codex-router
  transparent shape: `uses_codex_backend()` stays true and the ChatGPT
  subscription stays intact. The transparent shape alone does NOT re-add native
  GPT models to the picker (the App picker is a replacement, not a merge) -
  the merged catalog in section 6.3 does that.
- On enable: back up the current config, apply the change, ask the user to
  restart Codex, and wait for the restart acknowledgment (existing flow).
- On disable: restore the backup. If the config changed outside ModelDock after
  enable, refuse to restore and explain (existing drift lock; keep it).

The switch also records which upstream the enabled configuration uses, so the
dashboard can show it without guessing. The `openai_base_url` always points at
the ModelDock loopback; the upstream selection lives in ModelDock's own
settings (`.env`), not in the Codex config. A config still carrying the legacy
`model_provider = "modeldock_go"` shape is migrated in place on re-enable, and
enable() refuses when codex-router already manages `openai_base_url`.

### 6.6 Supporting modules

- `src/config.mjs`, `src/secrets.mjs`: keep, with only additive changes.
- `src/media-store.mjs`: keep in simplified form (byte caps, IPv6 loopback
  handling already fixed) for dashboard uploads and vision refs.
- `src/metrics.mjs`: keep; add MCP call counters and usage ingestion.
- `src/tts.mjs`, `src/stt.mjs`: keep as upstream backends.
- `src/autostart.mjs`, `src/update.mjs`, `scripts/restart.ps1`: keep.

## 7. Wire protocol notes (why passthrough works)

Codex and OpenCode Go both speak the Responses protocol but fill some fields
differently:

- Go reasoning items: `content: [{type: "reasoning_text", text}]`, `summary: []`.
  OpenAI native uses `encrypted_content` plus a populated `summary`.
- Go call ids look like `call_00_...` and must round-trip unchanged.
- Go accepts custom tool calls and standard function definitions.

The previous gateway translated Go's reasoning into the OpenAI shape for Codex,
Codex stored the translated shape, and the next request carried
`reasoning.content: null` back to Go, which rejected it. Passthrough avoids the
translation entirely. The full round trip works today, including compaction,
multi-turn tool loops, and vision side-channel calls.

## 8. Context and model declaration changes

These fields are the contract between Codex and the gateway. They must be
reviewed per model and kept consistent within ModelDock's own catalog.

| Field | Current | Target | Reason |
| --- | --- | --- | --- |
| `context_window` / `max_context_window` | 250000 default (`MODELDOCK_CONTEXT_WINDOW` env override); per-model overrides: 400000 for official DeepSeek entries, 272000 for native GPT merges | keep explicit per model | Lets Codex manage compaction instead of the gateway |
| `auto_compact_token_limit` | `floor(context_window * 0.8)` (200000 at 250000, 320000 at 400000) | derived from context window | Keep |
| `input_modalities` | text (deepseek) | `["text","image"]` on every published entry | Direct image escalation routes image turns to the vision model, so the endpoint effectively accepts images for every relayed model |
| `supports_search_tool` | false | false | Go has no hosted search; search is the MCP tool |
| `web_search_tool_type` | "text" | "text" | Keep |
| `supports_parallel_tool_calls` | false | false (catalog) and never forced in payload | Keep declaration only |
| `reasoning_summary_format` | "experimental" | "experimental" | Matches Go dialect |
| `default_reasoning_summary` | "none" | "none" | Keep |
| `experimental_supported_tools` | artifact, tool_call_mcp_elicitation, workspace_dependencies, computer_use, browser_use | Curated; verify each against Go acceptance | Hosted tool *definitions* must not reach Go |
| `truncation_policy` / `effective_context_window_percent` | tokens, limit 10000 / 95 | Keep | Unchanged |
| native catalog merge | - | native `visibility: list` entries merged, labelled `OpenAI - <model>`, whole catalog re-ordered by provider label with sequential priorities | The App picker is a replacement, not a merge; native slugs must be republished in our catalog to stay selectable |

## 9. Security and operations

- Loopback-only binding (kept). MCP and gateway reject non-loopback hosts.
- Secrets stay encrypted on disk (`secrets.mjs`), with the existing plaintext
  migration and verification.
- Media byte caps and URL checks are reused from `media-store.mjs`; the IPv6
  loopback fix is part of the baseline.
- Upstream error bodies have bearer tokens redacted before being shown in the
  dashboard.
- `scripts/restart.ps1` remains the restart path for the gateway service.
- Logging goes to `%TEMP%\modeldock\` as today.

## 10. Migration plan

Status: phases 0-7 below are implemented as of 2026-08-07. The
`MODELDOCK_LEGACY_RELAY` A/B flag described in phases 3/6 was dropped rather
than shipped: the rewrite deleted the transform modules outright. This file is
tracked in git (it is not ignored). Work after the rewrite added the native GPT
passthrough leg and the bundled native catalog merge (sections 6.1 and 6.3).

Phase 0 - Baseline: `npm test` green on the current tree; record the passing
test list and total count.

Phase 1 - Gateway module: add `src/gateway.mjs` with model mapping, tool policy,
compaction normalization, and SSE pipe, plus `src/gateway.test.mjs`. Acceptance:
unit tests cover tool stripping, compaction normalization, image rejection,
byte-stream passthrough, error redaction, the tee observer extracting
`response.completed` usage without mutating the forwarded bytes, and the
absence of synthetic keepalive events (an idle upstream stays idle downstream),
plus request-level image escalation (current turn with `input_image` routes to
the vision model) and tool-call affinity pinning for vision-model
continuations. No server wiring yet.

Phase 2 - Standalone MCP sidecar: add `src/mcp-server.mjs` entry that serves
`/mcp` only. Acceptance: `node src/mcp-server.mjs` starts on its own port;
`tools/list` and `tools/call` work for `web_search_exa` and `vision_inspect`
against live upstreams; dashboard not required.

Phase 3 - Server rewrite: `src/server.mjs` becomes thin wiring: gateway, MCP
handler, dashboard routes, config switch, events. Delete `transform.mjs`,
`md-memory.mjs`, `chat-bridge.mjs`, `live-responses.mjs`, `responses-sse.mjs`,
`session-checker.mjs`, `auto-route.mjs` and their tests. Acceptance: `npm test`
green with the reduced suite; a Codex session completes a multi-turn tool task
with no reasoning or tool-call errors.

Phase 4 - Declarations: replace the catalog half of `profiles.mjs` with
`src/catalog.mjs`; update fields per section 8; update `config-switcher.mjs`
for the single managed provider. Acceptance: catalog tests; switch
enable/disable round trip against a disposable config file.

Phase 5 - Dashboard: touch up `public/` only. The existing dashboard already
renders health, MCP tool calls, model pickers, meter, and switch state; the
only changes are switching the main model row from a selector to a read-only
display of provider + model (read from the Codex config) and pointing the
token display at the tee observer. Provider and model columns stay visible.
Acceptance: dashboard renders from a live server with the main model row
read-only; no stale transform metrics.

Phase 6 - End-to-end: run Codex through the bridge; verify streaming
(first-token latency, no buffered finish), vision via `vision_inspect`, web via
`web_search_exa`, TTS/STT where available. Direct image escalation is verified
by pasting an image into a text-only-main-model conversation: the turn is
served by the vision model, a tool call from the vision model continues on the
vision model, and the next text turn returns to the main model. Then verify in
a clean checkout (`git clone . <tmp> && npm ci && npm run build && npm test`).

Phase 7 - Docs and packaging: this file plus README refresh. The legacy flag
never shipped (see the phase status above); this file is tracked in git and is
the single source of truth. Release flow otherwise unchanged.

## 11. Test strategy

Current suite (all green; run with `npm test`):

- `gateway.test.mjs` (pure passthrough, tool policy, pipe, orphan pairing,
  `previous_response_id` handling).
- `catalog.test.mjs` + `native-catalog.test.mjs` (declaration consistency and
  the bundled-native merge).
- `mcp-server.test.mjs` (tool listing and call routing, mocked upstreams).
- `server.test.mjs`, `server-gateway.test.mjs` (thin server and relay wiring).
- `config-switcher.test.mjs` (single managed provider), plus the unit tests
  for `config`, `secrets`, `metrics`, `usage-events`, `upstreams`,
  `media-store`, `error-translation`, `profiles`, `router`, `caller-key`,
  `instance-owner`, `update`, and `test/*` (`install-mock` needs a build).

## 12. File disposition

Current layout (the rewrite is implemented; the old transform pipeline is
gone):

Core gateway: `server.mjs` (thin wiring), `gateway.mjs` (relay + passthrough),
`router.mjs` (routing + affinity), `error-translation.mjs`, `caller-key.mjs`.

Declarations and config: `profiles.mjs` (provider profiles and the curated
model list), `catalog.mjs` (published catalog), `native-catalog.mjs` (bundled
native catalog capture/merge), `config.mjs`, `config-switcher.mjs`.

Capabilities: `mcp.mjs` + `mcp-server.mjs` (MCP sidecar), `upstreams.mjs`
(`web_search_exa` / `vision_inspect` backends), `tts.mjs`, `stt.mjs`,
`media-store.mjs`, `vision-eval.mjs` (dev-only probe; never runs at startup).

Observability and ops: `metrics.mjs`, `usage-events.mjs`, `instance-owner.mjs`,
`secrets.mjs`, `autostart.mjs`, `update.mjs`, `static-inline.mjs`,
`scripts/restart.ps1`.

Frontend: `public/*` (dashboard; the main model row is a read-only display).
Tests live beside their modules (`src/*.test.mjs`) plus `test/`.

## 13. Open decisions

Resolved during the rewrite:

1. `vision_inspect` is path-first: the model passes a local file path; the
   media store keeps dashboard-uploaded images for `image_ref` reads.
2. `experimental_supported_tools` stays curated to the five entries the App
   needs for client-side plugin machinery; the gateway strips hosted tool
   *definitions* (`web_search`, `computer_use`, `browser_use`, `artifact`,
   `tool_search`) before they reach Go.
3. TTS uses on-demand `msedge-tts` install (kept; avoids CI packaging issues).
4. `vision-eval.mjs` survives as dev-only tooling (never runs at startup);
   vision fields in the catalog are hand-maintained constants.
5. Direct image escalation: kept. Request-level routing to the vision model
   when the current turn has `input_image`, with affinity pinning for tool
   continuations and an honest response `model` field.

## 14. Summary

The rewrite removes the translation layer that caused every upstream error in
the project history. What remains is a standalone bridge for DeepSeek on two
upstreams (OpenCode Go and DeepSeek official) sharing one passthrough
pipeline, plus a native GPT leg for the ChatGPT subscription: a narrow gateway
that pipes each dialect through untouched (after the allowed input
transformations in section 6.1), an MCP sidecar that gives text-only models
vision, web, and audio as tools, a dashboard and config switch that operate on
the single bridge, and declarations (curated plus merged native) that tell
Codex the truth about each model. No codex-router dependency, no dual-target
config management.
