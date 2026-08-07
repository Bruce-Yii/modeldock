const HARNESS_WEB_SEARCH_TOOL = {
  type: "function",
  name: "harness_web_search",
  description: "Search the public web through the local harness and return cited source results.",
  parameters: {
    type: "object",
    properties: {
      queries: { type: "array", items: { type: "string" }, minItems: 1 },
      domains: { type: "array", items: { type: "string" } },
      recency_days: { type: "integer", minimum: 1 },
    },
    required: ["queries"],
  },
};

const HARNESS_VISION_TOOL = {
  type: "function",
  name: "vision_inspect",
  description: "Inspect an image using a vision model. Pass EITHER a local absolute file path (path) of a screenshot you just took, OR an image_ref previously attached to the conversation. Provide the question you want answered about the image.",
  parameters: {
    type: "object",
    properties: {
      image_ref: { type: "string" },
      compare_image_ref: { type: "string" },
      path: { type: "string", description: "Absolute local file path of an image to inspect (e.g. D:/path/shot.png). Use this for screenshots you took yourself." },
      question: { type: "string" },
      mode: { type: "string", enum: ["general", "ocr", "ui", "chart", "compare"] },
    },
    required: ["question"],
  },
};

const HARNESS_TTS_TOOL = {
  type: "function",
  name: "speak",
  description: "Synthesize the given text into a local speech audio file (Microsoft Edge neural voice, no API key; works on Windows/macOS/Linux — the npm package calls Microsoft's endpoint). Returns the absolute file path of the generated audio (webm/opus) so it can be surfaced in the conversation or used by other tools.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to speak aloud. Use short paragraphs for the best result." },
      voice: { type: "string", description: "Voice name, e.g. zh-CN-XiaoxiaoNeural (Chinese female), en-US-AriaNeural (English female), ja-JP-NanamiNeural (Japanese female). Defaults to zh-CN-XiaoxiaoNeural." },
      output: { type: "string", description: "Optional absolute file path for the generated audio. Defaults to a temp file." },
    },
    required: ["text"],
  },
};

const HARNESS_STT_TOOL = {
  type: "function",
  name: "hear",
  description: "Transcribe a local audio file into text using the Windows built-in speech recognizer (System.Speech, offline, no API key; Windows only — requires the target language recognizer and ffmpeg for non-WAV input). Returns the recognized text and a confidence score.",
  parameters: {
    type: "object",
    properties: {
      file: { type: "string", description: "Absolute local file path of the audio file to transcribe (mp3, wav, webm/opus, m4a)." },
      language: { type: "string", description: "Optional language hint, e.g. zh-CN, en-US. Defaults to the installed Chinese recognizer." },
      output: { type: "string", description: "Optional absolute file path for the intermediate WAV." },
    },
    required: ["file"],
  },
};

// What we tell Codex each relayed model can hold. This is a working figure for the
// upstreams we relay, not the headline number a vendor advertises for its own API:
// declaring 1M meant Codex never reached its own auto-compaction threshold and left
// the entire context problem to the gate. At 250k it manages the session itself and
// md_memory becomes a safety net rather than the only mechanism.
// Configurable so the figure can be corrected without a release.
const CONTEXT_WINDOW = Number(process.env.MODELDOCK_CONTEXT_WINDOW || 250_000);
const AUTO_COMPACT_PERCENT = 0.8;
const AUTO_COMPACT_TOKEN_LIMIT = Math.floor(CONTEXT_WINDOW * AUTO_COMPACT_PERCENT);

export { CONTEXT_WINDOW, AUTO_COMPACT_PERCENT, AUTO_COMPACT_TOKEN_LIMIT };

const DEEPSEEK_REASONING_LEVELS = [
  { effort: "none", description: "No reasoning; direct responses only" },
  { effort: "minimal", description: "Barely any reasoning; fastest replies" },
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balanced reasoning for typical work" },
  { effort: "high", description: "Deeper reasoning for complex work" },
  { effort: "xhigh", description: "Extra-deep reasoning for hard problems" },
  { effort: "max", description: "Maximum reasoning depth" },
];

// Feature flags Codex reads from the model catalog to decide which client-side plugin
// machinery to expose (verified in the Codex binary's ModelInfo vocabulary):
// `artifact` = artifact-tool plugins (presentations / spreadsheets / documents / pdf),
// `tool_call_mcp_elicitation` = let the model request MCP tool schemas it does not have,
// `workspace_dependencies` = codex_app.load_workspace_dependencies,
// `computer_use` = desktop screen control, `browser_use` = Chrome control.
import { NODE_REPL_MCP_TOOLS } from "./node-repl-tools.mjs";
import { AUTO_FREE_MODEL_ID, AUTO_FREE_LABEL } from "./auto-route.mjs";
export const EXPERIMENTAL_SUPPORTED_TOOLS = ["artifact", "tool_call_mcp_elicitation", "workspace_dependencies", "computer_use", "browser_use"];

// One catalog entry. Codex's model picker lists whatever the active provider returns
// from /v1/models, so emitting an entry per available model is what makes them all
// selectable at runtime - no config rewrite, no restart.
function catalogEntry({ slug, displayName, description, compHash, inputModalities, supportsSearchTool, baseInstructions, defaultReasoningLevel, supportedReasoningLevels, priority }) {
  return {
        slug,
        display_name: displayName,
        description,
        prefer_websockets: false,
        support_verbosity: true,
        default_verbosity: "low",
        apply_patch_tool_type: "freeform",
        web_search_tool_type: "text",
        input_modalities: inputModalities,
        supports_image_detail_original: false,
        truncation_policy: { mode: "tokens", limit: 10_000 },
        supports_parallel_tool_calls: false,
        tool_mode: null,
        multi_agent_version: "v2",
        use_responses_lite: false,
        include_skills_usage_instructions: false,
        auto_review_model_override: null,
        context_window: CONTEXT_WINDOW,
        max_context_window: CONTEXT_WINDOW,
        effective_context_window_percent: 95,
        auto_compact_token_limit: AUTO_COMPACT_TOKEN_LIMIT,
        comp_hash: compHash,
        reasoning_summary_format: "experimental",
        default_reasoning_summary: "none",
        default_reasoning_level: defaultReasoningLevel,
        supported_reasoning_levels: supportedReasoningLevels,
        shell_type: "shell_command",
        visibility: "list",
        minimal_client_version: "0.144.0",
        supported_in_api: true,
        availability_nux: null,
        upgrade: null,
        priority,
        experimental_supported_tools: EXPERIMENTAL_SUPPORTED_TOOLS,
        supports_search_tool: supportsSearchTool,
        default_service_tier: null,
        supports_reasoning_summaries: true,
        base_instructions: baseInstructions,
        model_messages: {
          instructions_template: baseInstructions,
          instructions_variables: {
            personality_default: "",
            personality_friendly: "",
            personality_pragmatic: "",
          },
        },
  };
}

function modelCatalogDefaults({ mainModel, displayName, description, compHash, inputModalities, supportsSearchTool, baseInstructions, defaultReasoningLevel = "high", supportedReasoningLevels = [ { effort: "low", description: "Fast responses with lighter reasoning" }, { effort: "high", description: "Deeper reasoning for complex work" }, { effort: "max", description: "Maximum reasoning depth" } ], availableModels = [], autoRouteEntry = null }) {
  const base = { compHash, supportsSearchTool, baseInstructions, defaultReasoningLevel, supportedReasoningLevels };
  // Every provider's models in one list, each labelled with its source, so the picker
  // can switch upstream as well as model. The bare id stays with the default profile so
  // existing Codex configs keep resolving; another provider's copy of the same id is
  // published under an explicit owner suffix.
  const rest = [];
  for (const entry of profileOptions()) {
    const profile = profileById(entry.id);
    for (const model of profile.availableModels || []) {
      if (!model?.id || model.status === "unavailable") continue;
      const owned = entry.id !== DEFAULT_PROFILE_ID
        && (profileById(DEFAULT_PROFILE_ID).availableModels || []).some((m) => m.id === model.id);
      const slug = owned ? `${model.id}${PROVIDER_SEPARATOR}${entry.id}` : model.id;
      if (slug === mainModel || rest.some((m) => m.slug === slug)) continue;
      rest.push({
        slug,
        displayName: `${entry.label} - ${model.label || model.id}`,
        supportsVision: Boolean(model.supportsVision),
        providerLabel: entry.label,
      });
    }
  }
  return {
    models: [
      catalogEntry({ ...base, slug: mainModel, displayName, description, inputModalities, priority: 1 }),
      // Synthetic entry: not a real upstream model, it is the gate's free-first routing
      // mode. Only Codex sees it - the dashboard keeps showing whichever model is
      // actually serving.
      ...(autoRouteEntry ? [catalogEntry({
        ...base,
        slug: autoRouteEntry.id,
        displayName: autoRouteEntry.label,
        description: "Free model first; falls back to the paid one automatically when the free upstream fails.",
        inputModalities: ["text"],
        priority: 2,
      })] : []),
      ...rest.map((model, index) => catalogEntry({
        ...base,
        slug: model.slug,
        displayName: model.displayName,
        description: `${model.providerLabel} through the local ModelDock gate.`,
        // Codex sends images only to models that declare the modality; the gate still
        // reroutes visual turns to the vision model for the text-only ones.
        inputModalities: model.supportsVision ? ["text", "image"] : ["text"],
        // 1 is the selected main model and 2 is the auto-route entry.
        priority: index + (autoRouteEntry ? 3 : 2),
      })),
    ],
  };
}

const OPENCODE_GO_PROFILE = {
  id: "opencode-go",
  label: "OpenCode Go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  tokenEnvName: "OPENCODE_GO_TOKEN",

  blockedToolTypes: new Set(["tool_search", "web_search"]),
  // tool_search is Codex's client-side MCP-tool elicitation tool: the hosted schema 400s
  // on the Go camp, so the transform bridges it to a function tool with the same name.
  toolSearchAsFunction: true,
  // When the session's tool list is missing the lazy-loaded MCP tools (Codex drops them
  // when the node_repl server restarts, and re-elicitation via tool_search is not
  // guaranteed), always inject the node_repl JavaScript tools so the model keeps a
  // working Computer Use / browser automation entry point (`js` session + @oai/sky).
  guaranteedMcpTools: NODE_REPL_MCP_TOOLS,
  // Forward every Codex tool except view_image: it hands the model base64 it cannot
  // interpret (text-only main model) and caused pixel-decode loops. vision_inspect is
  // the single visual path — it analyzes AND surfaces the image into the conversation.
  // Native web_search/tool_search are blocked above and replaced by harness_web_search.
  hiddenToolNames: new Set(["view_image"]),
  // Role of flattened tool receipts in history. "user" is the battle-tested default
  // (TOOL_EXECUTION_COMPLETED as a user message, accepted by Go in every tested shape).
  // "assistant" frames the same text as the agent's own statement ("I executed a tool
  // call...") which may reduce the model pausing to "await instructions" after tool
  // results; verified by Go probing to be equally accepted (end=tool and end=user).
  receiptRole: "assistant",
  compactCompletedToolHistory: true,
  canonicalizeCallIds: true,
  stripSyntheticReasoningPlaceholder: true,
  harnessTools: {
    webSearch: HARNESS_WEB_SEARCH_TOOL,
    vision: HARNESS_VISION_TOOL,
    tts: HARNESS_TTS_TOOL,
    stt: HARNESS_STT_TOOL,
  },
  harnessToolNames: new Set(["harness_web_search", "vision_inspect", "speak", "hear"]),
  availableModels: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", endpoint: "responses", supportsVision: false, status: "available" },
    { id: "deepseek-v4-flash-free", label: "DeepSeek V4 Flash Free", endpoint: "responses", free: true, supportsVision: false, quota5h: 100000, status: "available" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", endpoint: "responses", supportsVision: false, status: "available" },
    { id: "glm-5", label: "GLM 5", endpoint: "responses", supportsVision: false, status: "available" },
    { id: "glm-5.1", label: "GLM 5.1", endpoint: "responses", supportsVision: false, status: "available" },
    { id: "glm-5.2", label: "GLM 5.2", endpoint: "responses", supportsVision: false, status: "available" },
    { id: "gpt-5.6-luna", label: "Luna", endpoint: "responses", supportsVision: true, visionScore: 7, visionMaxScore: 9, visionTier: "medium", quota5h: 2050, speedTier: "fast", status: "available" },
    { id: "grok-4.5", label: "Grok 4.5", endpoint: "responses", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 120, speedTier: "fast", status: "available" },
    { id: "hy3", label: "Hy3", endpoint: "responses", supportsVision: false, status: "available" },
    { id: "hy3-preview", label: "Hy3 Preview", endpoint: "responses", supportsVision: false, status: "unavailable" },
    { id: "kimi-k2.5", label: "Kimi K2.5", endpoint: "responses", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 1150, speedTier: "fast", status: "available" },
    { id: "kimi-k2.6", label: "Kimi K2.6", endpoint: "responses", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 1150, speedTier: "fast", status: "available" },
    { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", endpoint: "responses", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 1350, speedTier: "fast", status: "available" },
    { id: "kimi-k3", label: "Kimi K3", endpoint: "responses", supportsVision: false, status: "available" },
    { id: "mimo-v2.5", label: "MiniMax M2.5", endpoint: "responses", supportsVision: true, visionScore: 6, visionMaxScore: 9, visionTier: "medium", quota5h: 30100, speedTier: "medium", status: "available" },
    { id: "mimo-v2.5-free", label: "MiMo V2.5 Free", endpoint: "responses", supportsVision: true, visionScore: 6, visionMaxScore: 9, visionTier: "medium", quota5h: 100000, speedTier: "fast", free: true, status: "available" },
    { id: "mimo-v2.5-pro", label: "MiniMax M2.5 Pro", endpoint: "responses", supportsVision: false, status: "available" },
    { id: "mimo-v2-omni", label: "MiniMax M2 Omni", endpoint: "responses", supportsVision: false, status: "unavailable" },
    { id: "mimo-v2-pro", label: "MiniMax M2 Pro", endpoint: "responses", supportsVision: false, status: "unavailable" },
    { id: "minimax-m2.5", label: "MiniMax M2.5", endpoint: "chat", supportsVision: false, status: "available" },
    { id: "minimax-m2.7", label: "MiniMax M2.7", endpoint: "responses", supportsVision: false, status: "available" },
    { id: "minimax-m3", label: "MiniMax M3", endpoint: "chat", supportsVision: true, visionScore: 8, visionMaxScore: 9, visionTier: "strong", quota5h: 3200, speedTier: "fast", status: "available" },
    { id: "qwen3.5-plus", label: "Qwen 3.5 Plus", endpoint: "chat", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 3300, speedTier: "medium", status: "available" },
    { id: "qwen3.6-plus", label: "Qwen 3.6 Plus", endpoint: "chat", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 3300, speedTier: "slow", status: "available" },
    { id: "qwen3.7-max", label: "Qwen 3.7 Max", endpoint: "chat", supportsVision: false, status: "available" },
    { id: "qwen3.7-plus", label: "Qwen 3.7 Plus", endpoint: "chat", supportsVision: true, visionScore: 8, visionMaxScore: 9, visionTier: "strong", quota5h: 4300, speedTier: "medium", status: "available" },
    { id: "qwen3.8-max", label: "Qwen 3.8 Max", endpoint: "chat", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 160, speedTier: "medium", status: "available" },
  ],

  modelCatalog({ mainModel, visionModel, baseInstructions }) {
    return modelCatalogDefaults({
      mainModel,
      displayName: `${OPENCODE_GO_PROFILE.availableModels.find((m) => m.id === mainModel)?.label || mainModel} (OpenCode Go)`,
      description: "OpenCode Go through the local ModelDock Responses gate.",
      compHash: "modeldock-opencode-go-v1",
      inputModalities: ["text", "image"],
      supportsSearchTool: true,
      baseInstructions,
      // Publish the whole curated catalog so every model is selectable from Codex's
      // own picker, not just the one the dashboard has selected.
      availableModels: OPENCODE_GO_PROFILE.availableModels,
      autoRouteEntry: { id: AUTO_FREE_MODEL_ID, label: AUTO_FREE_LABEL },
    });
  },
};

const DEEPSEEK_OFFICIAL_PROFILE = {
  id: "deepseek-official",
  label: "DeepSeek Official",
  baseUrl: "https://api.deepseek.com",
  tokenEnvName: "DEEPSEEK_API_KEY",

  blockedToolTypes: new Set([]),
  // The official DeepSeek API accepts every Codex local tool as type "function", so
  // forward all except tools useless to a text-only model: view_image (native "vision"
  // helper) is hidden because the model cannot interpret images — vision_inspect is the
  // gateway's text-model path for visuals. Native web_search stays (provider supports it).
  hiddenToolNames: new Set(["view_image"]),
  compactCompletedToolHistory: true,
  canonicalizeCallIds: true,
  stripSyntheticReasoningPlaceholder: true,
  harnessTools: {
    webSearch: HARNESS_WEB_SEARCH_TOOL,
    vision: HARNESS_VISION_TOOL,
    tts: HARNESS_TTS_TOOL,
    stt: HARNESS_STT_TOOL,
  },
  harnessToolNames: new Set(["harness_web_search", "vision_inspect", "speak", "hear"]),
  // Verified live (2026-08-04) against the real Codex tool set: the official Responses
  // API accepts every Codex local tool as long as it is declared type "function"
  // (shell_command, update_plan, mcp resources, request_user_input, view_image) and
  // namespaces natively — only the "custom" tool type is restricted to apply_patch
  // ("Unsupported custom tool: 'shell_command'. Only 'apply_patch' is supported.").
  // Hosted web_search is native too (echoed in the response tools list); tool_search is
  // silently ignored. So the same allowlist as opencode-go works, and nothing is blocked.
  availableModels: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", endpoint: "responses", supportsVision: false, status: "available" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", endpoint: "responses", supportsVision: false, status: "available" },
  ],

  modelCatalog({ mainModel, baseInstructions }) {
    return modelCatalogDefaults({
      mainModel,
      displayName: "DeepSeek V4 (Official)",
      description: "DeepSeek official Responses endpoint through ModelDock.",
      compHash: "modeldock-deepseek-official-v1",
      inputModalities: ["text"],
      supportsSearchTool: false,
      // Verified live (2026-08-04): the official API accepts reasoning effort in
      // { none, minimal, low, medium, high, xhigh, max } with thinking on by default
      // (effort null). The Go camp's low/high/max triple does not fit it.
      defaultReasoningLevel: "medium",
      supportedReasoningLevels: DEEPSEEK_REASONING_LEVELS,
      baseInstructions,
    });
  },
};

const PROFILES = {
  "opencode-go": OPENCODE_GO_PROFILE,
  "deepseek-official": DEEPSEEK_OFFICIAL_PROFILE,
};

export function profileById(id) {
  return PROFILES[id] || OPENCODE_GO_PROFILE;
}

export function profileOptions() {
  return Object.values(PROFILES).map((profile) => ({ id: profile.id, label: profile.label }));
}

// Resolve which provider owns a model id. The currently active profile wins, then any
// profile whose curated catalog lists the model. Used to route per-model upstream calls
// (main model on DeepSeek, vision on OpenCode Go) to the right base URL and token.
// A few ids (deepseek-v4-flash, deepseek-v4-pro) exist in more than one catalog, so the
// published slug carries its owner when the bare id would be ambiguous:
// "deepseek-v4-flash@deepseek-official". The suffix is a routing address only - it is
// stripped before the id reaches an upstream.
export const PROVIDER_SEPARATOR = "@";
// The profile whose ids are published bare, so ids already written into Codex configs
// keep resolving without a suffix.
const DEFAULT_PROFILE_ID = "opencode-go";

export function bareModelId(model) {
  const at = String(model || "").lastIndexOf(PROVIDER_SEPARATOR);
  return at > 0 ? String(model).slice(0, at) : model;
}

export function providerForModel(config, model) {
  if (!model) return config?.profileId || "opencode-go";
  // An explicit owner in the slug outranks every heuristic below.
  const at = String(model).lastIndexOf(PROVIDER_SEPARATOR);
  if (at > 0) {
    const tagged = String(model).slice(at + 1);
    if (PROFILES[tagged]) return tagged;
  }
  // Resolve the active profile by id when the caller passed a partial object: several
  // ids (deepseek-v4-flash, deepseek-v4-pro) exist in more than one catalog, and the
  // active profile is what breaks the tie - a stub without availableModels would
  // silently lose that tie-break and hand the model to the wrong provider.
  const passed = config?.profile;
  const current = passed?.availableModels
    ? passed
    : profileById(passed?.id || config?.profileId || "") || passed || null;
  if (current?.availableModels?.some((entry) => entry.id === model)) return current.id;
  for (const entry of profileOptions()) {
    const candidate = profileById(entry.id);
    if (candidate.availableModels?.some((modelEntry) => modelEntry.id === model)) return candidate.id;
  }
  return config?.profileId || "opencode-go";
}

export function tokenFor(config, model) {
  const provider = providerForModel(config, model);
  return config?.tokens?.[provider] || config?.goToken || "";
}

export { OPENCODE_GO_PROFILE, DEEPSEEK_OFFICIAL_PROFILE, HARNESS_WEB_SEARCH_TOOL, HARNESS_VISION_TOOL };
