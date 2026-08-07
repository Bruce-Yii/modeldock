import path from "node:path";

// md_memory: the single memory-compression pipeline for the ModelDock gate.
//
// Everything that bounds, compacts, or persists model context lives here, so the
// relay in server.mjs stays a thin transport. It applies to every provider we
// relay (opencode-go, deepseek-official, and any future profile) - the transport
// call for side-tasks (callModelText) already respects the active profile, and the
// payload surgery below is wire-format agnostic.
//
// The line is made of three cooperating pieces:
//   1. Rolling session summaries  - when a session's assistant history grows past
//      a threshold, the oldest portion is summarized by the main model into a
//      compact structured block that stays pinned in context. The summary rolls
//      forward (each compaction feeds the prior summary + the new delta), is
//      bounded to MAX_SESSION_SUMMARIES sessions and persisted to disk so a gate
//      restart does not lose it (without it the next request carries the full
//      un-compacted history, which balloons the payload and stalls the upstream).
//   2. Reasoning compression      - DeepSeek's Responses API rejects follow-up
//      turns whose reasoning items carry no `content`, so reasoning text is
//      recorded keyed by reasoning id and refilled on the outbound side; the
//      reasoning history itself is clipped newest-first (RECENT_REASONING items
//      and REASONING_BUDGET_BYTES total) because old thinking text is dead
//      weight - reasoning is the single largest source of per-call variance.
//   3. Anti-breakpoint revival    - a plain-text turn (no tool call) means the
//      model is about to end the session; splice the rolling summary + this
//      turn's text + tool names back as a user message and let the upstream
//      decide. Rate-limited to once per session per 30s.

const SUMMARY_TRIGGER_BYTES = 200_000; // assistant text beyond this triggers compaction
const SUMMARY_WINDOW_ITEMS = 200; // sliding window: assistant messages kept verbatim
const SUMMARY_INPUT_LIMIT = 100_000; // summarizer input cap (head+tail), chars
const SUMMARY_DEBOUNCE_MS = 5 * 60_000; // one fresh summary per session per 5min
const SESSION_CHECK_INTERVAL_MS = 30_000; // anti-breakpoint rate limit
const MAX_SESSION_SUMMARIES = 200; // per-session summaries bounded like reasoning/media
const MAX_REASONING_ENTRIES = 256; // reasoning id -> text LRU
const RECENT_REASONING = 6; // keep the newest N reasoning items
const REASONING_BUDGET_BYTES = 50 * 1024; // and at most this many bytes of them

const SUMMARY_PROMPT = [
  "You are the memory keeper of a long-running coding session. Your ONLY job is to summarize the provided conversation history.",
  "Produce a compact structured summary in this exact format:",
  "GOAL: <the user's original task, one line>",
  "DONE: <what has been completed, bullet list>",
  "DECISIONS: <key decisions and constraints that must NOT be forgotten, bullet list>",
  "STATUS: <current state, one line>",
  "TODO: <what remains, bullet list>",
  "Rules: output ONLY the summary block above - no code, no explanations, no continued work. Keep it under 200 words. Preserve technical details, file paths, and any constraint the model decided earlier - the model must not re-derive them.",
].join("\n");

// Clip the reasoning history newest-first. Reasoning balloons fast (244+ items
// observed in long sessions) and the model only needs the latest reasoning; old
// thinking text is dead weight. Count alone is not enough: six items ranged from
// 7KB to 76KB, so the byte budget clips the tail - a typical turn stays well
// under it, an unusually long thinking burst gets its oldest items dropped.
export function clipReasoningHistory(input) {
  if (!Array.isArray(input)) return { input, dropped: 0 };
  const reasoningIndices = [];
  for (let i = 0; i < input.length; i += 1) {
    if (input[i]?.type === "reasoning") reasoningIndices.push(i);
  }
  const drop = new Set(reasoningIndices.slice(0, Math.max(0, reasoningIndices.length - RECENT_REASONING)));
  let budget = REASONING_BUDGET_BYTES;
  for (let i = reasoningIndices.length - 1; i >= 0; i -= 1) {
    const index = reasoningIndices[i];
    if (drop.has(index)) continue;
    const size = JSON.stringify(input[index] ?? "").length;
    if (size <= budget) budget -= size;
    else drop.add(index);
  }
  if (!drop.size) return { input, dropped: 0 };
  return { input: input.filter((_, index) => !drop.has(index)), dropped: drop.size };
}

export function createMdMemory(deps = {}) {
  const {
    summariesFile,
    debugLog = () => {},
    // (key, messages, opts) => Promise<string | null>. Calls the active main model
    // for a side task (summary). Supplied by server.mjs so the transport stays
    // there; the memory line only decides WHAT to ask.
    callModelText = null,
    // The whole line behind one switch (MODELDOCK_MD_MEMORY=0), so the client's own
    // context management can be evaluated against ours without deleting anything.
    // Note what the switch does NOT cover: the reasoning cache and
    // fillReasoningContent are protocol plumbing, not compression - DeepSeek's
    // Responses API rejects a follow-up turn whose reasoning items carry no
    // `content`, so turning those off would 400 rather than "use less memory".
    enabled = true,
  } = deps;

  // --- Rolling per-session summaries (session_id -> { text, at }) -------------
  const sessionSummaries = new Map();
  // Session completion checker state: session_id -> { at, answer }. Fire-and-forget
  // model calls asked at most once per session per 30s.
  const sessionChecks = new Map();
  let summariesSaveTimer = null;
  const saveSummaries = () => {
    if (!summariesFile) return;
    if (summariesSaveTimer) return;
    summariesSaveTimer = setTimeout(() => {
      summariesSaveTimer = null;
      import("node:fs").then(({ mkdirSync, writeFileSync }) => {
        try {
          mkdirSync(path.dirname(summariesFile), { recursive: true });
          writeFileSync(summariesFile, JSON.stringify(Object.fromEntries(sessionSummaries)), "utf8");
        } catch (error) {
          console.log(`[gate] summaries save failed: ${error.message}`);
        }
      });
    }, 5_000);
  };
  // Bounded like the other per-session caches: without this the map gains one
  // entry per session forever, is persisted in full on every write and reloaded
  // at boot - it only ever grows. Drop the least recently summarized sessions.
  const origSet = sessionSummaries.set.bind(sessionSummaries);
  sessionSummaries.set = (key, value) => {
    origSet(key, value);
    if (sessionSummaries.size > MAX_SESSION_SUMMARIES) {
      const oldest = [...sessionSummaries.entries()]
        .sort((a, b) => (a[1]?.at || 0) - (b[1]?.at || 0))
        .slice(0, sessionSummaries.size - MAX_SESSION_SUMMARIES);
      for (const [staleKey] of oldest) sessionSummaries.delete(staleKey);
    }
    saveSummaries();
  };
  if (summariesFile) {
    import("node:fs").then(({ readFileSync, existsSync }) => {
      try {
        if (existsSync(summariesFile)) {
          const parsed = JSON.parse(readFileSync(summariesFile, "utf8"));
          for (const [key, value] of Object.entries(parsed)) {
            if (value && typeof value.text === "string") sessionSummaries.set(key, value);
          }
          console.log(`[gate] loaded ${sessionSummaries.size} persisted summaries`);
        }
      } catch (error) {
        console.log(`[gate] summaries load failed: ${error.message}`);
      }
    });
  }

  // --- Reasoning cache (reasoning id -> text), bounded LRU --------------------
  const reasoningCache = new Map();
  const rememberReasoning = (callId, text) => {
    if (!callId || typeof text !== "string" || !text.trim()) return;
    reasoningCache.delete(callId);
    reasoningCache.set(callId, text);
    while (reasoningCache.size > MAX_REASONING_ENTRIES) reasoningCache.delete(reasoningCache.keys().next().value);
  };
  const reasoningFor = (callId) => reasoningCache.get(callId) || null;

  // DeepSeek's Responses API rejects any follow-up turn whose reasoning items
  // carry no `content`, and dropping the item does not help either. We stream
  // DeepSeek's reasoning_text to Codex as a *summary*, and Codex echoes that
  // summary back with `content: null`, so the text survives in the wrong field.
  // Record it here keyed by the reasoning id we minted, so the outbound side can
  // refill `content` even if a future client stops echoing the summary.
  const rememberReasoningItems = (response) => {
    for (const item of response?.output || []) {
      if (item?.type !== "reasoning" || !item.id) continue;
      const text = (item.summary || []).map((part) => part?.text || "").join("\n").trim();
      if (text) rememberReasoning(item.id, text);
    }
  };

  // Move `reasoning.summary` into `reasoning.content` before the payload leaves
  // for a provider that demands it. DeepSeek never emits a summary at all
  // (verified live: it streams only `response.reasoning_text.delta`), so the text
  // our writer filed under `summary` is the verbatim reasoning - moving it is
  // lossless. It is a *move*, not a copy: echoing both fields would bill the
  // whole reasoning history twice on every turn.
  const fillReasoningContent = (payload) => {
    if (!Array.isArray(payload.input)) return payload;
    let filled = 0;
    const input = payload.input.map((item) => {
      if (item?.type !== "reasoning") return item;
      const summaryText = (item.summary || []).map((part) => part?.text || "").join("\n").trim();
      const text = summaryText || (item.id && reasoningFor(item.id) ? reasoningFor(item.id) : null);
      if (!text) return item;
      filled += 1;
      const { summary: _summary, encrypted_content: _encrypted, ...rest } = item;
      return { ...rest, content: [{ type: "reasoning_text", text }] };
    });
    if (!filled) return payload;
    debugLog(`moved reasoning summary -> content on ${filled} item(s)`);
    return { ...payload, input };
  };

  // Local-only sliding window over assistant history. Whenever the payload
  // carries more than SUMMARY_WINDOW_ITEMS assistant messages, drop the oldest
  // ones (already covered by the stored summary). New work is never touched: it
  // lives at the tail and only exceeds the window when a 5-minute generation
  // burst outgrows it. No API call - runs synchronously on every request so the
  // upstream always sees a bounded payload.
  const applySummaryToPayload = (payload, summaryText) => {
    // Each stage checks the switch itself rather than trusting run() to be the only
    // door: these are exported, and a future call site that reaches for one directly
    // would otherwise silently keep compacting with md_memory turned off.
    if (!enabled) return false;
    const input = Array.isArray(payload.input) ? payload.input : [];
    const assistants = [];
    for (const item of input) {
      if (item?.role !== "assistant") continue;
      const text = Array.isArray(item.content) ? item.content.map((p) => p.text || "").join(" ") : item.content || "";
      if (text) assistants.push(text);
    }
    const total = assistants.reduce((acc, t) => acc + t.length, 0);
    if (total <= SUMMARY_TRIGGER_BYTES) return false;
    if (assistants.length <= SUMMARY_WINDOW_ITEMS) return false;
    const oldCount = assistants.length - SUMMARY_WINDOW_ITEMS;
    let removed = 0;
    const newInput = input.filter((item) => {
      if (item?.role !== "assistant") return true;
      const text = Array.isArray(item.content) ? item.content.map((p) => p.text || "").join(" ") : item.content || "";
      if (text && removed < oldCount) { removed += 1; return false; }
      return true;
    });
    const insertIdx = newInput.findIndex((item) => item?.role === "user");
    const summaryItem = {
      role: "user",
      content: [{ type: "input_text", text: `[SESSION SUMMARY - earlier work, keep in mind]\n${summaryText}\n[end summary]` }],
    };
    payload.input = insertIdx >= 0
      ? [...newInput.slice(0, insertIdx), summaryItem, ...newInput.slice(insertIdx)]
      : [summaryItem, ...newInput];
    return true;
  };

  const summarizeHistory = async (key, payload, existingSummary) => {
    if (!enabled) return null;
    try {
      const input = Array.isArray(payload.input) ? payload.input : [];
      const assistants = [];
      for (const item of input) {
        if (item?.role !== "assistant") continue;
        const text = Array.isArray(item.content) ? item.content.map((p) => p.text || "").join(" ") : item.content || "";
        if (text) assistants.push(text);
      }
      const total = assistants.reduce((acc, t) => acc + t.length, 0);
      if (total <= SUMMARY_TRIGGER_BYTES) return null;
      if (assistants.length <= SUMMARY_WINDOW_ITEMS) return null;
      const oldCount = assistants.length - SUMMARY_WINDOW_ITEMS;
      let oldText = assistants.slice(0, oldCount).join("\n\n");
      // Bound the summarizer input; the summary only needs the gist of old work,
      // not every byte (a 300KB+ history would make the summary call itself slow).
      if (oldText.length > SUMMARY_INPUT_LIMIT) {
        oldText = `${oldText.slice(0, SUMMARY_INPUT_LIMIT * 0.6)}\n...[truncated ${oldText.length} chars]...\n${oldText.slice(-SUMMARY_INPUT_LIMIT * 0.4)}`;
      }
      const summarizeTarget = existingSummary
        ? `PREVIOUS SUMMARY:\n${existingSummary}\n\nNEW HISTORY SINCE THEN:\n${oldText}`
        : `HISTORY TO SUMMARIZE:\n${oldText}`;

      const summaryText = await callModelText(key, [
        { role: "developer", content: [{ type: "input_text", text: SUMMARY_PROMPT }] },
        { role: "user", content: [{ type: "input_text", text: summarizeTarget }] },
      ], { maxOutputTokens: 500, timeoutMs: 120_000 });
      if (!summaryText) return null;
      applySummaryToPayload(payload, summaryText);
      return summaryText;
    } catch (error) {
      debugLog(`summary failed: ${error.message}`);
      return null;
    }
  };

  // Anti-breakpoint revival, purely local - no side API call, no verdict logic.
  // A plain-text turn (no tool calls) means the model is about to end the
  // session; splice the rolling summary + this turn's own last text + the
  // available tool names back into the conversation as a user message and let
  // the upstream decide whether to continue on the same stream. Rate-limited to
  // once per session per 30s so a stuck model can never loop faster than that.
  const checkSessionCompletion = (key, payload, currentTurnText = "") => {
    if (!enabled) return null;
    const now = Date.now();
    const last = sessionChecks.get(key);
    if (last && now - last.at < SESSION_CHECK_INTERVAL_MS) return null;
    const input = Array.isArray(payload.input) ? payload.input : [];
    const lastText = currentTurnText.trim() || (() => {
      for (let i = input.length - 1; i >= 0; i--) {
        const item = input[i];
        if (item?.role !== "assistant") continue;
        const text = Array.isArray(item.content) ? item.content.map((p) => p.text || "").join(" ") : item.content || "";
        if (text.trim()) return text.trim().slice(0, 1_000);
      }
      return "";
    })();
    const toolNames = (Array.isArray(payload.tools) ? payload.tools : [])
      .map((tool) => tool?.name || tool?.function?.name)
      .filter(Boolean)
      .slice(0, 40)
      .join(", ");
    sessionChecks.set(key, { at: now, answer: lastText.slice(0, 200) || "(no text)", state: "continue" });
    debugLog(`session check (${key}): revive ${lastText.slice(0, 120)}`);
    // The payload already carries the summary block (applySummaryToPayload ran
    // before this turn was relayed); embedding a second copy in the continuation
    // message is redundant and was observed to precede upstream stalls.
    return {
      role: "user",
      content: [{
        type: "input_text",
        text: [
          "[session continuation - continue working on the task]",
          `YOUR LAST TEXT:\n${lastText}`,
          `AVAILABLE TOOLS: ${toolNames || "(none)"}`,
          "[end session continuation]",
        ].filter(Boolean).join("\n\n"),
      }],
    };
  };

  // Entry point for the relay: run the rolling-summary stage for one request.
  // Debounced so a long generation burst only re-summarizes every 5 minutes;
  // between generations the stored summary is applied locally (sliding window).
  const run = async (key, payload) => {
    if (!enabled) return;
    const existing = sessionSummaries.get(key) || null;
    const existingSummary = existing?.text || null;
    if (!existing || Date.now() - existing.at > SUMMARY_DEBOUNCE_MS) {
      const newSummary = await summarizeHistory(key, payload, existingSummary);
      if (newSummary) sessionSummaries.set(key, { text: newSummary, at: Date.now() });
    } else if (existingSummary) {
      applySummaryToPayload(payload, existingSummary);
    }
  };

  return {
    enabled,
    // What the line is doing right now, for /api/status.
    state: () => ({
      enabled,
      summaries: sessionSummaries.size,
      reasoningCached: reasoningCache.size,
      windowItems: SUMMARY_WINDOW_ITEMS,
      triggerBytes: SUMMARY_TRIGGER_BYTES,
      reasoningBudgetBytes: REASONING_BUDGET_BYTES,
    }),
    // constants (exposed for tests / future tuning)
    SUMMARY_TRIGGER_BYTES,
    SUMMARY_WINDOW_ITEMS,
    SUMMARY_DEBOUNCE_MS,
    SESSION_CHECK_INTERVAL_MS,
    MAX_SESSION_SUMMARIES,
    // state
    sessionSummaries,
    sessionChecks,
    reasoningCache,
    // reasoning helpers
    rememberReasoning,
    reasoningFor,
    rememberReasoningItems,
    fillReasoningContent,
    clipReasoningHistory,
    // summary pipeline
    applySummaryToPayload,
    summarizeHistory,
    run,
    // anti-breakpoint
    checkSessionCompletion,
  };
}
