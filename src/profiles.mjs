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
  },
  harnessToolNames: new Set(["harness_web_search", "harness_vision_inspect"]),

  modelCatalog({ mainModel, visionModel, baseInstructions }) {
    return {
      models: [
        {
          slug: mainModel,
          display_name: "DeepSeek V4 Flash (OpenCode Go)",
          description: "OpenCode Go through the local ModelDock Responses gate.",
          prefer_websockets: false,
          support_verbosity: true,
          default_verbosity: "low",
          apply_patch_tool_type: "freeform",
          web_search_tool_type: "text",
          input_modalities: ["text", "image"],
          supports_image_detail_original: false,
          truncation_policy: { mode: "tokens", limit: 10_000 },
          supports_parallel_tool_calls: false,
          tool_mode: null,
          multi_agent_version: "v2",
          use_responses_lite: false,
          include_skills_usage_instructions: false,
          auto_review_model_override: null,
          context_window: 1_048_576,
          max_context_window: 1_048_576,
          effective_context_window_percent: 95,
          auto_compact_token_limit: null,
          comp_hash: "modeldock-opencode-go-v1",
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
          supports_search_tool: true,
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

  modelCatalog({ mainModel, baseInstructions }) {
    return {
      models: [
        {
          slug: mainModel,
          display_name: "DeepSeek V4 (Official)",
          description: "DeepSeek official Responses endpoint through ModelDock.",
          prefer_websockets: false,
          support_verbosity: true,
          default_verbosity: "low",
          apply_patch_tool_type: "freeform",
          web_search_tool_type: "text",
          input_modalities: ["text"],
          supports_image_detail_original: false,
          truncation_policy: { mode: "tokens", limit: 10_000 },
          supports_parallel_tool_calls: false,
          tool_mode: null,
          multi_agent_version: "v2",
          use_responses_lite: false,
          include_skills_usage_instructions: false,
          auto_review_model_override: null,
          context_window: 1_048_576,
          max_context_window: 1_048_576,
          effective_context_window_percent: 95,
          auto_compact_token_limit: null,
          comp_hash: "modeldock-deepseek-official-v1",
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
          supports_search_tool: false,
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

export { OPENCODE_GO_PROFILE, DEEPSEEK_OFFICIAL_PROFILE, HARNESS_WEB_SEARCH_TOOL, HARNESS_VISION_TOOL };
