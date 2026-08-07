import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionChecker } from "./session-checker.mjs";
import { createMdMemory } from "./md-memory.mjs";

const plainTextTurn = {
  input: [{ role: "assistant", content: [{ type: "output_text", text: "all done" }] }],
  tools: [{ type: "function", name: "shell_command" }, { type: "function", name: "apply_patch" }],
};

test("a plain-text turn is revived with its own last text and the available tools", () => {
  const checker = createSessionChecker();
  const revive = checker.check("ses_1", plainTextTurn, "all done");
  assert.ok(revive, "the session is kept going");
  assert.equal(revive.role, "user");
  const text = revive.content[0].text;
  assert.match(text, /session continuation/);
  assert.match(text, /all done/, "the model sees what it just said");
  assert.match(text, /shell_command, apply_patch/, "and what it can still call");
  assert.equal(/SESSION SUMMARY/.test(text), false, "no summary copy: the payload already carries one");
});

test("revival is rate limited per session, and sessions do not block each other", () => {
  let clock = 1_000;
  const checker = createSessionChecker({ intervalMs: 30_000, now: () => clock });
  assert.ok(checker.check("ses_a", plainTextTurn, "one"), "first revival goes through");
  assert.equal(checker.check("ses_a", plainTextTurn, "two"), null, "a second inside the window is refused");
  assert.ok(checker.check("ses_b", plainTextTurn, "one"), "a different session is unaffected");

  clock += 31_000;
  assert.ok(checker.check("ses_a", plainTextTurn, "three"), "and it is allowed again once the window passes");
});

test("it falls back to the last assistant text when the turn text is empty", () => {
  const checker = createSessionChecker();
  const revive = checker.check("ses_fallback", plainTextTurn, "   ");
  assert.match(revive.content[0].text, /all done/);
});

test("the checker runs even with md_memory switched off", () => {
  // The whole point of splitting it out: evaluating the client's own context
  // management must not silently disable session continuity too.
  const memory = createMdMemory({ enabled: false });
  assert.equal(memory.enabled, false);
  assert.equal(typeof memory.checkSessionCompletion, "undefined", "the checker no longer belongs to the memory line");

  const checker = createSessionChecker();
  assert.ok(checker.check("ses_off", plainTextTurn, "done"), "and it still revives");
});
