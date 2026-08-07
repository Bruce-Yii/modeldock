// Anti-breakpoint session checker.
//
// A plain-text turn with no tool call is the model about to end the session, often
// mid-task. This splices one question back in as a user message and lets the upstream
// decide whether to keep working, on the same SSE stream.
//
// The question is all it takes. Earlier versions also echoed the turn's own last text
// and listed the available tools; both are already in the payload the model is about to
// receive, so repeating them only spent tokens on what it can already see.
//
// Deliberately independent of md_memory. It reads no summary, writes no history and
// compacts nothing; it only decides whether a session should keep going. Turning the
// memory line off to evaluate the client's own context management must not also switch
// off session continuity, or the comparison changes two things at once. Its own escape
// hatch is `debug.noSessionCheck`.
//
// Purely local: no side API call, no verdict model. Rate-limited to once per session
// per interval so a model stuck in a loop cannot revive faster than that.

const SESSION_CHECK_INTERVAL_MS = 30_000;

export function createSessionChecker({ intervalMs = SESSION_CHECK_INTERVAL_MS, debugLog = () => {}, now = () => Date.now() } = {}) {
  // session_id -> { at, answer, state }; also read by the dashboard.
  const sessionChecks = new Map();

  const REVIVAL_TEXT = "Is the task complete? If not, keep working until it is.";

  /**
   * @returns a user message that revives the session, or null when the session should
   * be allowed to end (rate limited).
   */
  const check = (key) => {
    const at = now();
    const last = sessionChecks.get(key);
    if (last && at - last.at < intervalMs) return null;

    sessionChecks.set(key, { at, answer: REVIVAL_TEXT, state: "continue" });
    debugLog(`session check (${key}): revive`);

    return {
      role: "user",
      content: [{ type: "input_text", text: REVIVAL_TEXT }],
    };
  };

  return {
    intervalMs,
    sessionChecks,
    check,
    state: () => ({ intervalMs, sessions: sessionChecks.size }),
  };
}
