
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
];

// Feature flags Codex reads from the model catalog to decide which client-side plugin
// machinery to expose (verified in the Codex binary's ModelInfo vocabulary):
// `artifact` = artifact-tool plugins (presentations / spreadsheets / documents / pdf),
// `tool_call_mcp_elicitation` = let the model request MCP tool schemas it does not have,
// `workspace_dependencies` = codex_app.load_workspace_dependencies,
// `computer_use` = desktop screen control, `browser_use` = Chrome control.
export const EXPERIMENTAL_SUPPORTED_TOOLS = ["artifact", "tool_call_mcp_elicitation", "workspace_dependencies", "computer_use", "browser_use"];

// One catalog entry. Codex's model picker lists whatever the active provider returns
// from /v1/models, so emitting an entry per available model is what makes them all
// selectable at runtime - no config rewrite, no restart.
function catalogEntry({ slug, displayName, description, compHash, inputModalities, supportsSearchTool, baseInstructions, defaultReasoningLevel, supportedReasoningLevels, priority, contextWindow = CONTEXT_WINDOW }) {
  const autoCompactTokenLimit = Math.floor(contextWindow * AUTO_COMPACT_PERCENT);
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
        context_window: contextWindow,
        max_context_window: contextWindow,
        effective_context_window_percent: 95,
        auto_compact_token_limit: autoCompactTokenLimit,
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

function modelCatalogDefaults({ mainModel, displayName, description, compHash, inputModalities, supportsSearchTool, baseInstructions, defaultReasoningLevel = "high", supportedReasoningLevels = [ { effort: "low", description: "Fast responses with lighter reasoning" }, { effort: "high", description: "Deeper reasoning for complex work" }, { effort: "xhigh", description: "Extra-deep reasoning for hard problems" } ], availableModels = [], autoRouteEntry = null }) {
  const base = { compHash, supportsSearchTool, baseInstructions, defaultReasoningLevel, supportedReasoningLevels };
  // The main model may be the published slug (gpt-5.6-luna@opencode-go); the profile
  // catalog stores bare ids, so resolve through bareModelId before looking it up.
  const contextWindowFor = (id) => availableModels.find((model) => model.id === bareModelId(id))?.contextWindow || CONTEXT_WINDOW;
  // Every provider's models in one list, each labelled with its source, so the picker
  // can switch upstream as well as model. The bare id stays with the default profile so
  // existing Codex configs keep resolving; another provider's copy of the same id is
  // published under an explicit owner suffix.
  const rest = [];
  for (const entry of profileOptions()) {
    const profile = profileById(entry.id);
    for (const model of profile.availableModels || []) {
      if (!model?.id || model.status === "unavailable") continue;
      const slug = publishedSlugFor(entry.id, model);
      if (slug === mainModel || rest.some((m) => m.slug === slug)) continue;
      rest.push({
        slug,
        displayName: `${entry.label} - ${model.label || model.id}`,
        supportsVision: Boolean(model.supportsVision),
        providerLabel: entry.label,
        contextWindow: model.contextWindow || CONTEXT_WINDOW,
      });
    }
  }
  return {
    models: [
      catalogEntry({ ...base, slug: mainModel, displayName, description, inputModalities, priority: 1, contextWindow: contextWindowFor(mainModel) }),
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
        contextWindow: model.contextWindow,
        // 1 is the selected main model; the rest follow in provider order.
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
  availableModels: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", endpoint: "responses", supportsVision: false, contextWindow: 400_000, status: "available" },
    // Zen free tier: same OpenCode token, but the upstream is zen/v1 not zen/go/v1.
    // deepseek-v4-flash-free is available but frequently returns 503 when the free
    // quota is exhausted; the upstream surfaces it per request.
    { id: "deepseek-v4-flash-free", label: "DeepSeek V4 Flash Free", endpoint: "responses", zen: true, free: true, supportsVision: false, quota5h: 100000, status: "available" },
    { id: "nemotron-3-ultra-free", label: "Nemotron 3 Ultra Free", endpoint: "responses", zen: true, free: true, supportsVision: false, status: "available" },
    { id: "laguna-s-2.1-free", label: "Laguna S 2.1 Free", endpoint: "responses", zen: true, free: true, supportsVision: false, status: "available" },
    { id: "longcat-2.0-free", label: "Longcat 2.0 Free", endpoint: "responses", zen: true, free: true, supportsVision: false, status: "available" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", endpoint: "responses", supportsVision: false, contextWindow: 400_000, status: "available" },
    { id: "glm-5", label: "GLM 5", endpoint: "responses", supportsVision: false, status: "available" },
    { id: "glm-5.1", label: "GLM 5.1", endpoint: "responses", supportsVision: false, status: "available" },
    { id: "glm-5.2", label: "GLM 5.2", endpoint: "responses", supportsVision: false, status: "available" },
    // The bare id gpt-5.6-luna is also a native GPT picker slot, so our Luna is
    // published under the @opencode-go suffix and the bare id stays reserved for
    // the native backend's GPT-5.6-Luna.
    { id: "gpt-5.6-luna", label: "Luna", endpoint: "responses", supportsVision: true, visionScore: 7, visionMaxScore: 9, visionTier: "medium", quota5h: 2050, speedTier: "fast", ownerQualified: true, status: "available" },
    { id: "grok-4.5", label: "Grok 4.5", endpoint: "responses", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 120, speedTier: "fast", status: "available" },
    { id: "hy3", label: "Hy3", endpoint: "responses", supportsVision: false, status: "available" },
    { id: "hy3-preview", label: "Hy3 Preview", endpoint: "responses", supportsVision: false, status: "unavailable" },
    { id: "kimi-k2.5", label: "Kimi K2.5", endpoint: "responses", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 1150, speedTier: "fast", status: "available" },
    { id: "kimi-k2.6", label: "Kimi K2.6", endpoint: "responses", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 1150, speedTier: "fast", status: "available" },
    { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", endpoint: "responses", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 1350, speedTier: "fast", status: "available" },
    { id: "kimi-k3", label: "Kimi K3", endpoint: "responses", supportsVision: false, status: "available" },
    { id: "mimo-v2.5", label: "MiniMax M2.5", endpoint: "responses", supportsVision: true, visionScore: 6, visionMaxScore: 9, visionTier: "medium", quota5h: 30100, speedTier: "medium", status: "available" },
    { id: "mimo-v2.5-free", label: "MiMo V2.5 Free", endpoint: "responses", zen: true, supportsVision: true, visionScore: 6, visionMaxScore: 9, visionTier: "medium", quota5h: 100000, speedTier: "fast", free: true, status: "available" },
    { id: "mimo-v2.5-pro", label: "MiniMax M2.5 Pro", endpoint: "responses", supportsVision: false, status: "available" },
    { id: "mimo-v2-omni", label: "MiniMax M2 Omni", endpoint: "responses", supportsVision: false, status: "unavailable" },
    { id: "mimo-v2-pro", label: "MiniMax M2 Pro", endpoint: "responses", supportsVision: false, status: "unavailable" },
    // Chat-completions dialect is not supported by the passthrough gateway yet.
    // These models stay published-unavailable so the picker never offers a model
    // that would 400. Note several of them are vision-capable (minimax-m3, qwen3.5/
    // 3.6/3.7-plus, qwen3.8-max); they become candidates for the vision picker
    // once a chat adapter exists.
    { id: "minimax-m2.5", label: "MiniMax M2.5", endpoint: "chat", supportsVision: false, status: "unavailable" },
    { id: "minimax-m2.7", label: "MiniMax M2.7", endpoint: "responses", supportsVision: false, status: "available" },
    { id: "minimax-m3", label: "MiniMax M3", endpoint: "chat", supportsVision: true, visionScore: 8, visionMaxScore: 9, visionTier: "strong", quota5h: 3200, speedTier: "fast", status: "unavailable" },
    { id: "qwen3.5-plus", label: "Qwen 3.5 Plus", endpoint: "chat", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 3300, speedTier: "medium", status: "unavailable" },
    { id: "qwen3.6-plus", label: "Qwen 3.6 Plus", endpoint: "chat", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 3300, speedTier: "slow", status: "unavailable" },
    { id: "qwen3.7-max", label: "Qwen 3.7 Max", endpoint: "chat", supportsVision: false, status: "unavailable" },
    { id: "qwen3.7-plus", label: "Qwen 3.7 Plus", endpoint: "chat", supportsVision: true, visionScore: 8, visionMaxScore: 9, visionTier: "strong", quota5h: 4300, speedTier: "medium", status: "unavailable" },
    { id: "qwen3.8-max", label: "Qwen 3.8 Max", endpoint: "chat", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 160, speedTier: "medium", status: "unavailable" },
  ],

  modelCatalog({ mainModel, visionModel, baseInstructions }) {
    return modelCatalogDefaults({
      mainModel,
      // The same "Provider - Model" label the rest of the catalog uses, so the
      // main entry does not render differently in the App picker.
      displayName: `${OPENCODE_GO_PROFILE.label} - ${OPENCODE_GO_PROFILE.availableModels.find((m) => m.id === bareModelId(mainModel))?.label || mainModel}`,
      description: "OpenCode Go through the local ModelDock Responses gate.",
      compHash: "modeldock-opencode-go-v1",
      inputModalities: ["text", "image"],
      supportsSearchTool: false,
      baseInstructions,
      // Publish the whole curated catalog so every model is selectable from Codex's
      // own picker, not just the one the dashboard has selected.
      availableModels: OPENCODE_GO_PROFILE.availableModels,
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
  // helper) is hidden because the model cannot interpret images - vision_inspect is the
  // gateway's text-model path for visuals. Native web_search stays (provider supports it).
  hiddenToolNames: new Set(["view_image"]),
  // Verified live (2026-08-04) against the real Codex tool set: the official Responses
  // API accepts every Codex local tool as long as it is declared type "function"
  // (shell_command, update_plan, mcp resources, request_user_input, view_image) and
  // namespaces natively - only the "custom" tool type is restricted to apply_patch
  // ("Unsupported custom tool: 'shell_command'. Only 'apply_patch' is supported.").
  // Hosted web_search is native too (echoed in the response tools list); tool_search is
  // silently ignored. So the same allowlist as opencode-go works, and nothing is blocked.
  availableModels: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", endpoint: "responses", supportsVision: false, contextWindow: 400_000, status: "available" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", endpoint: "responses", supportsVision: false, contextWindow: 400_000, status: "available" },
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
      availableModels: DEEPSEEK_OFFICIAL_PROFILE.availableModels,
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

// The slug under which a model id is published in the Codex catalog. Bare ids stay
// with the default profile so existing Codex configs keep resolving; a duplicate in
// another provider, or a model whose bare id must stay reserved (gpt-5.6-luna is
// also a native GPT picker slot), carries the @provider suffix. Accepts either a
// profile model object or a bare id string, so the catalog builder and config
// loading share one rule.
export function publishedSlugFor(profileId, model) {
  const id = typeof model === "string" ? model : model?.id;
  if (!id) return model;
  const entry = profileById(profileId || DEFAULT_PROFILE_ID).availableModels?.find((candidate) => candidate.id === id);
  const ownerQualified = Boolean(entry?.ownerQualified || (typeof model === "object" && model?.ownerQualified));
  const owned = profileId !== DEFAULT_PROFILE_ID
    && (profileById(DEFAULT_PROFILE_ID).availableModels || []).some((candidate) => candidate.id === id);
  return owned || ownerQualified ? `${id}${PROVIDER_SEPARATOR}${profileId || DEFAULT_PROFILE_ID}` : id;
}

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

// Resolve the curated model entry (label, endpoint, zen flag, vision metadata) for a
// bare model id. Used by the gateway to pick the upstream base URL per model.
export function modelEntryFor(config, model) {
  const provider = providerForModel(config, model);
  const passed = config?.profile;
  const current = passed?.availableModels
    ? passed
    : profileById(passed?.id || config?.profileId || "") || passed || null;
  const found = current?.availableModels?.find((entry) => entry.id === model)
    || profileById(provider).availableModels?.find((entry) => entry.id === model);
  return found || null;
}

export function tokenFor(config, model) {
  const provider = providerForModel(config, model);
  return config?.tokens?.[provider] || config?.goToken || "";
}

export { OPENCODE_GO_PROFILE, DEEPSEEK_OFFICIAL_PROFILE };
