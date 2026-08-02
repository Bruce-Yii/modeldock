const VISUAL_INTENT = [
  /\b(?:look at|inspect|read|analy[sz]e|compare|describe|explain)\b[^\n]{0,48}\b(?:image|picture|photo|screenshot|screen|diagram|chart|graph|ui)\b/i,
  /\b(?:screenshot|screen capture|ocr|visual inspection|pixel-level|button (?:is )?(?:hidden|covered|blocked)|ui (?:layout|screenshot))\b/i,
  /\b(?:what|why|where)\b[^\n]{0,48}\b(?:image|picture|photo|screenshot|diagram|chart|graph)\b/i,
  /(?:看图|看一下图|查看图片|截图|界面截图|屏幕截图|按钮.{0,8}(?:遮挡|盖住|隐藏)|识图|读图|对比图)/,
  /(?:分析|查看|读取|比较|对比|描述).{0,12}(?:图片|图像|图表|截图|界面)/,
  /(?:图片|图像|图表|截图).{0,12}(?:是什么|有什么|哪里|为什么|文字|内容)/,
];

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

function itemText(item) {
  if (typeof item === "string") return item;
  if (typeof item?.content === "string") return item.content;
  return parts(item)
    .filter((part) => part && (part.type === "input_text" || part.type === "text") && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function hasVisualIntent(items) {
  const text = items.filter((item) => typeof item === "string" || item?.role === "user").map(itemText).join("\n");
  return VISUAL_INTENT.some((pattern) => pattern.test(text));
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
  if (hasVisualIntent(current)) {
    return { model: visionModel, reason: "visual_intent", directVision: true };
  }
  return { model: source?.model || mainModel, reason: "default_main", directVision: false };
}

export const routerInternals = { currentTurnItems, hasImage, hasVisualIntent, continuationCallIds };
