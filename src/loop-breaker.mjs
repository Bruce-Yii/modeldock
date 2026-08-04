// Cross-request circuit breaker for the Codex <-> gate outer loop.
//
// The completion checker (server.mjs) nudges a text-only reply that looks incomplete,
// but its `rounds < 3` cap only bounds a SINGLE HTTP request. Codex re-POSTs after each
// incomplete reply, so a stuck agent can spin indefinitely: checker says "not done,
// continue" -> model answers with another intent sentence -> checker nags again, across
// hundreds of requests. This breaker sits at the session level (above any one request):
// it counts checker nags per session in a sliding window and, once they exceed a
// threshold, trips. The caller then stops running the checker for that session, which
// removes the reinforcement keeping the loop alive. A genuinely new user goal clears it.

const DEFAULT_WINDOW_MS = 5_000;
const DEFAULT_MAX_NAGS = 3;
const DEFAULT_MAX_SESSIONS = 64;

export class LoopBreaker {
  constructor({ windowMs = DEFAULT_WINDOW_MS, maxNags = DEFAULT_MAX_NAGS, maxSessions = DEFAULT_MAX_SESSIONS } = {}) {
    this.windowMs = windowMs;
    this.maxNags = maxNags;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
  }

  #state(key) {
    let state = this.sessions.get(key);
    if (!state) {
      state = { goal: "", nags: [], tripped: false };
      this.sessions.set(key, state);
      if (this.sessions.size > this.maxSessions) {
        const oldest = this.sessions.keys().next().value;
        this.sessions.delete(oldest);
      }
    }
    return state;
  }

  #applyGoal(state, goal) {
    if (!goal) return;
    if (!state.goal) {
      state.goal = goal;
      return;
    }
    if (goal !== state.goal) {
      // The agent moved on to a different task: forget the prior loop entirely.
      state.goal = goal;
      state.nags = [];
      state.tripped = false;
    }
  }

  isTripped(key) {
    return Boolean(key && this.sessions.get(key)?.tripped);
  }

  // Called at request entry so a new user goal re-enables the checker for a tripped session.
  observeGoal(key, goal) {
    if (!key) return;
    const state = this.sessions.get(key);
    if (state) this.#applyGoal(state, goal);
  }

  // Called each time the checker rejects a reply as incomplete. Returns
  // { tripped, justTripped, nags } so the caller can stop nagging and alert once.
  recordNag(key, { goal = "", now = Date.now() } = {}) {
    if (!key) return { tripped: false, justTripped: false, nags: 0 };
    const state = this.#state(key);
    this.#applyGoal(state, goal);
    state.nags = state.nags.filter((timestamp) => now - timestamp < this.windowMs);
    state.nags.push(now);
    const wasTripped = state.tripped;
    if (state.nags.length >= this.maxNags) state.tripped = true;
    return { tripped: state.tripped, justTripped: state.tripped && !wasTripped, nags: state.nags.length };
  }

  reset(key) {
    if (key) this.sessions.delete(key);
  }

  snapshot() {
    let trippedSessions = 0;
    for (const state of this.sessions.values()) if (state.tripped) trippedSessions += 1;
    return { activeSessions: this.sessions.size, trippedSessions, windowMs: this.windowMs, maxNags: this.maxNags };
  }
}
