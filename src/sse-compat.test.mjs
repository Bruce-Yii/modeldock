import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { SseCompatState, pipeCompatStream, normalizeAssistantContent, synthesizeEvent } from "./sse-compat.mjs";

function ssePayloads(...types) {
  // Build an SSE byte stream from event payload objects.
  const chunks = types
    .filter(Boolean)
    .map((obj) => `event: ${obj.type}\r\ndata: ${JSON.stringify(obj)}\r\n\r\n`)
    .join("");
  return Readable.toWeb(Readable.from([Buffer.from(chunks)]));
}

function collect(res) {
  const chunks = [];
  res.write = (chunk) => {
    chunks.push(Buffer.from(chunk).toString("utf8"));
    return true;
  };
  res.end = () => {};
  res.on = () => res;
  res.once = () => res;
  res.removeListener = () => res;
  return chunks;
}

function parseSse(text) {
  return text.split("\r\n\r\n").filter(Boolean).map((block) => {
    const data = block.split("\r\n").find((l) => l.startsWith("data:"));
    return data ? JSON.parse(data.slice(5)) : null;
  }).filter(Boolean);
}

test("full lifecycle stream passes through untouched (no synthesis)", async () => {
  const state = new SseCompatState();
  const res = { write: () => true, end: () => {}, once: () => res, on: () => res, removeListener: () => res };
  const chunks = [];
  res.write = (chunk) => { chunks.push(Buffer.from(chunk).toString("utf8")); return true; };
  const events = [
    { type: "response.created", response: { id: "r1", status: "in_progress" } },
    { type: "response.in_progress", response: { id: "r1" } },
    { type: "response.output_item.added", output_index: 0, item: { id: "i1", type: "message", role: "assistant", status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: "i1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", item_id: "i1", output_index: 0, content_index: 0, delta: "hi" },
    { type: "response.content_part.done", item_id: "i1", output_index: 0, content_index: 0, part: { type: "output_text", text: "hi" } },
    { type: "response.output_item.done", output_index: 0, item: { id: "i1", type: "message", status: "completed", content: [] } },
    { type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
  ];
  await pipeCompatStream(ssePayloads(...events), res, null, null, state);
  const text = chunks.join("");
  const parsed = parseSse(text);
  assert.deepEqual(parsed.map((e) => e.type), events.map((e) => e.type), "no synthesized events for a complete stream");
});

test("delta without item synthesizes output_item.added and content_part.added", async () => {
  const state = new SseCompatState();
  const res = { write: () => true, end: () => {}, once: () => res, on: () => res, removeListener: () => res };
  const chunks = [];
  res.write = (chunk) => { chunks.push(Buffer.from(chunk).toString("utf8")); return true; };
  const events = [
    { type: "response.created", response: { id: "r1", status: "in_progress" } },
    { type: "response.output_text.delta", item_id: "i1", output_index: 0, content_index: 0, delta: "hi" },
    { type: "response.output_text.delta", item_id: "i1", output_index: 0, content_index: 0, delta: " there" },
    { type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
  ];
  await pipeCompatStream(ssePayloads(...events), res, null, null, state);
  const parsed = parseSse(chunks.join(""));
  const types = parsed.map((e) => e.type);
  assert.ok(types.includes("response.output_item.added"), "synthesized item for the orphan delta");
  assert.ok(types.includes("response.content_part.added"), "synthesized part for the orphan delta");
  const added = parsed.find((e) => e.type === "response.output_item.added");
  assert.equal(added.item.id, "i1", "kept the upstream item id");
  const deltas = parsed.filter((e) => e.type === "response.output_text.delta");
  assert.equal(deltas.length, 2, "all original deltas preserved verbatim");
  assert.equal(deltas.map((d) => d.delta).join(""), "hi there", "content untouched");
});

test("missing response.completed is synthesized at stream end", async () => {
  const state = new SseCompatState();
  const res = { write: () => true, end: () => {}, once: () => res, on: () => res, removeListener: () => res };
  const chunks = [];
  res.write = (chunk) => { chunks.push(Buffer.from(chunk).toString("utf8")); return true; };
  const events = [
    { type: "response.output_text.delta", item_id: "i1", output_index: 0, content_index: 0, delta: "hi" },
  ];
  await pipeCompatStream(ssePayloads(...events), res, null, null, state);
  const parsed = parseSse(chunks.join(""));
  const types = parsed.map((e) => e.type);
  assert.ok(types.includes("response.created"), "created synthesized before delta");
  assert.ok(types.includes("response.completed"), "terminal completed synthesized");
  const completed = parsed.find((e) => e.type === "response.completed");
  assert.equal(completed.response.status, "completed");
});

test("open item is closed before a synthesized completed", async () => {
  const state = new SseCompatState();
  const res = { write: () => true, end: () => {}, once: () => res, on: () => res, removeListener: () => res };
  const chunks = [];
  res.write = (chunk) => { chunks.push(Buffer.from(chunk).toString("utf8")); return true; };
  await pipeCompatStream(ssePayloads(
    { type: "response.output_text.delta", item_id: "i1", output_index: 0, content_index: 0, delta: "x" },
  ), res, null, null, state);
  const types = parseSse(chunks.join("")).map((e) => e.type);
  const added = types.indexOf("response.output_item.added");
  const done = types.indexOf("response.output_item.done");
  const completed = types.indexOf("response.completed");
  assert.ok(added >= 0 && done > added && completed > done, `lifecycle order: ${types.join(",")}`);
});

test("normalizeAssistantContent rewrites only assistant output_text arrays", () => {
  const input = [
    { role: "user", content: [{ type: "input_text", text: "hi" }] },
    { role: "assistant", content: [{ type: "output_text", text: "hello" }, { type: "output_text", text: " world" }] },
    { role: "assistant", content: [{ type: "reasoning", text: "think" }] },
    { role: "assistant", content: "plain string" },
  ];
  const out = normalizeAssistantContent(input);
  assert.equal(out[1].content, "hello world", "array content flattened to string");
  assert.ok(Array.isArray(out[2].content), "non-output_text arrays untouched");
  assert.equal(out[3].content, "plain string", "string content untouched");
  assert.equal(out[0].content[0].type, "input_text", "user messages untouched");
  assert.equal(normalizeAssistantContent(null), null);
  assert.equal(normalizeAssistantContent("nope"), "nope");
});

test("synthesizeEvent emits the SSE framing", () => {
  const ev = synthesizeEvent("response.completed", { type: "response.completed" });
  assert.match(ev, /^event: response\.completed\r\ndata: /);
  assert.match(ev, /\r\n\r\n$/);
});
