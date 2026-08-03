import { randomUUID } from "node:crypto";
import { adaptGoResponse } from "./responses-sse.mjs";

export async function* parseSse(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const separator = buffer.match(/\r?\n\r?\n/);
      if (!separator) break;
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      const event = block.match(/(?:^|\n)event:\s*([^\r\n]+)/)?.[1]?.trim() || "message";
      const data = [...block.matchAll(/(?:^|\n)data:\s*([^\r\n]*)/g)].map((match) => match[1]).join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        yield { event, data: JSON.parse(data) };
      } catch {
        // Ignore provider comments, heartbeat fragments, and malformed optional events.
      }
    }
  }
}

function baseResponse(id, payload, status, output, usage = null) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1_000),
    completed_at: status === "completed" ? Math.floor(Date.now() / 1_000) : null,
    status,
    error: null,
    incomplete_details: null,
    instructions: payload.instructions ?? null,
    max_output_tokens: payload.max_output_tokens ?? null,
    model: payload.model,
    output,
    parallel_tool_calls: false,
    previous_response_id: payload.previous_response_id ?? null,
    reasoning: payload.reasoning ?? null,
    store: payload.store ?? true,
    temperature: payload.temperature ?? null,
    text: payload.text ?? { format: { type: "text" } },
    tool_choice: payload.tool_choice ?? "auto",
    tools: (payload.tools ?? []).filter((tool) => tool?.name !== "harness_web_search" && tool?.name !== "harness_vision_inspect"),
    top_p: payload.top_p ?? null,
    truncation: payload.truncation ?? "disabled",
    usage,
    metadata: payload.metadata ?? {},
  };
}

export class LiveResponsesWriter {
  constructor(res, payload) {
    this.res = res;
    this.payload = payload;
    this.responseId = `resp_${randomUUID().replace(/-/g, "")}`;
    this.sequence = 0;
    this.started = false;
    this.bytes = 0;
    this.output = [];
    this.nextOutputIndex = 0;
    this.message = null;
    this.call = null;
  }

  #emit(type, fields) {
    const chunk = `event: ${type}\ndata: ${JSON.stringify({ type, ...fields, sequence_number: this.sequence++ })}\n\n`;
    this.bytes += Buffer.byteLength(chunk);
    this.res.write(chunk);
  }

  start() {
    if (this.started) return;
    this.started = true;
    const response = baseResponse(this.responseId, this.payload, "in_progress", []);
    this.#emit("response.created", { response });
    this.#emit("response.in_progress", { response });
  }

  textDelta(delta) {
    this.start();
    if (!this.message) {
      const id = `msg_${randomUUID().replace(/-/g, "")}`;
      const index = this.nextOutputIndex++;
      this.message = { id, index, type: "message", role: "assistant", status: "in_progress", content: [], text: "" };
      this.#emit("response.output_item.added", {
        output_index: index,
        item: { id, type: "message", role: "assistant", status: "in_progress", content: [] },
      });
      this.#emit("response.content_part.added", {
        item_id: id,
        output_index: index,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    this.message.text += delta;
    this.#emit("response.output_text.delta", {
      item_id: this.message.id,
      output_index: this.message.index,
      content_index: 0,
      delta,
      logprobs: [],
    });
  }

  functionAdded(source) {
    this.start();
    const index = this.nextOutputIndex++;
    const item = {
      id: source.id || `fc_${randomUUID().replace(/-/g, "")}`,
      type: "function_call",
      name: source.name,
      call_id: source.call_id || source.id || `call_${randomUUID().replace(/-/g, "")}`,
      arguments: "",
      status: "in_progress",
    };
    this.call = { item, index, custom: false };
    this.#emit("response.output_item.added", { output_index: index, item });
  }

  functionDelta(delta) {
    if (!this.call) return;
    this.call.item.arguments += delta;
    this.#emit("response.function_call_arguments.delta", {
      item_id: this.call.item.id,
      output_index: this.call.index,
      delta,
    });
  }

  customFunctionAdded(source) {
    this.start();
    const adapted = adaptGoResponse(
      { id: this.responseId, output: [{ ...source, type: "function_call", arguments: "" }] },
      this.payload,
    ).output[0];
    const index = this.nextOutputIndex++;
    const item = { ...adapted, status: "in_progress", input: "" };
    this.call = { source, item, index, custom: true, completed: false };
    this.#emit("response.output_item.added", { output_index: index, item });
  }

  customFunction(source, argumentsText) {
    if (!this.call?.custom) this.customFunctionAdded(source);
    const { index } = this.call;
    const adapted = adaptGoResponse(
      { id: this.responseId, output: [{ ...source, type: "function_call", arguments: argumentsText }] },
      this.payload,
    ).output[0];
    if (adapted.input) this.#emit("response.custom_tool_call_input.delta", { item_id: adapted.id, output_index: index, delta: adapted.input });
    this.#emit("response.custom_tool_call_input.done", { item_id: adapted.id, output_index: index, input: adapted.input || "" });
    this.call.completedItem = { ...adapted, status: "completed" };
  }

  finish(usage) {
    this.start();
    if (this.message) {
      const index = this.message.index;
      const part = { type: "output_text", text: this.message.text, annotations: [] };
      this.#emit("response.output_text.done", {
        item_id: this.message.id,
        output_index: index,
        content_index: 0,
        text: this.message.text,
        logprobs: [],
      });
      this.#emit("response.content_part.done", { item_id: this.message.id, output_index: index, content_index: 0, part });
      const completed = { id: this.message.id, type: "message", role: "assistant", status: "completed", content: [part] };
      this.#emit("response.output_item.done", { output_index: index, item: completed });
      this.output[index] = completed;
    }
    if (this.call) {
      const { item, index } = this.call;
      let completed = this.call.completedItem;
      if (!completed) {
        this.#emit("response.function_call_arguments.done", {
          item_id: item.id,
          output_index: index,
          name: item.name,
          arguments: item.arguments,
        });
        completed = { ...item, status: "completed" };
      }
      this.#emit("response.output_item.done", { output_index: index, item: completed });
      this.output[index] = completed;
    }
    const response = baseResponse(this.responseId, this.payload, "completed", this.output.filter(Boolean), usage);
    this.#emit("response.completed", { response });
    const done = "data: [DONE]\n\n";
    this.bytes += Buffer.byteLength(done);
    this.res.end(done);
    return response;
  }
}
