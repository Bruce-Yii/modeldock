// Anti-breakpoint session checker.
//
// A plain-text turn with no tool call is the model about to end the session, often
// mid-task. This splices a short continuation message - the turn's own last text plus
// the tool names still available - back into the conversation as a user message and
// lets the upstream decide whether to keep working, on the same SSE stream.
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

  const lastAssistantText = (input) => {
    for (let i = input.length - 1; i >= 0; i -= 1) {
      const item = input[i];
      if (item?.role !== "assistant") continue;
      const text = Array.isArray(item.content) ? item.content.map((part) => part.text || "").join(" ") : item.content || "";
      if (text.trim()) return text.trim().slice(0, 1_000);
    }
    return "";
  };

  /**
   * @returns a user message that revives the session, or null when the session should
   * be allowed to end (rate limited, or nothing to say).
   */
  const check = (key, payload, currentTurnText = "") => {
    const at = now();
    const last = sessionChecks.get(key);
    if (last && at - last.at < intervalMs) return null;

    const input = Array.isArray(payload.input) ? payload.input : [];
    const lastText = currentTurnText.trim() || lastAssistantText(input);
    const toolNames = (Array.isArray(payload.tools) ? payload.tools : [])
      .map((tool) => tool?.name || tool?.function?.name)
      .filter(Boolean)
      .slice(0, 40)
      .join(", ");

    sessionChecks.set(key, { at, answer: lastText.slice(0, 200) || "(no text)", state: "continue" });
    debugLog(`session check (${key}): revive ${lastText.slice(0, 120)}`);

    // No summary copy here on purpose: the payload already carries the summary block
    // when md_memory is on, and a second copy was observed to precede upstream stalls.
    return {
      role: "user",
      content: [{
        type: "input_text",
        text: [
          "[session continuation - continue working on the task]",
          `YOUR LAST TEXT:\n${lastText}`,
          `AVAILABLE TOOLS: ${toolNames || "(none)"}`,
          "[end session continuation]",
        ].join("\n\n"),
      }],
    };
  };

  return {
    intervalMs,
    sessionChecks,
    check,
    state: () => ({ intervalMs, sessions: sessionChecks.size }),
  };
}
