import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createMdMemory, clipReasoningHistory } from "./md-memory.mjs";

const tmpSummaries = () => path.join(os.tmpdir(), `md-memory-test-${Math.random().toString(36).slice(2)}.json`);

function longHistory(assistantCount, chars = 2_000) {
  const input = [{ role: "user", content: [{ type: "input_text", text: "the task" }] }];
  for (let i = 0; i < assistantCount; i += 1) {
    input.push({ role: "assistant", content: [{ type: "output_text", text: `step ${i} ${"x".repeat(chars)}` }] });
  }
  return { input, tools: [{ type: "function", name: "shell_command" }] };
}

test("clipReasoningHistory keeps the newest items and reports what it dropped", () => {
  const input = [
    { role: "user", content: [] },
    ...Array.from({ length: 10 }, (_, i) => ({ type: "reasoning", id: `r${i}`, summary: [`t${i}`] })),
  ];
  const { input: kept, dropped } = clipReasoningHistory(input);
  const ids = kept.filter((item) => item.type === "reasoning").map((item) => item.id);
  assert.deepEqual(ids, ["r4", "r5", "r6", "r7", "r8", "r9"]);
  assert.equal(dropped, 4);
  assert.deepEqual(clipReasoningHistory("not an array"), { input: "not an array", dropped: 0 });
});

test("the summary pipeline compacts a long session and pins the summary", async () => {
  const asked = [];
  const memory = createMdMemory({
    summariesFile: tmpSummaries(),
    callModelText: async (key, messages) => { asked.push({ key, messages }); return "GOAL: ship it\nDONE: a lot"; },
  });
  const payload = longHistory(260);
  const before = payload.input.length;
  await memory.run("ses_1", payload);

  assert.equal(asked.length, 1, "the summarizer was asked once");
  assert.ok(payload.input.length < before, "old assistant turns were dropped");
  const summaryItem = payload.input.find((item) => JSON.stringify(item).includes("SESSION SUMMARY"));
  assert.ok(summaryItem, "the summary is pinned into the payload");
  const assistants = payload.input.filter((item) => item.role === "assistant").length;
  assert.equal(assistants, memory.SUMMARY_WINDOW_ITEMS, "the sliding window is exactly the configured size");
  assert.equal(memory.sessionSummaries.get("ses_1")?.text, "GOAL: ship it\nDONE: a lot");
});

test("disabled md_memory leaves the payload untouched and revives nothing", async () => {
  let asked = 0;
  const memory = createMdMemory({
    enabled: false,
    summariesFile: tmpSummaries(),
    callModelText: async () => { asked += 1; return "should never be produced"; },
  });
  const payload = longHistory(260);
  const before = JSON.stringify(payload);
  await memory.run("ses_off", payload);

  assert.equal(asked, 0, "no summarizer call when the line is off");
  assert.equal(JSON.stringify(payload), before, "the client's history is forwarded verbatim");
  assert.equal(memory.sessionSummaries.size, 0);
  assert.equal(memory.checkSessionCompletion("ses_off", payload, "done"), null, "no anti-breakpoint revival either");
  assert.equal(memory.state().enabled, false);
});

test("reasoning cache stays available when the line is off (protocol, not compression)", () => {
  // DeepSeek rejects follow-up turns whose reasoning items carry no content, so this
  // plumbing must survive the switch or disabling md_memory would 400 instead of
  // simply using more context.
  const memory = createMdMemory({ enabled: false, summariesFile: tmpSummaries() });
  memory.rememberReasoning("rs_1", "because of X");
  assert.equal(memory.reasoningFor("rs_1"), "because of X");
  const filled = memory.fillReasoningContent({ input: [{ type: "reasoning", id: "rs_1", summary: [{ text: "because of X" }] }] });
  assert.deepEqual(filled.input[0].content, [{ type: "reasoning_text", text: "because of X" }]);
  assert.equal("summary" in filled.input[0], false, "the summary is moved, not copied (it would bill twice)");
});

test("anti-breakpoint revival is rate limited per session", () => {
  const memory = createMdMemory({ summariesFile: tmpSummaries() });
  const payload = { input: [{ role: "assistant", content: [{ type: "output_text", text: "all done" }] }], tools: [{ name: "shell_command" }] };
  const first = memory.checkSessionCompletion("ses_r", payload, "all done");
  assert.ok(first, "the first plain-text turn is revived");
  assert.match(JSON.stringify(first), /session continuation/);
  assert.match(JSON.stringify(first), /shell_command/, "the revival lists the tools still available");
  assert.equal(memory.checkSessionCompletion("ses_r", payload, "all done"), null, "a second revival inside 30s is refused");
});
