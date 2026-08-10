// SSE compatibility layer for upstreams whose Responses streaming is incomplete.
//
// opencode-go's Responses adapters only stream a full lifecycle for a few models
// (deepseek-v4-flash, grok-4.5). Most others emit only `output_text.delta` and
// `response.completed` (glm/kimi/...), or miss `response.completed` entirely
// (glm-5.1), which makes the Codex client report "OutputTextDelta without active
// item" / "stream disconnected" while the gateway already returned 200.
//
// This module wraps the upstream byte stream and, when an event arrives without
// its required lifecycle parent, synthesizes the missing events *around* the
// original payloads. Delta content is never rewritten; only the envelope
// (response.created / in_progress / output_item.added / content_part.added /
// output_item.done / content_part.done / response.completed) is completed. For
// fully-streaming upstreams every event already has its parent, so nothing is
// synthesized and the stream passes through untouched.
import { Readable } from "node:stream";

export function synthesizeEvent(eventName, data) {
  return `event: ${eventName}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
}

// Some opencode-go models (mimo/kimi-k3/k2.7-code/deepseek-v4-pro) reject
// assistant history whose content is the array shape Codex sends, answering 400
// "Provider returned error". The string shape is the accepted dialect (verified
// live 2026-08-09: identical history with string content returns 200). Only
// rewrites `assistant` role entries that carry output_text parts; unknown part
// shapes are left untouched rather than losing data.
export function normalizeAssistantContent(input) {
  if (!Array.isArray(input)) return input;
  return input.map((item) => {
    if (item?.role !== "assistant" || !Array.isArray(item?.content)) return item;
    const textParts = item.content.filter((part) => part?.type === "output_text");
    if (textParts.length === 0) return item;
    return { ...item, content: textParts.map((part) => part?.text || "").join("") };
  });
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// Track which lifecycle parents are missing and synthesize them around the
// incoming stream. Feed complete SSE blocks (JSON `data:` payloads) one at a
// time; `flush()` emits the synthesized completion when the upstream ends
// without one.
export class SseCompatState {
  constructor({ synthesizeId = randomId } = {}) {
    this.id = synthesizeId;
    this.created = false;
    this.inProgress = false;
    this.completed = false;
    this.responseId = "";
    this.outputIndex = -1;
    this.openItem = null; // { id, type, announced }
    this.openPart = null; // { announced, index }
    this.sawOutputEvent = false;
  }

  // Returns an array of synthesized SSE event strings that must precede the
  // given parsed event (may be empty).
  before(parsed) {
    const kind = parsed?.type;
    const out = [];
    if (kind === "response.created") {
      this.created = true;
      this.inProgress = false;
      this.responseId = parsed?.response?.id || this.responseId;
      return out;
    }
    // Every downstream event needs the response envelope first (created /
    // in_progress) or the Codex client treats the stream as malformed.
    out.push(...this.ensureCreated());
    if (kind === "response.in_progress") {
      this.inProgress = true;
      return out;
    }
    out.push(...this.ensureInProgress());
    if (kind === "response.output_item.added") {
      this.openItem = { id: parsed?.item?.id || "", type: parsed?.item?.type || "message", announced: true };
      this.outputIndex = typeof parsed?.output_index === "number" ? parsed.output_index : this.outputIndex + 1;
      this.openPart = null;
      return out;
    }
    if (kind === "response.content_part.added") {
      if (!this.openItem?.announced) {
        // Parent item missing: synthesize it around the part.
        out.push(...this.synthesizeItem("message", parsed?.item_id || this.id("item"), this.outputIndex));
      }
      this.openPart = { announced: true, index: typeof parsed?.content_index === "number" ? parsed.content_index : 0 };
      return out;
    }
    if (
      kind === "response.output_text.delta"
      || kind === "response.reasoning_text.delta"
      || kind === "response.reasoning_summary_part.delta"
      || kind === "response.function_call_arguments.delta"
    ) {
      this.sawOutputEvent = true;
      out.push(...this.ensureItem(kind, parsed?.item_id));
      out.push(...this.ensurePart(kind, parsed?.content_index));
      return out;
    }
    if (kind === "response.output_text.done") {
      this.sawOutputEvent = true;
      out.push(...this.ensureItem(kind, parsed?.item_id));
      out.push(...this.ensurePart(kind, parsed?.content_index));
      return out;
    }
    if (kind === "response.content_part.done") {
      this.openPart = null;
      return out;
    }
    if (kind === "response.output_item.done") {
      if (!this.openItem?.announced) {
        // done without its added parent (some upstreams emit only the terminal
        // item): synthesize the parent from the done payload so the client never
        // sees a reference to an item it was never told about.
        const item = parsed?.item;
        if (item && typeof item === "object") {
          this.outputIndex = typeof parsed?.output_index === "number" ? parsed.output_index : this.outputIndex + 1;
          this.openItem = { id: item.id || this.id("item"), type: item.type || "message", announced: true };
          out.push(synthesizeEvent("response.output_item.added", {
            type: "response.output_item.added",
            output_index: this.outputIndex,
            item: { ...item, status: "in_progress" },
          }));
        }
      }
      this.openItem = null;
      this.openPart = null;
      return out;
    }
    if (kind === "response.completed" || kind === "response.failed") {
      out.push(...this.closeOpenParts());
      out.push(...this.closeOpenItems());
      this.completed = true;
      return out;
    }
    return out;
  }

  ensureCreated() {
    if (this.created) return [];
    this.created = true;
    this.responseId = this.id("resp");
    return [synthesizeEvent("response.created", {
      type: "response.created",
      response: { id: this.responseId, object: "response", status: "in_progress" },
    })];
  }

  ensureInProgress() {
    if (this.inProgress) return [];
    this.inProgress = true;
    return [synthesizeEvent("response.in_progress", {
      type: "response.in_progress",
      response: { id: this.responseId || this.id("resp"), object: "response", status: "in_progress" },
    })];
  }

  ensureItem(kind, hintedId) {
    if (this.openItem?.announced) return [];
    const type = kind === "response.function_call_arguments.delta" ? "function_call" : "message";
    const id = hintedId || this.id("item");
    return this.synthesizeItem(type, id, this.outputIndex);
  }

  ensurePart(kind, hintedIndex) {
    if (this.openPart?.announced) return [];
    const type = kind.startsWith("response.reasoning") ? "reasoning" : "output_text";
    const index = typeof hintedIndex === "number" ? hintedIndex : 0;
    const itemId = this.openItem?.id || "";
    this.openPart = { announced: true, index };
    return [synthesizeEvent("response.content_part.added", {
      type: "response.content_part.added",
      item_id: itemId,
      output_index: this.outputIndex,
      content_index: index,
      part: { type, text: "" },
    })];
  }

  synthesizeItem(type, id, outputIndex) {
    const index = typeof outputIndex === "number" ? outputIndex : this.outputIndex + 1;
    this.outputIndex = index;
    const item = { id, type, role: type === "message" ? "assistant" : undefined, status: "in_progress" };
    if (type === "message") item.content = [];
    if (type === "reasoning") item.summary = [];
    this.openItem = { id, type, announced: true };
    return [
      synthesizeEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: index,
        item,
      }),
    ];
  }

  closeOpenParts() {
    if (!this.openPart?.announced) return [];
    const index = this.openPart.index ?? 0;
    this.openPart = null;
    const itemId = this.openItem?.id || "";
    return [synthesizeEvent("response.content_part.done", {
      type: "response.content_part.done",
      item_id: itemId,
      output_index: this.outputIndex,
      content_index: index,
      part: { type: "output_text", text: "" },
    })];
  }

  closeOpenItems() {
    if (!this.openItem?.announced) return [];
    const item = {
      id: this.openItem.id,
      type: this.openItem.type,
      role: this.openItem.type === "message" ? "assistant" : undefined,
      status: "completed",
      content: this.openItem.type === "message" ? [] : undefined,
    };
    this.openItem = null;
    return [synthesizeEvent("response.output_item.done", {
      type: "response.output_item.done",
      output_index: this.outputIndex,
      item,
    })];
  }

  // Synthesize the missing terminal `response.completed` when the upstream
  // ended without one (glm-5.1 observed to drop it).
  completedEvent() {
    const response = {
      id: this.responseId || this.id("resp"),
      object: "response",
      status: "completed",
      output: [],
    };
    return synthesizeEvent("response.completed", { type: "response.completed", response });
  }

  // Synthesize the terminal for a transport-level interruption (upstream
  // stream error / premature EOF). Unlike completedEvent(), the status is
  // "incomplete" with incomplete_details.reason="adapter_eof" (same shape as
  // opencodex RC1): a stream that ended without a terminal event is a
  // truncated turn, and pretending it finished cleanly is the failure mode.
  incompleteEvent() {
    const response = {
      id: this.responseId || this.id("resp"),
      object: "response",
      status: "incomplete",
      output: [],
      incomplete_details: { reason: "adapter_eof" },
    };
    return synthesizeEvent("response.incomplete", { type: "response.incomplete", response });
  }
}

// Pipe `upstreamBody` to the client, synthesizing missing lifecycle events.
// `tee` still receives every original chunk untouched (usage extraction keeps
// working); only the bytes written to the client are augmented.
//
// Terminal classification uses transport-layer signals only, never the event
// layer: an upstream stream error or a client abort is a truncated stream and
// ends with `response.incomplete` (reason adapter_eof) / `interrupted:true`;
// a clean EOF ends the turn, so a missing `response.completed` is still
// synthesized rather than misreported as a truncation (models that drop the
// terminal envelope, e.g. glm-5.1, must not be flagged as interrupted).
export async function pipeCompatStream(upstreamBody, res, tee, markFirstResponse, state = new SseCompatState()) {
  if (!upstreamBody) {
    res.end();
    return { bytes: 0, interrupted: false, truncated: false, synthesized: 0 };
  }
  let bytes = 0;
  let interrupted = false;
  let truncated = false;
  let synthesized = 0;
  let sseBuffer = "";
  let outStream = null;
  const writeOut = (text) => {
    if (!res.write(text)) outStream?.pause();
  };
  const emit = (events) => {
    for (const ev of events) {
      if (ev) {
        writeOut(ev);
        synthesized += 1;
      }
    }
  };
  const processBlock = (block, delim) => {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      emit(state.before(parsed));
      writeOut(block + delim);
      return;
    }
    writeOut(block + delim);
  };
  const push = (chunk) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    sseBuffer += text;
    while (true) {
      const match = sseBuffer.match(/\r?\n\r?\n/);
      if (!match) break;
      const block = sseBuffer.slice(0, match.index);
      const delim = match[0];
      sseBuffer = sseBuffer.slice(match.index + delim.length);
      processBlock(block, delim);
    }
    if (sseBuffer.length > 1_000_000) sseBuffer = sseBuffer.slice(-500_000);
  };
  await new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(upstreamBody);
    let firstResponseMarked = false;
    outStream = stream;
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    stream.on("data", (chunk) => {
      if (!firstResponseMarked) {
        firstResponseMarked = true;
        markFirstResponse?.();
      }
      tee?.push(chunk);
      push(chunk);
      bytes += chunk.byteLength || Buffer.byteLength(chunk);
    });
    stream.once("end", () => {
      tee?.end?.();
      if (!state.completed && state.sawOutputEvent) {
        emit([...state.closeOpenParts(), ...state.closeOpenItems(), state.completedEvent()]);
      }
      if (sseBuffer) writeOut(sseBuffer);
      res.end();
      settle();
    });
    stream.once("error", () => {
      // Transport-level interruption: the upstream stream died before a
      // terminal event. Synthesize response.incomplete (never completed) so
      // the client sees a truncated turn instead of a clean finish. The error
      // is absorbed here - rejecting would make the caller append a second
      // terminal (response.failed) on top of this one.
      tee?.end?.();
      if (!state.completed) {
        truncated = true;
        // ensureCreated is idempotent: an error before any event still gets
        // the response envelope so the client can attach the incomplete to it.
        emit([...state.ensureCreated(), ...state.closeOpenParts(), ...state.closeOpenItems(), state.incompleteEvent()]);
      }
      try {
        res.end();
      } catch {
        res.destroy();
      }
      settle();
    });
    const onDrain = () => outStream?.resume();
    res.on("drain", onDrain);
    const cleanup = () => res.removeListener("drain", onDrain);
    res.once("finish", () => { cleanup(); settle(); });
    res.once("error", (error) => { cleanup(); settle(error); });
    res.once("close", () => {
      cleanup();
      if (!settled) {
        interrupted = true;
        stream.destroy();
      }
      settle();
    });
  });
  return { bytes, interrupted, truncated, synthesized };
}
