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

const CONTEXT_WINDOW = 1_048_576;
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

function modelCatalogDefaults({ mainModel, displayName, description, compHash, inputModalities, supportsSearchTool, baseInstructions, defaultReasoningLevel = "high", supportedReasoningLevels = [ { effort: "low", description: "Fast responses with lighter reasoning" }, { effort: "high", description: "Deeper reasoning for complex work" }, { effort: "max", description: "Maximum reasoning depth" } ] }) {
  return {
    models: [
      {
        slug: mainModel,
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
        priority: 1,
        experimental_supported_tools: [],
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
      },
    ],
  };
}

const OPENCODE_GO_PROFILE = {
  id: "opencode-go",
  label: "OpenCode Go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  tokenEnvName: "OPENCODE_GO_TOKEN",

  blockedToolTypes: new Set(["tool_search", "web_search"]),
  // Forward every Codex tool (the chat bridge accepts all schemas). view_image stays:
  // the direct-vision route hands image turns to a vision model, and view_image lets the
  // model surface screenshots to the human. Native web_search/tool_search are blocked
  // above and replaced by harness_web_search + vision_inspect.
  hiddenToolNames: new Set([]),
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
  },
  harnessToolNames: new Set(["harness_web_search", "vision_inspect"]),
  coreTools: new Set([
    "shell_command",
    "apply_patch",
    "update_plan",
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
    "request_user_input",
    "view_image",
    "harness_web_search",
    "vision_inspect",
  ]),
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
      displayName: "DeepSeek V4 Flash (OpenCode Go)",
      description: "OpenCode Go through the local ModelDock Responses gate.",
      compHash: "modeldock-opencode-go-v1",
      inputModalities: ["text", "image"],
      supportsSearchTool: true,
      baseInstructions,
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
  },
  harnessToolNames: new Set(["harness_web_search", "vision_inspect"]),
  // Verified live (2026-08-04) against the real Codex tool set: the official Responses
  // API accepts every Codex local tool as long as it is declared type "function"
  // (shell_command, update_plan, mcp resources, request_user_input, view_image) and
  // namespaces natively — only the "custom" tool type is restricted to apply_patch
  // ("Unsupported custom tool: 'shell_command'. Only 'apply_patch' is supported.").
  // Hosted web_search is native too (echoed in the response tools list); tool_search is
  // silently ignored. So the same allowlist as opencode-go works, and nothing is blocked.
  coreTools: new Set([
    "shell_command",
    "apply_patch",
    "update_plan",
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
    "request_user_input",
    "view_image",
    "harness_web_search",
    "vision_inspect",
  ]),
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
export function providerForModel(config, model) {
  if (!model) return config?.profileId || "opencode-go";
  const current = config?.profile || (config?.profileId ? profileById(config.profileId) : null);
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
