import { test } from "node:test";
import assert from "node:assert/strict";
import { createAutoRoute, AUTO_FREE_MODEL_ID } from "./auto-route.mjs";

test("prefers the free model until a sticky failure parks it on the paid one", () => {
  let clock = 1_000;
  const auto = createAutoRoute({ cooldownMs: 60 * 60_000, now: () => clock });
  assert.equal(auto.preferred(), "deepseek-v4-flash-free");

  // A 4xx is what quota exhaustion looks like: park the session for the cooldown.
  const { sticky } = auto.recordFailure({ status: 429 });
  assert.equal(sticky, true);
  assert.equal(auto.preferred(), "deepseek-v4-flash", "subsequent requests skip the exhausted free tier");

  clock += 59 * 60_000;
  assert.equal(auto.preferred(), "deepseek-v4-flash", "still parked before the hour is up");
  clock += 2 * 60_000;
  assert.equal(auto.preferred(), "deepseek-v4-flash-free", "free is retried once the cooldown expires");
});

test("a transient failure falls back for the request without parking the session", () => {
  let clock = 1_000;
  const auto = createAutoRoute({ now: () => clock });
  for (const failure of [{ status: 500 }, { status: 503 }, { error: "socket hang up" }]) {
    const { sticky } = auto.recordFailure(failure);
    assert.equal(sticky, false, `${JSON.stringify(failure)} must not burn an hour of paid quota`);
    assert.equal(auto.preferred(), "deepseek-v4-flash-free");
  }
});

test("fallbackFor only offers the paid model, and only once", () => {
  const auto = createAutoRoute();
  assert.equal(auto.fallbackFor("deepseek-v4-flash-free"), "deepseek-v4-flash");
  assert.equal(auto.fallbackFor("deepseek-v4-flash"), null, "no second retry: the paid model is the last resort");
});

test("state reports the model actually serving, never hiding the downgrade", () => {
  let clock = 1_000;
  const auto = createAutoRoute({ cooldownMs: 60 * 60_000, now: () => clock });
  assert.deepEqual(
    { model: auto.state().model, using: auto.state().using, downgraded: auto.state().downgraded },
    { model: AUTO_FREE_MODEL_ID, using: "deepseek-v4-flash-free", downgraded: false },
  );
  auto.recordFailure({ status: 402 });
  const state = auto.state();
  assert.equal(state.using, "deepseek-v4-flash");
  assert.equal(state.downgraded, true);
  assert.equal(state.cooldownMsRemaining, 60 * 60_000);
  assert.match(state.reason, /402/);
});
