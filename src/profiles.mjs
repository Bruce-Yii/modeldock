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
  name: "harness_vision_inspect",
  description: "Inspect an attached image by its local image_ref using a vision model.",
  parameters: {
    type: "object",
    properties: {
      image_ref: { type: "string" },
      compare_image_ref: { type: "string" },
      question: { type: "string" },
      mode: { type: "string", enum: ["general", "ocr", "ui", "chart", "compare"] },
    },
    required: ["image_ref", "question"],
  },
};

const CONTEXT_WINDOW = 1_048_576;
const AUTO_COMPACT_PERCENT = 0.8;
const AUTO_COMPACT_TOKEN_LIMIT = Math.floor(CONTEXT_WINDOW * AUTO_COMPACT_PERCENT);

export { CONTEXT_WINDOW, AUTO_COMPACT_PERCENT, AUTO_COMPACT_TOKEN_LIMIT };

function modelCatalogDefaults({ mainModel, displayName, description, compHash, inputModalities, supportsSearchTool, baseInstructions }) {
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
        default_reasoning_level: "high",
        supported_reasoning_levels: [
          { effort: "low", description: "Fast responses with lighter reasoning" },
          { effort: "high", description: "Deeper reasoning for complex work" },
          { effort: "max", description: "Maximum reasoning depth" },
        ],
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

const HARNESS_TOOL_SEARCH = {
  type: "function",
  name: "harness_tool_search",
  description: "Search for additional tools that are not currently loaded. Use this when the task requires a capability you do not see in your available tools, such as sub-agents, goals, MCP resources, or app features. Describe the goal plainly in any language; the search matches semantically.",
  parameters: {
    type: "object",
    properties: {
      goal: {
        type: "string",
        description: "Plain-language description of what you are trying to accomplish and what capability you need.",
      },
    },
    required: ["goal"],
    additionalProperties: false,
  },
};

const OPENCODE_GO_PROFILE = {
  id: "opencode-go",
  label: "OpenCode Go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  tokenEnvName: "OPENCODE_GO_TOKEN",

  blockedToolTypes: new Set(["tool_search", "web_search"]),
  compactCompletedToolHistory: true,
  canonicalizeCallIds: true,
  stripSyntheticReasoningPlaceholder: true,
  harnessTools: {
    webSearch: HARNESS_WEB_SEARCH_TOOL,
    vision: HARNESS_VISION_TOOL,
    toolSearch: HARNESS_TOOL_SEARCH,
  },
  harnessToolNames: new Set(["harness_web_search", "harness_vision_inspect", "harness_tool_search"]),
  coreTools: new Set([
    "shell_command",
    "apply_patch",
    "update_plan",
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
    "request_user_input",
    "harness_web_search",
    "harness_vision_inspect",
  ]),
  checkerEnabled: true,
  availableModels: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", endpoint: "chat", supportsVision: false, status: "available" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", endpoint: "chat", supportsVision: false, status: "available" },
    { id: "glm-5", label: "GLM 5", endpoint: "chat", supportsVision: false, status: "available" },
    { id: "glm-5.1", label: "GLM 5.1", endpoint: "chat", supportsVision: false, status: "available" },
    { id: "glm-5.2", label: "GLM 5.2", endpoint: "chat", supportsVision: false, status: "available" },
    { id: "gpt-5.6-luna", label: "Luna", endpoint: "responses", supportsVision: true, visionScore: 7, visionMaxScore: 9, visionTier: "medium", quota5h: 2050, speedTier: "fast", status: "available" },
    { id: "grok-4.5", label: "Grok 4.5", endpoint: "responses", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 120, speedTier: "fast", status: "available" },
    { id: "hy3", label: "Hy3", endpoint: "chat", supportsVision: false, status: "available" },
    { id: "hy3-preview", label: "Hy3 Preview", endpoint: "chat", supportsVision: false, status: "unavailable" },
    { id: "kimi-k2.5", label: "Kimi K2.5", endpoint: "chat", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 1150, speedTier: "fast", status: "available" },
    { id: "kimi-k2.6", label: "Kimi K2.6", endpoint: "chat", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 1150, speedTier: "fast", status: "available" },
    { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", endpoint: "chat", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 1350, speedTier: "fast", status: "available" },
    { id: "kimi-k3", label: "Kimi K3", endpoint: "chat", supportsVision: false, status: "unavailable" },
    { id: "mimo-v2.5", label: "MiniMax M2.5", endpoint: "chat", supportsVision: true, visionScore: 6, visionMaxScore: 9, visionTier: "medium", quota5h: 30100, speedTier: "medium", status: "available" },
    { id: "mimo-v2.5-pro", label: "MiniMax M2.5 Pro", endpoint: "chat", supportsVision: false, status: "available" },
    { id: "mimo-v2-omni", label: "MiniMax M2 Omni", endpoint: "chat", supportsVision: false, status: "unavailable" },
    { id: "mimo-v2-pro", label: "MiniMax M2 Pro", endpoint: "chat", supportsVision: false, status: "unavailable" },
    { id: "minimax-m2.5", label: "MiniMax M2.5", endpoint: "chat", supportsVision: false, status: "available" },
    { id: "minimax-m2.7", label: "MiniMax M2.7", endpoint: "chat", supportsVision: false, status: "available" },
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
  baseUrl: "https://api.deepseek.com/responses",
  tokenEnvName: "DEEPSEEK_API_KEY",

  blockedToolTypes: new Set([]),
  compactCompletedToolHistory: false,
  canonicalizeCallIds: true,
  stripSyntheticReasoningPlaceholder: false,
  harnessTools: {
    webSearch: null,
    vision: null,
  },
  harnessToolNames: new Set([]),
  availableModels: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash (Official)", supportsVision: false },
  ],

  modelCatalog({ mainModel, baseInstructions }) {
    return modelCatalogDefaults({
      mainModel,
      displayName: "DeepSeek V4 (Official)",
      description: "DeepSeek official Responses endpoint through ModelDock.",
      compHash: "modeldock-deepseek-official-v1",
      inputModalities: ["text"],
      supportsSearchTool: false,
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

export { OPENCODE_GO_PROFILE, DEEPSEEK_OFFICIAL_PROFILE, HARNESS_WEB_SEARCH_TOOL, HARNESS_VISION_TOOL, HARNESS_TOOL_SEARCH };
