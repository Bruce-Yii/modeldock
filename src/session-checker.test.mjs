import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionChecker } from "./session-checker.mjs";
import { createMdMemory } from "./md-memory.mjs";

test("a plain-text turn is revived with a single question", () => {
  const checker = createSessionChecker();
  const revive = checker.check("ses_1");
  assert.ok(revive, "the session is kept going");
  assert.equal(revive.role, "user");
  const text = revive.content[0].text;
  assert.equal(text, "Is the task complete? If not, keep working until it is.");
  // Everything else is already in the payload the model is about to receive; echoing
  // its own last text or the tool list back would only spend tokens on what it sees.
  assert.equal(/YOUR LAST TEXT|AVAILABLE TOOLS|SESSION SUMMARY/.test(text), false);
});

test("revival is rate limited per session, and sessions do not block each other", () => {
  let clock = 1_000;
  const checker = createSessionChecker({ intervalMs: 30_000, now: () => clock });
  assert.ok(checker.check("ses_a"), "first revival goes through");
  assert.equal(checker.check("ses_a"), null, "a second inside the window is refused");
  assert.ok(checker.check("ses_b"), "a different session is unaffected");

  clock += 31_000;
  assert.ok(checker.check("ses_a"), "and it is allowed again once the window passes");
});

test("the checker runs even with md_memory switched off", () => {
  // The point of splitting it out: evaluating the client's own context management
  // must not silently disable session continuity too.
  const memory = createMdMemory({ enabled: false });
  assert.equal(memory.enabled, false);
  assert.equal(typeof memory.checkSessionCompletion, "undefined", "the checker no longer belongs to the memory line");

  const checker = createSessionChecker();
  assert.ok(checker.check("ses_off"), "and it still revives");
});
