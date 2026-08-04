import { test } from "node:test";
import assert from "node:assert/strict";
import { LoopBreaker } from "./loop-breaker.mjs";

test("trips after maxNags checker nudges for the same goal within the window", () => {
  const breaker = new LoopBreaker({ windowMs: 5_000, maxNags: 3 });
  const key = "session-a";
  let now = 1_000;
  assert.deepEqual(breaker.recordNag(key, { goal: "fix POST /api/models", now }), { tripped: false, justTripped: false, nags: 1 });
  now += 1_000;
  assert.deepEqual(breaker.recordNag(key, { goal: "fix POST /api/models", now }), { tripped: false, justTripped: false, nags: 2 });
  now += 1_000;
  const third = breaker.recordNag(key, { goal: "fix POST /api/models", now });
  assert.equal(third.tripped, true);
  assert.equal(third.justTripped, true);
  assert.equal(breaker.isTripped(key), true);
});

test("justTripped fires only on the transition, not on subsequent nags", () => {
  const breaker = new LoopBreaker({ windowMs: 10_000, maxNags: 2 });
  const key = "session-b";
  breaker.recordNag(key, { goal: "g", now: 0 });
  const trip = breaker.recordNag(key, { goal: "g", now: 100 });
  assert.equal(trip.justTripped, true);
  const after = breaker.recordNag(key, { goal: "g", now: 200 });
  assert.equal(after.tripped, true);
  assert.equal(after.justTripped, false);
});

test("a new user goal resets a tripped session so the checker re-enables", () => {
  const breaker = new LoopBreaker({ windowMs: 10_000, maxNags: 2 });
  const key = "session-c";
  breaker.recordNag(key, { goal: "old goal", now: 0 });
  breaker.recordNag(key, { goal: "old goal", now: 100 });
  assert.equal(breaker.isTripped(key), true);
  breaker.observeGoal(key, "a brand new goal");
  assert.equal(breaker.isTripped(key), false);
});

test("nags outside the window do not accumulate toward a trip", () => {
  const breaker = new LoopBreaker({ windowMs: 5_000, maxNags: 3 });
  const key = "session-d";
  breaker.recordNag(key, { goal: "g", now: 0 });
  breaker.recordNag(key, { goal: "g", now: 6_000 }); // first nag now outside the window
  const trip = breaker.recordNag(key, { goal: "g", now: 9_000 });
  assert.equal(trip.tripped, false);
  assert.equal(trip.nags, 2);
});

test("missing session key is a no-op and never trips", () => {
  const breaker = new LoopBreaker({ maxNags: 1 });
  assert.deepEqual(breaker.recordNag(undefined, { goal: "g" }), { tripped: false, justTripped: false, nags: 0 });
  assert.equal(breaker.isTripped(undefined), false);
  assert.equal(breaker.isTripped(""), false);
});

test("observeGoal on an unseen session does not create a tripped entry", () => {
  const breaker = new LoopBreaker();
  breaker.observeGoal("session-e", "some goal");
  assert.equal(breaker.isTripped("session-e"), false);
  assert.equal(breaker.snapshot().trippedSessions, 0);
});

test("evicts the oldest session past maxSessions", () => {
  const breaker = new LoopBreaker({ maxSessions: 2, maxNags: 99 });
  breaker.recordNag("s1", { goal: "g", now: 0 });
  breaker.recordNag("s2", { goal: "g", now: 0 });
  breaker.recordNag("s3", { goal: "g", now: 0 });
  assert.equal(breaker.snapshot().activeSessions, 2);
});

test("nudgeAllowed allows one nudge per window, then throttles until the window passes", () => {
  const breaker = new LoopBreaker({ windowMs: 5_000 });
  const key = "session-n";
  let now = 1_000;
  assert.equal(breaker.nudgeAllowed(key, { now }), true, "first nudge allowed");
  assert.equal(breaker.nudgeAllowed(key, { now: now + 1 }), false, "second nudge inside window throttled");
  assert.equal(breaker.nudgeAllowed(key, { now: now + 4_000 }), false, "still inside window");
  assert.equal(breaker.nudgeAllowed(key, { now: now + 5_000 }), true, "window passed, allowed again");
});

test("nudgeAllowed is independent of recordNag tripping", () => {
  const breaker = new LoopBreaker({ windowMs: 5_000, maxNags: 1 });
  const key = "session-m";
  breaker.nudgeAllowed(key, { now: 0 });
  breaker.recordNag(key, { goal: "g", now: 10 });
  assert.equal(breaker.isTripped(key), true, "recordNag still trips after one nag");
  assert.equal(breaker.nudgeAllowed(key, { now: 11 }), false, "nudge throttle still applies while tripped");
});

