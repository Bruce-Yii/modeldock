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

// A web stream that enqueues a buffer then dies with a transport error.
// The error is deferred so the enqueued data is consumed first, like a real
// connection that delivers bytes and then resets.
function truncatedStream(chunk, error = new Error("upstream connection reset")) {
  return new ReadableStream({
    start(controller) {
      if (chunk) controller.enqueue(Buffer.from(chunk));
      setTimeout(() => controller.error(error), 10);
    },
  });
}

test("upstream stream error synthesizes response.incomplete, never completed", async () => {
  const state = new SseCompatState();
  const res = { write: () => true, end: () => {}, once: () => res, on: () => res, removeListener: () => res };
  const chunks = [];
  res.write = (chunk) => { chunks.push(Buffer.from(chunk).toString("utf8")); return true; };
  const body = truncatedStream(`event: response.output_text.delta\r\ndata: ${JSON.stringify({
    type: "response.output_text.delta", item_id: "i1", output_index: 0, content_index: 0, delta: "hi",
  })}\r\n\r\n`);
  const result = await pipeCompatStream(body, res, null, null, state);
  const types = parseSse(chunks.join("")).map((e) => e.type);
  assert.equal(result.truncated, true, "truncated flagged for the caller");
  assert.equal(result.interrupted, false, "not a client abort");
  assert.ok(types.includes("response.incomplete"), "incomplete synthesized");
  assert.ok(!types.includes("response.completed"), "never a fake completed");
  const inc = parseSse(chunks.join("")).find((e) => e.type === "response.incomplete");
  assert.equal(inc.response.status, "incomplete");
  assert.deepEqual(inc.response.incomplete_details, { reason: "adapter_eof" });
  const added = types.indexOf("response.output_item.added");
  const done = types.indexOf("response.output_item.done");
  const incomplete = types.indexOf("response.incomplete");
  assert.ok(added >= 0 && done > added && incomplete > done, `open item closed before terminal: ${types.join(",")}`);
});

test("upstream error after a terminal completed stays a completed turn", async () => {
  const state = new SseCompatState();
  const res = { write: () => true, end: () => {}, once: () => res, on: () => res, removeListener: () => res };
  const chunks = [];
  res.write = (chunk) => { chunks.push(Buffer.from(chunk).toString("utf8")); return true; };
  const completed = `event: response.completed\r\ndata: ${JSON.stringify({
    type: "response.completed", response: { id: "r1", status: "completed", output: [] },
  })}\r\n\r\n`;
  const result = await pipeCompatStream(truncatedStream(completed), res, null, null, state);
  const types = parseSse(chunks.join("")).map((e) => e.type);
  assert.equal(result.truncated, false, "a late teardown error after the terminal is not a truncation");
  assert.ok(types.includes("response.completed"), "original completed preserved");
  assert.ok(!types.includes("response.incomplete"), "no second terminal event");
});

test("upstream error with zero events still ends with response.incomplete", async () => {
  const state = new SseCompatState();
  const res = { write: () => true, end: () => {}, once: () => res, on: () => res, removeListener: () => res };
  const chunks = [];
  res.write = (chunk) => { chunks.push(Buffer.from(chunk).toString("utf8")); return true; };
  const result = await pipeCompatStream(truncatedStream(null), res, null, null, state);
  const parsed = parseSse(chunks.join(""));
  const types = parsed.map((e) => e.type);
  assert.equal(result.truncated, true);
  assert.ok(types.includes("response.created"), "response envelope synthesized for the incomplete");
  assert.ok(types.includes("response.incomplete"), "incomplete synthesized without any event");
});

test("client abort marks the stream interrupted without writing a terminal", async () => {
  const state = new SseCompatState();
  const chunks = [];
  const onceHandlers = {};
  const res = {
    write: (chunk) => { chunks.push(Buffer.from(chunk).toString("utf8")); return true; },
    end: () => {},
    on: () => res,
    once: (ev, fn) => { (onceHandlers[ev] ??= []).push(fn); return res; },
    removeListener: () => res,
  };
  const fireClose = () => { for (const fn of onceHandlers.close ?? []) fn(); };
  // An upstream that keeps producing: the client disconnects before it ends.
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(`event: response.output_text.delta\r\ndata: ${JSON.stringify({
        type: "response.output_text.delta", item_id: "i1", output_index: 0, content_index: 0, delta: "hi",
      })}\r\n\r\n`));
    },
  });
  const pending = pipeCompatStream(body, res, null, null, state);
  fireClose();
  const result = await pending;
  assert.equal(result.interrupted, true, "client abort flagged");
  assert.equal(result.truncated, false, "not an upstream truncation");
  const text = chunks.join("");
  assert.ok(!text.includes("response.incomplete"), "no terminal written to a gone client");
  assert.ok(!text.includes("response.completed"), "no terminal written to a gone client");
});

test("silent upstream past the stall window ends with response.failed (upstream_stall_timeout)", async () => {
  const state = new SseCompatState();
  const res = { write: () => true, end: () => {}, once: () => res, on: () => res, removeListener: () => res };
  const chunks = [];
  res.write = (chunk) => { chunks.push(Buffer.from(chunk).toString("utf8")); return true; };
  // A stream that stays open forever without emitting anything.
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(`event: response.created\r\ndata: ${JSON.stringify({
        type: "response.created", response: { id: "r1", status: "in_progress" },
      })}\r\n\r\n`));
    },
  });
  const result = await pipeCompatStream(body, res, null, null, state, { stallTimeoutMs: 150 });
  const parsed = parseSse(chunks.join(""));
  const failed = parsed.find((e) => e.type === "response.failed");
  assert.equal(result.stalled, true, "stall flagged");
  assert.equal(result.truncated, true, "stall counts as a truncated turn");
  assert.ok(failed, "response.failed synthesized");
  assert.equal(failed.response.status, "failed");
  assert.equal(failed.response.error.code, "upstream_stall_timeout");
});

test("upstream data resets the stall timer", async () => {
  const state = new SseCompatState();
  const res = { write: () => true, end: () => {}, once: () => res, on: () => res, removeListener: () => res };
  const chunks = [];
  res.write = (chunk) => { chunks.push(Buffer.from(chunk).toString("utf8")); return true; };
  const delta = (text) => `event: response.output_text.delta\r\ndata: ${JSON.stringify({
    type: "response.output_text.delta", item_id: "i1", output_index: 0, content_index: 0, delta: text,
  })}\r\n\r\n`;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(delta("a")));
      setTimeout(() => controller.enqueue(Buffer.from(delta("b"))), 120);
      setTimeout(() => controller.close(), 240);
    },
  });
  // 200ms window: data at 0ms and 120ms keeps resetting it, so no stall fires.
  const result = await pipeCompatStream(body, res, null, null, state, { stallTimeoutMs: 200 });
  const parsed = parseSse(chunks.join(""));
  assert.equal(result.stalled, false, "no stall while data flows");
  assert.ok(parsed.some((e) => e.type === "response.completed"), "stream completed normally");
  assert.ok(!parsed.some((e) => e.type === "response.failed"), "no failed event");
});

test("stallTimeoutMs 0 disables the stall safety net", async () => {
  const state = new SseCompatState();
  const chunks = [];
  const onceHandlers = {};
  const res = {
    write: (chunk) => { chunks.push(Buffer.from(chunk).toString("utf8")); return true; },
    end: () => {},
    on: () => res,
    once: (ev, fn) => { (onceHandlers[ev] ??= []).push(fn); return res; },
    removeListener: () => res,
  };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(`event: response.created\r\ndata: ${JSON.stringify({
        type: "response.created", response: { id: "r1", status: "in_progress" },
      })}\r\n\r\n`));
    },
  });
  // Never closes, but no timer is armed: the promise would only settle on
  // res close, so simulate the client abort after a short wait.
  const pending = pipeCompatStream(body, res, null, null, state, { stallTimeoutMs: 0 });
  await new Promise((r) => setTimeout(r, 120));
  for (const fn of onceHandlers.close ?? []) fn();
  const result = await pending;
  assert.equal(result.stalled, false, "no stall timer armed");
  assert.equal(result.interrupted, true, "only the client abort settled the stream");
});

test("function_call done with empty arguments is normalized to {}", async () => {
  const state = new SseCompatState();
  const res = { write: () => true, end: () => {}, once: () => res, on: () => res, removeListener: () => res };
  const chunks = [];
  res.write = (chunk) => { chunks.push(Buffer.from(chunk).toString("utf8")); return true; };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { id: "fc1", type: "function_call", name: "shell_command", arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", item_id: "fc1", output_index: 0, content_index: 0, delta: "" },
    { type: "response.output_item.done", output_index: 0, item: { id: "fc1", type: "function_call", name: "shell_command", arguments: "", status: "completed" } },
    { type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
  ];
  await pipeCompatStream(ssePayloads(...events), res, null, null, state);
  const done = parseSse(chunks.join("")).find((e) => e.type === "response.output_item.done");
  assert.equal(done.item.type, "function_call");
  assert.equal(done.item.arguments, "{}", "empty arguments normalized");
});

test("function_call done with real arguments is untouched", async () => {
  const state = new SseCompatState();
  const res = { write: () => true, end: () => {}, once: () => res, on: () => res, removeListener: () => res };
  const chunks = [];
  res.write = (chunk) => { chunks.push(Buffer.from(chunk).toString("utf8")); return true; };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { id: "fc1", type: "function_call", name: "shell_command", arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", item_id: "fc1", output_index: 0, content_index: 0, delta: "{\"cmd\":\"ls\"}" },
    { type: "response.output_item.done", output_index: 0, item: { id: "fc1", type: "function_call", name: "shell_command", arguments: "{\"cmd\":\"ls\"}", status: "completed" } },
    { type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
  ];
  await pipeCompatStream(ssePayloads(...events), res, null, null, state);
  const done = parseSse(chunks.join("")).find((e) => e.type === "response.output_item.done");
  assert.equal(done.item.arguments, '{"cmd":"ls"}', "real arguments preserved verbatim");
});

test("clean EOF closes a function_call as completed with {} arguments", async () => {
  const state = new SseCompatState();
  const res = { write: () => true, end: () => {}, once: () => res, on: () => res, removeListener: () => res };
  const chunks = [];
  res.write = (chunk) => { chunks.push(Buffer.from(chunk).toString("utf8")); return true; };
  // Upstream ends cleanly right after the arguments delta, without a done event.
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { id: "fc1", type: "function_call", name: "shell_command", arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", item_id: "fc1", output_index: 0, content_index: 0, delta: "" },
  ];
  await pipeCompatStream(ssePayloads(...events), res, null, null, state);
  const done = parseSse(chunks.join("")).find((e) => e.type === "response.output_item.done");
  assert.ok(done, "synthesized done on clean EOF");
  assert.equal(done.item.status, "completed");
  assert.equal(done.item.arguments, "{}", "empty arguments normalized on the clean path");
});

test("interrupted stream closes a function_call as incomplete without normalization", async () => {
  const state = new SseCompatState();
  const res = { write: () => true, end: () => {}, once: () => res, on: () => res, removeListener: () => res };
  const chunks = [];
  res.write = (chunk) => { chunks.push(Buffer.from(chunk).toString("utf8")); return true; };
  const delta = (text) => `event: response.output_text.delta\r\ndata: ${JSON.stringify({
    type: "response.output_text.delta", item_id: "i1", output_index: 0, content_index: 0, delta: text,
  })}\r\n\r\n`;
  const fcDelta = `event: response.function_call_arguments.delta\r\ndata: ${JSON.stringify({
    type: "response.function_call_arguments.delta", item_id: "fc1", output_index: 1, content_index: 0, delta: "{\"cmd\":\"rm",
  })}\r\n\r\n`;
  // Message item then an interrupted function call: the error path must close
  // the call as incomplete (never a real invocation) and leave args untouched.
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(delta("thinking...")));
      controller.enqueue(Buffer.from(fcDelta));
      setTimeout(() => controller.error(new Error("reset")), 10);
    },
  });
  const result = await pipeCompatStream(body, res, null, null, state);
  const parsed = parseSse(chunks.join(""));
  const done = parsed.filter((e) => e.type === "response.output_item.done");
  assert.equal(result.truncated, true);
  assert.ok(parsed.some((e) => e.type === "response.incomplete"), "terminal is incomplete");
  const fcDone = done.find((e) => e.item.type === "function_call");
  assert.ok(fcDone, "function_call closed");
  assert.equal(fcDone.item.status, "incomplete", "truncated call never looks completed");
  assert.equal(fcDone.item.arguments, undefined, "no empty-arguments normalization on interruption");
});
