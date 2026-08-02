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
    const itemId = sourceItem.id || `${sourceItem.type || "item"}_${response.id || "response"}_${index}`;
    const item = {
      ...sourceItem,
      id: itemId,
      ...(sourceItem.type === "function_call" && !sourceItem.call_id ? { call_id: `call_${response.id || "response"}_${index}` } : {}),
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

export function responseToSse(source, requestPayload = {}) {
  const response = adaptGoResponse(source, requestPayload);
  const chunks = [];
  let sequence = 0;
  const emit = (type, fields) => {
    chunks.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields, sequence_number: sequence++ })}\n\n`);
  };

  const created = { ...response, status: "in_progress", completed_at: null, output: [], usage: null };
  emit("response.created", { response: created });
  emit("response.in_progress", { response: created });

  response.output.forEach((item, outputIndex) => {
    if (item.type === "message") {
      const added = { ...item, status: "in_progress", content: [] };
      emit("response.output_item.added", { output_index: outputIndex, item: added });
      const completedContent = [];
      (item.content || []).forEach((part, contentIndex) => {
        if (part.type !== "output_text") {
          completedContent.push(part);
          return;
        }
        const emptyPart = { type: "output_text", text: "", annotations: [] };
        const donePart = { ...part, annotations: part.annotations || [] };
        emit("response.content_part.added", {
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          part: emptyPart,
        });
        if (part.text) {
          emit("response.output_text.delta", {
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            delta: part.text,
            logprobs: [],
          });
        }
        emit("response.output_text.done", {
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          text: part.text || "",
          logprobs: [],
        });
        emit("response.content_part.done", {
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          part: donePart,
        });
        completedContent.push(donePart);
      });
      emit("response.output_item.done", {
        output_index: outputIndex,
        item: { ...item, status: "completed", content: completedContent },
      });
      return;
    }

    if (item.type === "function_call") {
      emit("response.output_item.added", {
        output_index: outputIndex,
        item: { ...item, status: "in_progress", arguments: "" },
      });
      if (item.arguments) {
        emit("response.function_call_arguments.delta", {
          item_id: item.id,
          output_index: outputIndex,
          delta: item.arguments,
        });
      }
      emit("response.function_call_arguments.done", {
        item_id: item.id,
        output_index: outputIndex,
        name: item.name,
        arguments: item.arguments || "",
      });
      emit("response.output_item.done", { output_index: outputIndex, item: { ...item, status: "completed" } });
      return;
    }

    if (item.type === "custom_tool_call") {
      emit("response.output_item.added", {
        output_index: outputIndex,
        item: { ...item, status: "in_progress", input: "" },
      });
      if (item.input) {
        emit("response.custom_tool_call_input.delta", {
          item_id: item.id,
          output_index: outputIndex,
          delta: item.input,
        });
      }
      emit("response.custom_tool_call_input.done", {
        item_id: item.id,
        output_index: outputIndex,
        input: item.input || "",
      });
      emit("response.output_item.done", { output_index: outputIndex, item: { ...item, status: "completed" } });
      return;
    }

    emit("response.output_item.added", { output_index: outputIndex, item });
    emit("response.output_item.done", { output_index: outputIndex, item });
  });

  emit("response.completed", { response });
  chunks.push("data: [DONE]\n\n");
  return chunks.join("");
}
