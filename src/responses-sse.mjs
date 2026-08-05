function customInput(argumentsText) {
  try {
    const value = JSON.parse(argumentsText);
    if (!value || typeof value !== "object" || Array.isArray(value)) return argumentsText;
    for (const key of ["input", "patch", "patchText", "text", "command"]) {
      if (typeof value[key] === "string") return value[key];
    }
    const values = Object.values(value);
    if (values.length === 1 && typeof values[0] === "string") return values[0];
  } catch {
    // The provider may already have returned raw custom-tool input.
  }
  return argumentsText;
}

export function adaptGoResponse(response, requestPayload = {}) {
  const customTools = new Set(
    (requestPayload.tools || []).filter((tool) => tool?.type === "custom" && typeof tool.name === "string").map((tool) => tool.name),
  );
  const output = (response.output || []).map((sourceItem, index) => {
    if (!sourceItem || typeof sourceItem !== "object") return sourceItem;
    const generatedId = `${sourceItem.type || "item"}_${response.id || "response"}_${index}`;
    const callId = sourceItem.type === "function_call" ? sourceItem.call_id || sourceItem.id || `call_${response.id || "response"}_${index}` : null;
    const itemId = callId || sourceItem.id || generatedId;
    const item = {
      ...sourceItem,
      id: itemId,
      ...(sourceItem.type === "function_call" ? { call_id: callId } : {}),
    };
    if (item.type !== "function_call" || !customTools.has(item.name)) return item;
    return {
      id: itemId,
      type: "custom_tool_call",
      name: item.name,
      call_id: item.call_id,
      input: customInput(item.arguments || ""),
    };
  });
  const now = Math.floor(Date.now() / 1_000);
  return {
    ...response,
    object: response.object || "response",
    created_at: response.created_at || now,
    completed_at: response.completed_at || now,
    status: response.status || "completed",
    output,
  };
}
