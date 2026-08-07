import { bareModelId, modelEntryFor, providerForModel } from "./profiles.mjs";
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

// Tool policy: keep standard function/custom tools, flatten MCP namespaces so
// text models see plain functions, and strip hosted schemas plus tools the model
// cannot use. Returns the filtered list and a report of what was removed.
export function applyToolPolicy(tools, { hiddenToolNames = TEXT_MODEL_HIDDEN_TOOLS } = {}) {
  if (!Array.isArray(tools)) return { tools, stripped: { hosted: 0, hidden: 0, namespaceChildren: 0 } };
  const hidden = new Set(hiddenToolNames || []);
  const stripped = { hosted: 0, hidden: 0, namespaceChildren: 0 };
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
      stripped.hosted += 1;
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
export async function pipeGatewayStream(upstreamBody, res, tee) {
  if (!upstreamBody) {
    res.end();
    return 0;
  }
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const reader = upstreamBody.getReader();
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            tee?.push(value);
            res.write(value);
            bytes += value.byteLength || Buffer.byteLength(value);
          }
        }
        tee?.end?.();
        res.end();
        settle();
      } catch (error) {
        settle(error);
      }
    };
    pump();
  });
  return bytes;
}

// Relay one Responses request: normalize, route (with image escalation and
// affinity), apply tool policy, choose upstream, forward, pipe, and tee.
// `services` carries { config, metrics, mediaStore, routeAffinity, modelSelection,
// knownModels, visionModelOf } so the caller decides wiring.
export async function relayResponses(payload, res, services, { signal } = {}) {
  const { config, metrics, routeAffinity, knownModels } = services;
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
    input: normalizeGatewayInput(payload.input),
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
      blocked: { tool_search: stripped.hosted, web_search: 0 },
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
      const body = redactBearer(raw);
      if (!res.headersSent) {
        res.statusCode = upstream.status;
        res.setHeader("Content-Type", "application/json");
        res.end(body);
      }
      finish?.({ ok: false, httpStatus: upstream.status, upstream: target.provider, error: body.slice(0, 400) });
      metrics?.recordResponseTransform?.({
        blocked: { tool_search: stripped.hosted, web_search: 0 },
        toolChoiceRewritten: false,
        imageRefs: [],
        directVision: route.directVision,
        droppedAssistantMessages: 0,
        nativeToolCalls: 0,
        nativeToolOutputs: 0,
        fallbackToolResults: 0,
      }, { streaming: false, routeReason: route.reason });
      return { ok: false, httpStatus: upstream.status, route, error: body.slice(0, 400), upstreamBytes };
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
    finish?.({ ok: true, httpStatus: upstream.status, upstream: target.provider, bytesOut });
    metrics?.recordResponseTransform?.({
      blocked: { tool_search: stripped.hosted, web_search: 0 },
      toolChoiceRewritten: false,
      imageRefs: [],
      directVision: route.directVision,
      droppedAssistantMessages: 0,
      nativeToolCalls: 0,
      nativeToolOutputs: 0,
      fallbackToolResults: 0,
    }, { streaming: true, routeReason: route.reason });
    metrics?.recordResponseUsage?.({ bytesOut, usage });
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
