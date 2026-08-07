import { Readable } from "node:stream";
import { bareModelId, modelEntryFor, providerForModel } from "./profiles.mjs";
import { recordUsageEvent } from "./usage-events.mjs";
import { translateUpstreamError } from "./error-translation.mjs";
import { RouteAffinity, routeResponsesRequest } from "./router.mjs";
import { extractResponseUsage } from "./metrics.mjs";

// Hosted / special tool types Codex can emit that the Go and DeepSeek upstreams
// reject. The catalog declarations are the primary control; stripping here is the
// safety net, not the mechanism.
const HOSTED_TOOL_TYPES = new Set([
  "tool_search",
  "web_search",
  "computer_use",
  "browser_use",
  "artifact",
]);

// Tools that hand the model bytes it cannot interpret (text-only main models).
// The vision path is vision_inspect or direct image escalation, not view_image.
const TEXT_MODEL_HIDDEN_TOOLS = new Set(["view_image"]);

function redactBearer(value) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "sk-[redacted]");
}

export { redactBearer };

// The only input rewriting the gateway is allowed to do. Everything else in the
// history must pass through untouched.
export function normalizeGatewayInput(input) {
  if (!Array.isArray(input)) return input;
  return input
    .filter((item) => item?.type !== "compaction_trigger")
    .map((item) => {
      if (item?.type !== "compaction") return item;
      const text = Array.isArray(item.encrypted_content)
        ? item.encrypted_content
            .filter((part) => ["summary_text", "text"].includes(part?.type) && typeof part.text === "string")
            .map((part) => part.text)
            .join("\n")
        : "";
      return {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: text || "[Earlier conversation history was compacted in an unreadable format.]" }],
      };
    });
}

// A message is "current" when it follows the last assistant turn. Only those
// images may reach the upstream: the request is either escalated to the vision
// model or the main model itself can see images. Images in earlier turns were
// already handled (often by the vision model) and re-sending their bytes on every
// turn burns tokens the text-only main model cannot use.
function currentTurnStart(input) {
  if (!Array.isArray(input)) return 0;
  let start = 0;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index]?.role === "assistant") start = index + 1;
  }
  return start;
}

export function currentTurnStartForTesting(input) {
  return currentTurnStart(input);
}

// Replace input_image parts in non-current turns with a lightweight image_ref
// placeholder. The media store keeps the image so vision_inspect can re-read it.
// Current-turn images stay untouched (they are either escalated or read by a
// vision-capable main model). Without a media store the rewrite is a no-op, so a
// partial services stub stays safe.
export function rewriteHistoricalImages(input, mediaStore) {
  if (!Array.isArray(input)) return input;
  const turnStart = currentTurnStart(input);
  return input.map((item, index) => {
    if (!item || typeof item !== "object" || !Array.isArray(item.content) || index >= turnStart) return item;
    let changed = false;
    const content = item.content.map((part) => {
      if (!part || typeof part !== "object" || part.type !== "input_image" || typeof part.image_url !== "string") return part;
      changed = true;
      if (!mediaStore) {
        return { type: "input_text", text: "[An image was attached earlier in this conversation. Its visual contents were handled in a prior turn; do not re-inspect unless the user asks a new visual question.]" };
      }
      let ref;
      try {
        ref = mediaStore.put(part.image_url);
      } catch {
        return { type: "input_text", text: "[An image was attached earlier in this conversation. Its visual contents were handled in a prior turn; do not re-inspect unless the user asks a new visual question.]" };
      }
      return {
        type: "input_text",
        text: `[Image attachment ${ref}. Its visual contents were handled in a prior turn. Use vision_inspect with image_ref "${ref}" if a new visual question arises.]`,
      };
    });
    return changed ? { ...item, content } : item;
  });
}

// Tool policy: keep standard function/custom tools, flatten MCP namespaces so
// text models see plain functions, and strip hosted schemas plus tools the model
// cannot use. Returns the filtered list and a report of what was removed.
export function applyToolPolicy(tools, { hiddenToolNames = TEXT_MODEL_HIDDEN_TOOLS } = {}) {
  if (!Array.isArray(tools)) return { tools, stripped: { toolSearch: 0, webSearch: 0, otherHosted: 0, hidden: 0, namespaceChildren: 0 } };
  const hidden = new Set(hiddenToolNames || []);
  const stripped = { toolSearch: 0, webSearch: 0, otherHosted: 0, hidden: 0, namespaceChildren: 0 };
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (
      tool.type === "namespace"
      && typeof tool.name === "string"
      && (tool.name.startsWith("mcp__") || tool.name.startsWith("namespace:mcp__"))
    ) {
      const children = Array.isArray(tool.tools) ? tool.tools : [];
      for (const child of children) {
        if (!child?.name) continue;
        if (hidden.has(child.name)) {
          stripped.hidden += 1;
          continue;
        }
        stripped.namespaceChildren += 1;
        out.push({ ...structuredClone(child), type: "function", name: `${tool.name}__${child.name}` });
      }
      continue;
    }
    if (HOSTED_TOOL_TYPES.has(tool.type)) {
      if (tool.type === "tool_search") stripped.toolSearch += 1;
      else if (tool.type === "web_search") stripped.webSearch += 1;
      else stripped.otherHosted += 1;
      continue;
    }
    if (typeof tool.name === "string" && hidden.has(tool.name)) {
      stripped.hidden += 1;
      continue;
    }
    out.push(structuredClone(tool));
  }
  return { tools: out, stripped };
}

// Resolve the upstream for a model. The owning provider decides the base URL and
// token; the wire is always Responses. The @provider suffix is stripped before
// the id reaches the upstream.
export function upstreamTargetFor(config, model) {
  const provider = providerForModel(config, model);
  const upstreamModel = bareModelId(model);
  if (provider === "deepseek-official") {
    return {
      provider,
      model: upstreamModel,
      url: `${(config.deepseekBaseUrl || "https://api.deepseek.com").replace(/\/+$/, "")}/responses`,
      token: config.tokens?.["deepseek-official"] || config.deepseekToken || "",
    };
  }
  const entry = modelEntryFor(config, upstreamModel);
  const baseUrl = entry?.zen
    ? (config.zenBaseUrl || "https://opencode.ai/zen/v1")
    : (config.opencodeBaseUrl || config.goBaseUrl || "https://opencode.ai/zen/go/v1");
  return {
    provider: "opencode-go",
    model: upstreamModel,
    url: `${baseUrl.replace(/\/+$/, "")}/responses`,
    token: config.goToken || config.tokens?.["opencode-go"] || "",
  };
}

export function routeGatewayRequest(source, { mainModel, visionModel, affinity, knownModels }) {
  return routeResponsesRequest(source, { mainModel, visionModel, affinity, knownModels });
}

export { RouteAffinity };

// Incremental SSE scanner used by the tee observer. It recognizes complete events
// as they arrive across chunk boundaries, extracts usage, and never retains the
// stream. The forwarded bytes are never parsed for this purpose beyond this
// read-only copy.
export function createUsageTee(onEvent) {
  let buffer = "";
  const push = (chunk) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    buffer += text;
    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          onEvent?.(JSON.parse(data));
        } catch {
          // Ignore non-JSON or partial SSE data lines.
        }
      }
    }
    if (buffer.length > 1_000_000) buffer = buffer.slice(-500_000);
  };
  const end = () => {
    // Non-streaming upstreams return a single JSON body with no SSE framing. When
    // the buffer is a complete JSON object (a stream would leave a partial event
    // or an empty buffer here), surface it as a completed response so usage and
    // tool-call affinity are still captured.
    const trimmed = buffer.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          onEvent?.({ type: "response.completed", response: parsed });
        }
      } catch {
        // Partial SSE event residue or non-JSON body: ignore.
      }
    }
    buffer = "";
  };
  return { push, end };
}

function usageFromEvent(event) {
  return extractResponseUsage(event);
}

// Pipe an upstream response body to the client as bytes. No buffering, no
// re-emission, no synthetic keepalive: an idle upstream stays idle downstream so
// Codex's own timeout remains the only stall safety net. The tee observer
// receives a read-only copy of each chunk for usage extraction.
//
// Node stream .pipe() is used instead of a manual read/write loop so downstream
// backpressure is honoured (a slow client pauses the upstream read instead of
// buffering the whole response in memory). A client that disconnects mid-stream
// emits "close" without "finish" or "error"; without that handler the promise
// never settles and the request stays counted as in-flight forever, with the
// upstream body still being read.
export async function pipeGatewayStream(upstreamBody, res, tee) {
  if (!upstreamBody) {
    res.end();
    return 0;
  }
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(upstreamBody);
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    stream.on("data", (chunk) => {
      tee?.push(chunk);
      bytes += chunk.byteLength || Buffer.byteLength(chunk);
    });
    stream.once("end", () => tee?.end?.());
    stream.once("error", settle);
    res.once("finish", () => settle());
    res.once("error", settle);
    res.once("close", () => {
      if (!settled) stream.destroy();
      settle();
    });
    stream.pipe(res);
  });
  return bytes;
}

// Relay one Responses request: normalize, route (with image escalation and
// affinity), apply tool policy, choose upstream, forward, pipe, and tee.
// `services` carries { config, metrics, mediaStore, routeAffinity, modelSelection,
// knownModels, visionModelOf } so the caller decides wiring.
export async function relayResponses(payload, res, services, { signal } = {}) {
  const { config, metrics, mediaStore, routeAffinity, knownModels } = services;
  const mainModel = services.mainModel || config.mainModel;
  const visionModel = services.visionModel || config.visionModel;
  const route = routeGatewayRequest(payload, {
    mainModel,
    visionModel,
    affinity: routeAffinity,
    knownModels,
  });

  const normalizedPayload = {
    ...payload,
    input: rewriteHistoricalImages(normalizeGatewayInput(payload.input), mediaStore),
    model: route.model,
  };
  delete normalizedPayload.client_metadata;

  const { tools, stripped } = applyToolPolicy(normalizedPayload.tools);
  if (tools !== normalizedPayload.tools) normalizedPayload.tools = tools;

  const target = upstreamTargetFor(config, normalizedPayload.model);
  // The upstream sees the bare model id; the route model (possibly owner-suffixed)
  // stays in the response and affinity so provider resolution keeps working on
  // continuation requests.
  const upstreamModel = target.model;
  if (!target.token) {
    const error = {
      error: {
        type: "configuration_error",
        message: `No API token configured for provider ${target.provider}.`,
      },
    };
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(error));
    metrics?.recordResponseTransform?.({
      blocked: { tool_search: stripped.toolSearch, web_search: stripped.webSearch },
      toolChoiceRewritten: false,
      imageRefs: [],
      directVision: route.directVision,
      droppedAssistantMessages: 0,
      nativeToolCalls: 0,
      nativeToolOutputs: 0,
      fallbackToolResults: 0,
    }, { streaming: false, routeReason: route.reason });
    return { ok: false, httpStatus: 503, route, error };
  }

  const finish = metrics?.begin?.("responses", {
    operation: "relay",
    model: normalizedPayload.model,
    upstream: target.provider,
    routeReason: route.reason,
  });
  const startedAt = Date.now();
  let usage;
  let bytesOut = 0;
  let completedResponse;
  const tee = createUsageTee((event) => {
    const eventUsage = usageFromEvent(event);
    if (eventUsage) usage = eventUsage;
    if (event?.type === "response.completed" && Array.isArray(event.response?.output)) {
      completedResponse = event.response;
    }
  });

  try {
    const upstream = await fetch(target.url, {
      method: "POST",
      headers: upstreamHeaders(target),
      body: JSON.stringify({ ...normalizedPayload, model: upstreamModel }),
      signal,
    });
    const upstreamBytes = Buffer.byteLength(JSON.stringify(normalizedPayload));
    if (!upstream.ok) {
      const raw = await upstream.text();
      // Translate before forwarding: name the failing provider, surface the
      // innermost message, and classify quota exhaustion before the status
      // mapping so a quota 429 does not read as "retry shortly".
      const translated = translateUpstreamError({ provider: target.provider, status: upstream.status, bodyText: redactBearer(raw) });
      const body = JSON.stringify(translated.body);
      if (!res.headersSent) {
        res.statusCode = upstream.status;
        res.setHeader("Content-Type", "application/json");
        res.end(body);
      }
      finish?.({ ok: false, httpStatus: upstream.status, upstream: target.provider, error: translated.body.error.message.slice(0, 400) });
      metrics?.recordResponseTransform?.({
        blocked: { tool_search: stripped.toolSearch, web_search: stripped.webSearch },
        toolChoiceRewritten: false,
        imageRefs: [],
        directVision: route.directVision,
        droppedAssistantMessages: 0,
        nativeToolCalls: 0,
        nativeToolOutputs: 0,
        fallbackToolResults: 0,
      }, { streaming: false, routeReason: route.reason });
      return { ok: false, httpStatus: upstream.status, route, error: translated.body.error.message.slice(0, 400), upstreamBytes };
    }

    if (!res.headersSent) {
      res.statusCode = upstream.status;
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.flushHeaders();
    }
    bytesOut = await pipeGatewayStream(upstream.body, res, tee);
    if (completedResponse && routeAffinity) {
      routeAffinity.registerResponse(completedResponse, route.model);
    }
    // inputTokens/outputTokens ride on the trace record: the dashboard's
    // context-token waveform plots recent[].inputTokens per completed call.
    finish?.({
      ok: true,
      httpStatus: upstream.status,
      upstream: target.provider,
      bytesOut,
      inputTokens: usage?.input_tokens || 0,
      outputTokens: usage?.output_tokens || 0,
    });
    metrics?.recordResponseTransform?.({
      blocked: { tool_search: stripped.toolSearch, web_search: stripped.webSearch },
      toolChoiceRewritten: false,
      imageRefs: [],
      directVision: route.directVision,
      droppedAssistantMessages: 0,
      nativeToolCalls: 0,
      nativeToolOutputs: 0,
      fallbackToolResults: 0,
    }, { streaming: true, routeReason: route.reason });
    metrics?.recordResponseUsage?.({ bytesOut, usage });
    // Injectable so unit tests do not append to the real ~/.modeldock file.
    (services.recordUsage || recordUsageEvent)({
      model: normalizedPayload.model,
      provider: target.provider,
      route: route.reason,
      status: upstream.status,
      durationMs: Date.now() - startedAt,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      totalTokens: usage?.total_tokens,
    });
    return {
      ok: true,
      httpStatus: upstream.status,
      route,
      usage,
      bytesOut,
      upstreamBytes,
      latencyMs: Date.now() - startedAt,
      upstream: target.provider,
    };
  } catch (error) {
    finish?.({ ok: false, error: error.message });
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { type: "upstream_failed", message: redactBearer(error.message) } }));
    } else {
      res.destroy();
    }
    return { ok: false, httpStatus: 502, route, error: error.message };
  }
}

function upstreamHeaders(target) {
  const headers = {
    Authorization: `Bearer ${target.token}`,
    "Content-Type": "application/json",
    "User-Agent": "modeldock-gateway/0.1",
  };
  return headers;
}
