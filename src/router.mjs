function inputItems(input) {
  if (typeof input === "string") return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  return Array.isArray(input) ? input : [];
}

function currentTurnItems(input) {
  const items = inputItems(input);
  let lastAssistant = -1;
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]?.role === "assistant") lastAssistant = index;
  }
  return items.slice(lastAssistant + 1);
}

function parts(item) {
  return Array.isArray(item?.content) ? item.content : [];
}

function hasImage(items) {
  return items.some((item) => parts(item).some((part) => part?.type === "input_image" && typeof part.image_url === "string"));
}

function continuationCallIds(items) {
  return items
    .filter((item) => item?.type === "function_call_output" || item?.type === "custom_tool_call_output")
    .map((item) => item.call_id)
    .filter((callId) => typeof callId === "string" && callId.length > 0);
}

export class RouteAffinity {
  constructor({ ttlMs = 15 * 60_000 } = {}) {
    this.ttlMs = ttlMs;
    this.calls = new Map();
  }

  register(callId, model) {
    if (!callId || !model) return;
    this.calls.set(callId, { model, expiresAt: Date.now() + this.ttlMs });
  }

  registerResponse(response, model) {
    for (const item of response?.output || []) {
      if ((item?.type === "function_call" || item?.type === "custom_tool_call") && item.call_id) {
        this.register(item.call_id, model);
      }
    }
  }

  consumeFrom(items) {
    const now = Date.now();
    for (const [callId, entry] of this.calls) {
      if (entry.expiresAt <= now) this.calls.delete(callId);
    }
    for (const callId of continuationCallIds(items)) {
      const entry = this.calls.get(callId);
      if (!entry) continue;
      this.calls.delete(callId);
      return { callId, model: entry.model };
    }
    return null;
  }

  snapshot() {
    return { activeCallIds: this.calls.size, ttlMs: this.ttlMs };
  }
}

export function routeResponsesRequest(source, { mainModel, visionModel, affinity }) {
  const current = currentTurnItems(source?.input);
  const pinned = affinity?.consumeFrom(current);
  if (pinned) {
    return { model: pinned.model, reason: "luna_tool_continuation", directVision: pinned.model === visionModel, pinnedCallId: pinned.callId };
  }
  if (source?.model === visionModel) {
    return { model: visionModel, reason: "vision_model_requested", directVision: true };
  }
  if (hasImage(current)) {
    return { model: visionModel, reason: "current_turn_image", directVision: true };
  }
  return { model: source?.model || mainModel, reason: "default_main", directVision: false };
}

export const routerInternals = { currentTurnItems, hasImage, continuationCallIds };
