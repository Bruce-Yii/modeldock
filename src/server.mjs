import path from "node:path";
import os from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { loadConfig, publicConfig, writeEnvFile, envFileFor, migrateEnvSecrets } from "./config.mjs";
import { catalogFor } from "./catalog.mjs";
import { MediaStore } from "./media-store.mjs";
import { Metrics } from "./metrics.mjs";
import { NATIVE_IMAGE_PATHS, relayNativeImage, relayResponses as relayGatewayResponses } from "./gateway.mjs";
import { createUpstreams } from "./upstreams.mjs";
import { createMcpNodeHandler } from "./mcp.mjs";
import { CodexConfigSwitcher } from "./config-switcher.mjs";
import { createAutostart } from "./autostart.mjs";
import { createUpdater } from "./update.mjs";
import { clearOwnerFile, describeOwnerConflict, writeOwnerFile } from "./instance-owner.mjs";
import { CALLER_PATH_PREFIX, callerBasePath, callerKeyEqual, loadOrCreateCallerKey } from "./caller-key.mjs";
import { RouteAffinity } from "./router.mjs";
import { profileOptions, profileById, providerForModel, tokenFor } from "./profiles.mjs";
import staticFiles from "./static-inline.mjs";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "../public");
const assetsDir = path.resolve(dirname, "../assets");
const hasInlineStatic = staticFiles !== null && typeof staticFiles === "object";

const STATIC_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function contentTypeFor(file) {
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  return STATIC_MIME[ext] || "application/octet-stream";
}

// Serve the dashboard from the inlined frontend tree when running the release bundle
// (single file, no on-disk assets). Falls through to the on-disk public/ and assets/
// directories in dev (npm run dev / node src/server.mjs / npm test).
function serveInlineStatic(app) {
  if (!hasInlineStatic) return;
  const publicTree = staticFiles.public || {};
  const assetTree = staticFiles.assets || {};
  const serve = (req, res, tree, stripPrefix) => {
    const rel = req.path.slice(stripPrefix.length).replace(/^\/+/, "");
    const file = rel || "index.html";
    if (!(file in tree)) return false;
    const body = tree[file];
    res.setHeader("Content-Type", contentTypeFor(file));
    res.setHeader("Cache-Control", stripPrefix ? "public, max-age=604800" : "no-cache");
    res.send(body);
    return true;
  };
  app.use("/assets", (req, res, next) => { if (!serve(req, res, assetTree, "/assets")) next(); });
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    if (!serve(req, res, publicTree, "")) next();
  });
}

function urlHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

const VISION_TIER_LABELS = { strong: "High", medium: "Mid", basic: "Low", poor: "Weak" };
const SPEED_SCORES = { fast: 1.0, medium: 0.6, slow: 0.2 };
const QUOTA_SCORES = [
  { min: 10000, score: 1.0 },
  { min: 2000, score: 0.8 },
  { min: 500, score: 0.5 },
  { min: 0, score: 0.15 },
];

function quotaScore(quota5h) {
  if (typeof quota5h !== "number") return 0;
  return QUOTA_SCORES.find((band) => quota5h >= band.min)?.score || 0.15;
}

function balanceScoreFor(model) {
  const capability = model.visionScore != null && model.visionMaxScore ? model.visionScore / model.visionMaxScore : 0;
  const speed = SPEED_SCORES[model.speedTier] ?? 0;
  const cheap = quotaScore(model.quota5h);
  const freeBoost = model.free ? 0.05 : 0;
  return Number(((capability + speed + cheap) / 3 + freeBoost).toFixed(3));
}

function withTierLabel(model) {
  const decorated = { ...model };
  if (decorated.visionTier) {
    decorated.tierLabel = VISION_TIER_LABELS[decorated.visionTier] || decorated.visionTier;
  }
  if (decorated.supportsVision) {
    decorated.balanceScore = balanceScoreFor(decorated);
  }
  return decorated;
}

// The slugs the Codex catalog publishes: every provider's models, with the owner suffix
// where a bare id would be ambiguous. Used to decide whether a client-chosen model is
// one this gate can actually serve.
function publishedModelIds(config) {
  const ids = new Set();
  for (const model of codexModelCatalog(config).models || []) {
    if (model?.slug) ids.add(model.slug);
  }
  return ids;
}

function modelOptions(config, profileId) {
  const all = [];
  for (const entry of enabledProviders(config)) {
    const profile = profileById(entry.id);
    for (const model of profile?.availableModels || []) {
      if (
        model.status !== "unavailable"
        && model.endpoint !== "chat"
        && !all.some((existing) => existing.id === model.id && existing.provider === entry.id)
      ) {
        all.push({ ...withTierLabel(model), provider: entry.id });
      }
    }
  }
  for (const id of [config.mainModel, config.visionModel, config.visionFallbackModel]) {
    if (id && !all.some((existing) => existing.id === id)) {
      all.push({ id, label: id, provider: config.profileId, supportsVision: id === config.visionModel || id === config.visionFallbackModel });
    }
  }
  return all;
}

function modelCatalogModels(config, profileId) {
  const active = profileId || config.profileId;
  return modelOptions(config, active).filter((entry) => entry.provider === active);
}

function providerOptions(config) {
  return enabledProviders(config);
}

// Only providers with a configured token (or the active profile, which may resolve
// its token from the Codex config backup) are shown in the picker and published in
// the catalog. A provider with no key cannot serve requests, so it stays hidden.
function enabledProviders(config) {
  const all = profileOptions();
  const active = config.profileId || "opencode-go";
  return all.filter((entry) => {
    if (entry.id === active) return true;
    const token = config.tokens?.[entry.id];
    return Boolean(token);
  });
}

function modelsPayload(services) {
  const options = modelOptions(services.config, services.config.profileId);
  const selected = services.modelSelection;
  const visionOptions = options.filter((entry) => entry.supportsVision);
  const visionProviders = providerOptions(services.config).filter((provider) => visionOptions.some((model) => model.provider === provider.id));
  return {
    selected,
    options,
    providers: providerOptions(services.config),
    selectedProvider: services.config.profileId || "opencode-go",
    visionProviders,
    selectedVisionProvider: selected.visionModel ? modelProviderOf(options, selected.visionModel) || services.config.profileId : services.config.profileId,
  };
}

function modelProviderOf(options, modelId) {
  return options.find((entry) => entry.id === modelId)?.provider || "other";
}

function statusPayload({ config, metrics, mediaStore, routeAffinity, modelSelection, autostart, updater }) {
  const selected = modelSelection || { mainModel: config.mainModel, visionModel: config.visionModel };
  const options = modelOptions(config);
  const visionOptions = options.filter((entry) => entry.supportsVision);
  const mainTokenReady = Boolean(tokenFor(config, selected.mainModel) || (config.tokens && Object.values(config.tokens).some(Boolean)));
  const mainProvider = providerForModel(config, selected.mainModel) || config.profileId;
  const providerLabel = providerOptions(config).find((p) => p.id === mainProvider)?.label || mainProvider;
  return metrics.snapshot({
    ready: mainTokenReady,
    config: {
      ...publicConfig({ ...config, mainModel: selected.mainModel, visionModel: selected.visionModel }),
      // Selection-aware routing facts for the route card and forwarding map: which
      // provider owns the selected main model, which base URL and wire style it hits.
      mainProvider,
      mainProviderLabel: providerLabel,
      mainUpstreamUrl: upstreamBaseForModel(config, selected.mainModel),
      mainWire: "responses",
      visionUpstreamUrl: upstreamBaseForModel(config, selected.visionModel),
    },
    models: {
      selected,
      options,
      providers: providerOptions(config),
      selectedProvider: config.profileId || "opencode-go",
      visionProviders: providerOptions(config).filter((provider) => visionOptions.some((model) => model.provider === provider.id)),
      selectedVisionProvider: selected.visionModel ? modelProviderOf(options, selected.visionModel) || config.profileId : config.profileId,
    },
    media: mediaStore.snapshot(),
    routing: routeAffinity?.snapshot?.() || { activeCallIds: 0 },
    autostart: {
      supported: Boolean(autostart?.supported?.()),
      enabled: Boolean(autostart?.enabled?.()),
    },
    update: updater?.state?.() || null,
  });
}

function settingsPayload(services) {
  const { config, autostart, modelSelection } = services;
  const mainToken = config.tokens?.["opencode-go"] || config.goToken || "";
  const deepseekToken = config.tokens?.["deepseek-official"] || "";
  return {
    envFile: config.envFile || "",
    tokenConfigured: Boolean(mainToken || deepseekToken),
    providers: [
      { id: "opencode-go", label: "OpenCode Go", tokenConfigured: Boolean(mainToken) },
      { id: "deepseek-official", label: "DeepSeek (Official)", tokenConfigured: Boolean(deepseekToken) },
    ],
    models: {
      mainModel: modelSelection?.mainModel || config.mainModel,
      visionModel: modelSelection?.visionModel || config.visionModel,
      visionFallbackModel: config.visionFallbackModel || "",
    },
    autostart: {
      supported: Boolean(autostart?.supported?.()),
      enabled: Boolean(autostart?.enabled?.()),
    },
  };
}

function configMutationGuard(config) {
  const allowedOrigins = new Set([
    `http://${urlHost(config.host)}:${config.port}`,
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
  ]);
  return (req, res, next) => {
    const origin = req.get("origin");
    if (origin && !allowedOrigins.has(origin)) {
      return res.status(403).json({ error: { type: "origin_not_allowed", message: "Config changes are allowed only from this local dashboard." } });
    }
    if (!req.is("application/json")) {
      return res.status(415).json({ error: { type: "content_type_required", message: "Config changes require application/json." } });
    }
    return next();
  };
}

function recordConfigAction(metrics, operation, result) {
  const now = Date.now();
  metrics.recent.unshift({
    id: `config-${now}`,
    kind: "config",
    operation,
    startedAt: now,
    finishedAt: now,
    latencyMs: 0,
    status: result.ok ? "ok" : "error",
    ...(result.error ? { error: result.error } : {}),
  });
  metrics.recent.length = Math.min(metrics.recent.length, metrics.recentLimit);
  metrics.emit("change");
}

const ZEN_FREE_BASE = "https://opencode.ai/zen/v1";

function upstreamBaseForModel(config, model) {
  const provider = providerForModel(config, model);
  if (provider === "deepseek-official") return (config.deepseekBaseUrl || profileById("deepseek-official").baseUrl).replace(/\/$/, "");
  if (model && (model.endsWith("-free") || model === "big-pickle")) return ZEN_FREE_BASE;
  return (config.opencodeBaseUrl || config.goBaseUrl).replace(/\/$/, "");
}

export function codexModelCatalog(config) {
  return catalogFor(config);
}

function serveModels(req, res, { config, modelSelection }) {
  // Advertise the dashboard-selected main model (with its modalities/plugins) so Codex
  // starts conversations with the model the user actually picked.
  return res.json(codexModelCatalog({
    ...config,
    mainModel: modelSelection?.mainModel || config.mainModel,
    visionModel: modelSelection?.visionModel || config.visionModel,
  }));
}

const VISION_MODEL_HINTS = ["luna", "omni", "vision", "vl", "mimi", "glm-5", "grok", "kimi"];

function labelForModelId(id) {
  return id
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// Endpoint capability from live probing (2026-08-04): most models accept BOTH responses and
// chat/completions; minimax-m2.5/m3 and qwen* only accept chat (responses returns 401);
// grok-4.5 only accepts responses (chat returns 500). Prefer responses (native Codex dialect).
function modelEndpoint(modelId) {
  if (/^(minimax-m2\.5|minimax-m3|qwen)/.test(modelId)) return "chat";
  return "responses";
}

// Image used to probe whether an upstream model can actually see images. In the release
// bundle this is the inlined dashboard.png; in dev it falls back to a tiny 32x24 RGB-bar
// data URL so the probe needs no on-disk asset and works from any layout.
const inlineDashboardPng = hasInlineStatic ? staticFiles.assets?.["dashboard.png"] : null;
const VISION_PROBE_IMAGE = inlineDashboardPng
  ? `data:image/png;base64,${Buffer.from(inlineDashboardPng).toString("base64")}`
  : "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAALElEQVR4nGP47+CAHzkcSCCACv7jQQyjFoxaMGrBqAWjFoxaMGrBqAVDwwIALqWKRWv2VpsAAAAASUVORK5CYII=";

function visionProbeUrlAndBody(modelId, config, imageUrl) {
  const provider = providerForModel(config, modelId);
  const base = (provider === "deepseek-official" ? profileById("deepseek-official").baseUrl : config.goBaseUrl).replace(/\/$/, "");
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(config, modelId)}` };
  if (["gpt-5.6-luna", "grok-4.5"].includes(modelId)) {
    return {
      url: `${base}/responses`,
      headers,
      body: JSON.stringify({
        model: modelId,
        input: [{ role: "user", content: [{ type: "input_text", text: "What is this?" }, { type: "input_image", image_url: imageUrl }] }],
        stream: false,
        max_output_tokens: 64,
      }),
    };
  }
  const zenFree = modelId.endsWith("-free") || modelId === "big-pickle";
  return {
    url: zenFree ? "https://opencode.ai/zen/v1/chat/completions" : `${base}/chat/completions`,
    headers,
    body: JSON.stringify({
      model: modelId,
      max_tokens: 64,
      messages: [{ role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: imageUrl } }] }],
    }),
  };
}

async function callVisionModel(modelId, config, imageUrl, question, maxTokens = 64) {
  const { url, headers, body } = visionProbeUrlAndBody(modelId, config, imageUrl);
  const parsed = JSON.parse(body);
  if (url.endsWith("/responses")) {
    parsed.input[0].content[0].text = question;
    parsed.max_output_tokens = maxTokens;
  } else {
    parsed.messages[0].content[0].text = question;
    parsed.max_tokens = maxTokens;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(parsed),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    return { error: `HTTP ${response.status} ${detail}` };
  }
  const data = await response.json();
  if (url.endsWith("/responses")) {
    const text = (data.output || [])
      .filter((entry) => entry.type === "message" && entry.content)
      .flatMap((entry) => entry.content)
      .filter((part) => part.type === "output_text")
      .map((part) => part.text)
      .join("");
    return { text };
  }
  return { text: data.choices?.[0]?.message?.content || "" };
}

async function probeImageSupport(modelId, config) {
  try {
    const result = await callVisionModel(modelId, config, VISION_PROBE_IMAGE, "What is this?", 64);
    if (result.error) {
      if (result.error.includes("Unsupported model") || result.error.includes("ModelNotFound") || result.error.includes("Router.Unavailable")) {
        return { capability: "text", status: "unavailable" };
      }
      return { capability: "text", status: "available" };
    }
    return { capability: "vision", status: "available" };
  } catch {
    return { capability: "unknown", status: "unknown" };
  }
}

// Thin-gateway path: relay through src/gateway.mjs (byte passthrough, tee usage,
// image escalation, affinity).
async function relayGatewayRequest(req, res, services) {
  const { config, metrics, mediaStore, routeAffinity, modelSelection } = services;
  const result = await relayGatewayResponses(req.body, res, {
    config,
    metrics,
    mediaStore,
    routeAffinity,
    knownModels: publishedModelIds(config),
    mainModel: modelSelection?.mainModel || config.mainModel,
    visionModel: modelSelection?.visionModel || config.visionModel,
    // The native passthrough leg forwards these to ChatGPT's backend untouched.
    incomingHeaders: req.headers,
    requestUrl: req.originalUrl,
  });
  if (result?.route?.reason === "client_selected" && modelSelection && result.route.model !== modelSelection.mainModel) {
    modelSelection.mainModel = result.route.model;
  }
  return result;
}

let JUDGE_MODEL = null;

function judgeText(text) {
  if (!text || !text.trim()) return 0;
  const lower = text.toLowerCase();
  if (/(can't|cannot|couldn't|no image|not an image|can not see|unable to see|no picture)/.test(lower)) return 0;
  return 1;
}

async function scoreDashboardTask(modelId, config) {
  const imageUrl = VISION_PROBE_IMAGE;
  if (!imageUrl) return 0;
  const question = "Describe this dashboard screenshot in detail. List the specific metrics, numbers, and charts you can see.";
  const result = await callVisionModel(modelId, config, imageUrl, question, 256);
  if (result.error) return 0;
  const base = judgeText(result.text);
  if (base === 0) return 0;
  const hasNumbers = /\d[\d.,%]*(%|k|m|K|M)?/.test(result.text);
  const hasMetricWords = /\b(cpu|gpu|memory|ram|requests|latency|error|tokens|usage|active|model|time|duration|rate|total|count)\b/i.test(result.text);
  return (hasNumbers ? 1 : 0) + (hasMetricWords ? 1 : 0);
}

async function evaluateVision(modelId, config) {
  const { TASKS, loadTaskImage, scoreTask, tierForScore } = await import("./vision-eval.mjs");
  const results = [];
  let deterministicScore = 0;
  let maxDeterministic = 0;
  for (const task of TASKS) {
    const imageUrl = `data:image/png;base64,${loadTaskImage(task)}`;
    const answer = await callVisionModel(modelId, config, imageUrl, task.question, 48);
    const score = answer.error ? 0 : scoreTask(task, answer.text);
    deterministicScore += score;
    maxDeterministic += 1;
    results.push({ task: task.id, difficulty: task.difficulty, passed: score === 1 });
  }
  const dashboardScore = deterministicScore >= 3 ? await scoreDashboardTask(modelId, config) : 0;
  const total = deterministicScore + dashboardScore;
  const maxTotal = maxDeterministic + 2;
  return {
    deterministic: deterministicScore,
    dashboard: dashboardScore,
    score: total,
    maxScore: maxTotal,
    tier: tierForScore(total, maxTotal),
    results,
  };
}

async function probeVisionCandidates(profile, candidates, config) {
  const results = await Promise.all(
    candidates.map(async (model) => ({ id: model.id, ...(await probeImageSupport(model.id, config)) })),
  );
  profile.availableModels = profile.availableModels.map((model) => {
    const result = results.find((entry) => entry.id === model.id);
    if (!result) return model;
    return {
      ...model,
      endpoint: modelEndpoint(model.id),
      supportsVision: result.capability === "vision",
      visionStatus: result.capability,
      status: result.status,
    };
  });
  const vision = results.filter((r) => r.capability === "vision").map((r) => r.id);
  const unavailable = results.filter((r) => r.status === "unavailable").map((r) => r.id);
  console.log(`[gate] vision probe done: vision=[${vision.join(", ") || "none"}] unavailable=[${unavailable.join(", ") || "none"}]`);
  const VISION_SCORE_THRESHOLD = 4;
  const visionModels = profile.availableModels.filter((model) => model.supportsVision);
  if (visionModels.length) {
    const evaluations = await Promise.all(
      visionModels.map(async (model) => ({ id: model.id, evaluation: await evaluateVision(model.id, config) })),
    );
    profile.availableModels = profile.availableModels.map((model) => {
      const evalEntry = evaluations.find((entry) => entry.id === model.id);
      if (!evalEntry) return model;
      const evaluation = evalEntry.evaluation;
      const qualified = evaluation.score >= VISION_SCORE_THRESHOLD;
      return {
        ...model,
        visionScore: evaluation.score,
        visionMaxScore: evaluation.maxScore,
        visionTier: evaluation.tier,
        visionResults: evaluation.results,
        supportsVision: qualified,
        visionStatus: qualified ? "vision" : "no-vision",
      };
    });
    const ranked = evaluations
      .sort((a, b) => b.evaluation.score - a.evaluation.score)
      .map((entry) => `${entry.id}=${entry.evaluation.score}/${entry.evaluation.maxScore}(${entry.evaluation.tier})${entry.evaluation.score >= VISION_SCORE_THRESHOLD ? "" : "-rejected"}`);
    console.log(`[gate] vision evaluation done: ${ranked.join(", ")}`);
  }
}

async function refreshProfileModels(profile, config) {
  if (!profile || profile.id !== "opencode-go") return;
  const opencodeToken = config.tokens?.["opencode-go"] || config.goToken;
  if (!opencodeToken) return;
  if (!config.goBaseUrl.includes("opencode.ai")) return;
  // Model catalog refresh, opt-in via MODELDOCK_MODEL_PROBE_ENABLED=1. The shipped
  // curated catalog (profiles.mjs) is the primary model source and ships with the
  // release; users do not need to re-probe. This only does a light GET /models merge
  // so newly added upstream ids appear alongside the curated ones. Vision
  // probing/evaluation (probeVisionCandidates/evaluateVision) is dev-only test
  // tooling and is NOT wired into this path or into startup.
  if (config.modelProbeEnabled === false) return;
  try {
    const base = config.goBaseUrl.replace(/\/$/, "");
    const headers = { Authorization: `Bearer ${opencodeToken}` };
    const goRes = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(10_000) });
    const goIds = goRes.ok ? ((await goRes.json())?.data || []).map((entry) => entry?.id).filter((id) => typeof id === "string" && id) : [];
    const fetchedIds = [...new Set(goIds)];
    if (!fetchedIds.length) return;
    const existing = profile.availableModels || [];
    const existingById = new Map(existing.map((model) => [model.id, model]));
    const unknown = fetchedIds.filter((id) => !existingById.has(id)).sort((a, b) => a.localeCompare(b));
    const models = [
      ...existing,
      ...unknown.map((id) => ({
        id,
        label: labelForModelId(id),
        endpoint: modelEndpoint(id),
        supportsVision: false,
        visionStatus: "unknown",
        status: "available",
      })),
    ];
    profile.availableModels = models;
    console.log(`[gate] refreshed opencode-go model catalog: ${models.length} models (${existing.length} curated, ${unknown.length} new)`);
  } catch (error) {
    console.log(`[gate] model catalog refresh failed: ${error.message}`);
  }
}
export function createServices(config = loadConfig()) {
  const mutableConfig = { ...config };
  const metrics = new Metrics({ recentLimit: mutableConfig.recentLimit });
  const mediaStore = new MediaStore({
    ttlMs: mutableConfig.mediaTtlMs,
    maxBytes: mutableConfig.mediaMaxBytes,
    maxEntries: mutableConfig.mediaMaxEntries,
  });
  const modelSelection = { mainModel: mutableConfig.mainModel, visionModel: mutableConfig.visionModel };
  const services = {};
  const upstreams = createUpstreams({
    config: mutableConfig,
    metrics,
    mediaStore,
    getVisionModel: () => modelSelection.visionModel,
  });
  const catalogFile = mutableConfig.codexCatalogFile
    || path.join(os.homedir(), ".modeldock", "codex-model-catalog.json");
  // The capability key rides in the base URL Codex reads from config.toml, so a
  // hostile local web page cannot reach the relay endpoints (see caller-key.mjs).
  const callerKey = mutableConfig.callerKey || loadOrCreateCallerKey();
  const configSwitcher = new CodexConfigSwitcher({
    codexHome: mutableConfig.codexHome,
    baseUrl: `http://${urlHost(mutableConfig.host)}:${mutableConfig.port}${callerBasePath(callerKey)}`,
    mcpUrl: `http://${urlHost(mutableConfig.host)}:${mutableConfig.port}/mcp`,
    model: mutableConfig.mainModel,
    catalogFile,
  });
  const autostart = createAutostart();
  autostart.refresh().catch(() => {});
  const updater = createUpdater();
  updater.check().catch(() => {});
  const routeAffinity = new RouteAffinity();
  const runtime = { profile: mutableConfig.profile, profileId: mutableConfig.profileId };
  // The Codex App never fetches a custom provider's /models: its refresh predicate is
  // `uses_codex_backend() || has_command_auth()`, and an API-key provider satisfies
  // neither (openai/codex#32119), so the App picker shows "Custom" for everything it
  // cannot name locally. It does read a catalog file named by `model_catalog_json`, so
  // publish the same catalog we serve over HTTP to disk and point the managed Codex
  // config at it. The CLI keeps using /v1/models; both then see one list.
  const writeCatalogFile = () => {
    try {
      const catalog = codexModelCatalog({
        ...mutableConfig,
        mainModel: modelSelection.mainModel,
        visionModel: modelSelection.visionModel,
      });
      mkdirSync(path.dirname(catalogFile), { recursive: true });
      writeFileSync(catalogFile, JSON.stringify(catalog, null, 2), "utf8");
      return catalog.models?.length || 0;
    } catch (error) {
      console.log(`[gate] model catalog file write failed: ${error.message}`);
      return 0;
    }
  };
  const refreshModelCatalog = () => refreshProfileModels(mutableConfig.profile, mutableConfig).then(
    () => {
      const written = writeCatalogFile();
      console.log(`[gate] model refresh done, availableModels=${(mutableConfig.profile?.availableModels || []).length}, catalog file=${written} models`);
    },
    (error) => console.log(`[gate] model refresh error: ${error.message}`),
  );
  // Write once at boot so the file exists even when the refresh is disabled or fails.
  writeCatalogFile();
  refreshModelCatalog();
  const refreshIntervalHours = Number(mutableConfig.modelRefreshHours || 24);
  const modelRefreshTimer = refreshIntervalHours > 0
    ? setInterval(refreshModelCatalog, refreshIntervalHours * 3_600_000)
    : null;
  if (modelRefreshTimer) modelRefreshTimer.unref();
  return Object.assign(services, {
    config: mutableConfig, runtime, metrics, mediaStore, upstreams, configSwitcher,
    autostart, updater, routeAffinity, modelSelection, callerKey,
    refreshModelCatalog, modelRefreshTimer,
  });
}

export function createApp(services = createServices()) {
  const { config, metrics, mediaStore, upstreams, configSwitcher, autostart, routeAffinity } = services;
  const app = createMcpExpressApp({ host: config.host, jsonLimit: "25mb" });
  app.disable("x-powered-by");

  const mcpHandler = createMcpNodeHandler({
    upstreams,
    onError: (error) => {
      metrics.recent.unshift({
        id: "mcp",
        kind: "mcp",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      metrics.recent.length = Math.min(metrics.recent.length, metrics.recentLimit);
      metrics.emit("change");
    },
  });

  app.all("/mcp", (req, res) => mcpHandler(req, res, req.body));
  // Capability-key routes: the base_url written into config.toml carries the key
  // (/c/<key>/v1), so Codex authenticates implicitly while a hostile local web
  // page (which can POST to loopback but cannot read ~/.modeldock) cannot.
  const requireCallerKey = (req, res, next) => {
    if (services.callerKey && callerKeyEqual(req.params.key, services.callerKey)) return next();
    return res.status(401).json({ error: { type: "invalid_caller_key", message: "Unknown caller key; re-enable the Codex switch to refresh the URL." } });
  };
  app.post(`${CALLER_PATH_PREFIX}/:key/v1/responses`, requireCallerKey, (req, res) => relayGatewayRequest(req, res, services));
  app.get(`${CALLER_PATH_PREFIX}/:key/v1/models`, requireCallerKey, (req, res) => serveModels(req, res, services));
  // The built-in image_gen tool posts to the openai_base_url's images endpoints;
  // with the transparent config those land here and go straight to the native
  // backend on the client's subscription (no Platform API key needed).
  const nativeImageRelay = (req, res) => relayNativeImage(req.body, res, {
    incomingHeaders: req.headers,
    requestUrl: req.originalUrl,
  });
  app.post([...NATIVE_IMAGE_PATHS].map((item) => `${CALLER_PATH_PREFIX}/:key${item}`), requireCallerKey, nativeImageRelay);
  // Bare paths stay for compatibility with configs written before the caller key
  // existed. MODELDOCK_REQUIRE_CALLER_KEY=1 turns them off once the switch has
  // been re-enabled and Codex uses the keyed URL.
  const bareRelay = (req, res) => {
    if (process.env.MODELDOCK_REQUIRE_CALLER_KEY === "1") {
      return res.status(401).json({ error: { type: "caller_key_required", message: "This gateway requires the keyed base URL; re-enable the Codex switch." } });
    }
    return relayGatewayRequest(req, res, services);
  };
  const bareNativeImageRelay = (req, res) => {
    if (process.env.MODELDOCK_REQUIRE_CALLER_KEY === "1") {
      return res.status(401).json({ error: { type: "caller_key_required", message: "This gateway requires the keyed base URL; re-enable the Codex switch." } });
    }
    return nativeImageRelay(req, res);
  };
  app.post(["/v1/responses", "/responses"], bareRelay);
  app.post([...NATIVE_IMAGE_PATHS], bareNativeImageRelay);
  app.get(["/v1/models", "/models"], (req, res) => serveModels(req, res, services));
  app.get("/healthz", (req, res) => {
    const tokenReady = Boolean(tokenFor(config, services.modelSelection?.mainModel) || (config.tokens && Object.values(config.tokens).some(Boolean)));
    return res.status(tokenReady ? 200 : 503).json({ ok: tokenReady });
  });
  app.get("/api/status", (req, res) => res.json(statusPayload(services)));
  app.get("/api/speech", async (req, res) => {
    try {
      const { ttsStatus } = await import("./tts.mjs");
      const { sttStatus } = await import("./stt.mjs");
      const [tts, stt] = await Promise.all([ttsStatus(), sttStatus()]);
      return res.json({ tts, stt });
    } catch (error) {
      return res.status(500).json({ error: { type: "speech_status_error", message: error.message } });
    }
  });
  app.post("/api/speech/install", async (req, res) => {
    try {
      const { ttsInstall } = await import("./tts.mjs");
      const installed = await ttsInstall();
      return res.json({ installed });
    } catch (error) {
      return res.status(500).json({ error: { type: "tts_install_error", message: error.message } });
    }
  });
  app.get("/api/config", async (req, res) => {
    try {
      return res.json(await configSwitcher.status());
    } catch (error) {
      return res.status(500).json({ error: { type: "config_status_error", message: error.message } });
    }
  });

  const mutateConfig = configMutationGuard(config);
  let configMutationQueue = Promise.resolve();
  const configAction = (operation) => async (req, res) => {
    try {
      const run = configMutationQueue.then(() => configSwitcher[operation]());
      configMutationQueue = run.catch(() => {});
      const result = await run;
      recordConfigAction(metrics, `config_${operation}`, { ok: true });
      return res.json(result);
    } catch (error) {
      recordConfigAction(metrics, `config_${operation}`, { ok: false, error: error.message });
      const conflict = error.code === "CONFIG_DRIFTED" || error.code === "STATE_INVALID";
      return res.status(conflict ? 409 : 500).json({ error: { type: error.code || "config_switch_error", message: error.message } });
    }
  };
  app.post("/api/config/enable", mutateConfig, configAction("enable"));
  app.post("/api/config/disable", mutateConfig, configAction("disable"));
  app.post("/api/config/restart-ack", mutateConfig, configAction("acknowledgeRestart"));
  app.get("/api/models", (req, res) => res.json(modelsPayload(services)));
  app.get("/api/profiles", (req, res) => res.json({ selected: config.profileId, options: profileOptions() }));
  app.post("/api/models", mutateConfig, (req, res) => {
    const current = services.modelSelection;
    let nextMain = req.body?.mainModel === undefined ? current.mainModel : req.body.mainModel;
    const nextVision = req.body?.visionModel === undefined ? current.visionModel : req.body.visionModel;
    const nextProvider = req.body?.provider;
    if (nextProvider !== undefined && nextProvider !== config.profileId) {
      const known = profileOptions().some((entry) => entry.id === nextProvider);
      if (!known) return res.status(400).json({ error: { type: "invalid_provider", message: `Unknown provider: ${nextProvider}` } });
      config.profile = profileById(nextProvider);
      config.profileId = nextProvider;
      const profileModels = modelCatalogModels(config, config.profileId);
      if (!profileModels.some((entry) => entry.id === nextMain)) nextMain = profileModels[0]?.id || nextMain;
    }
    const options = modelOptions(config, config.profileId);
    const main = options.find((entry) => entry.id === nextMain);
    const vision = options.find((entry) => entry.id === nextVision);
    if (!main || !vision || !vision.supportsVision) return res.status(400).json({ error: { type: "invalid_model_selection", message: "Vision must be selected from a vision-capable model." } });
    services.modelSelection.mainModel = nextMain;
    services.modelSelection.visionModel = nextVision;
    services.configSwitcher.model = nextMain;
    recordConfigAction(metrics, "models_update", { ok: true });
    return res.json(modelsPayload(services));
  });
  app.post("/api/debug", mutateConfig, (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    services.config.debug = { ...services.config.debug, enabled };
    recordConfigAction(metrics, `debug_${enabled ? "on" : "off"}`, { ok: true });
    return res.json({ enabled });
  });
  app.post("/api/autostart", mutateConfig, async (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    try {
      const result = await autostart.setEnabled(enabled);
      recordConfigAction(metrics, `autostart_${enabled ? "on" : "off"}`, { ok: true });
      return res.json(result);
    } catch (error) {
      recordConfigAction(metrics, `autostart_${enabled ? "on" : "off"}`, { ok: false, error: error.message });
      return res.status(500).json({ error: { type: "autostart_failed", message: error.message } });
    }
  });
  app.post("/api/update", mutateConfig, async (req, res) => {
    try {
      const result = await services.updater.apply();
      recordConfigAction(metrics, "update_apply", { ok: true });
      return res.json(result);
    } catch (error) {
      recordConfigAction(metrics, "update_apply", { ok: false, error: error.message });
      return res.status(500).json({ error: { type: "update_failed", message: error.message } });
    }
  });
  app.get("/api/settings", (req, res) => res.json(settingsPayload(services)));
  app.post("/api/settings", mutateConfig, (req, res) => {
    const body = req.body || {};
    try {
      if (body.opencodeGoToken) {
        writeEnvFile({ OPENCODE_GO_TOKEN: String(body.opencodeGoToken) });
        config.tokens["opencode-go"] = String(body.opencodeGoToken);
      }
      if (body.deepseekApiKey) {
        writeEnvFile({ DEEPSEEK_API_KEY: String(body.deepseekApiKey) });
        config.tokens["deepseek-official"] = String(body.deepseekApiKey);
      }
      recordConfigAction(metrics, "settings_update", { ok: true });
      return res.json(settingsPayload(services));
    } catch (error) {
      recordConfigAction(metrics, "settings_update", { ok: false, error: error.message });
      return res.status(500).json({ error: { type: "settings_failed", message: error.message } });
    }
  });

  const eventClients = new Set();
  const broadcast = () => {
    const data = `data: ${JSON.stringify(statusPayload(services))}\n\n`;
    for (const client of eventClients) client.write(data);
  };
  metrics.on("change", broadcast);
  app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    eventClients.add(res);
    res.write(`data: ${JSON.stringify(statusPayload(services))}\n\n`);
    const keepAlive = setInterval(() => res.write(": keepalive\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      eventClients.delete(res);
    });
  });

  serveInlineStatic(app);
  app.use(express.static(publicDir, { extensions: ["html"], maxAge: 0 }));
  app.use("/assets", express.static(assetsDir, { maxAge: "7d" }));
  app.use((req, res) => res.status(404).json({ error: { message: "Not found" } }));

  return { app, close: () => mcpHandler.close?.(), services };
}

export async function startServer(config = loadConfig()) {
  const instance = createApp(createServices(config));
  const server = await new Promise((resolve, reject) => {
    const listener = instance.app.listen(config.port, config.host, () => resolve(listener));
    listener.once("error", reject);
  });
  return {
    ...instance,
    server,
    url: `http://${urlHost(config.host)}:${config.port}`,
    async stop() {
      await instance.close();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // One-time: encrypt any plaintext secrets in .env (backs up first, non-destructive).
  const migration = migrateEnvSecrets();
  if (migration.migrated > 0) {
    console.log(`Encrypted ${migration.migrated} secret(s) in ${migration.file} (backup: ${migration.backup})`);
  }
  const instance = await startServer();
  // Record port ownership so restart.ps1 and future instances can tell whose
  // process holds the port (we have shipped stale code from a lookalike
  // instance before). A conflict only warns: the listen already succeeded.
  const ownerConflict = describeOwnerConflict(instance.services.config.port, path.resolve(dirname, ".."));
  if (ownerConflict) console.warn(`WARNING: ${ownerConflict.message}`);
  writeOwnerFile(instance.services.config.port, { root: path.resolve(dirname, "..") });
  console.log(`ModelDock OpenCode Go gate listening at ${instance.url}`);
  console.log(`Dashboard: ${instance.url}/`);
  console.log(`Responses: ${instance.url}/v1/responses`);
  console.log(`MCP: ${instance.url}/mcp`);
  const missingTokens = Object.entries(instance.services.config.tokens || { "opencode-go": instance.services.config.goToken })
    .filter(([, token]) => !token)
    .map(([provider]) => provider);
  if (missingTokens.length) console.warn(`Tokens missing for provider(s): ${missingTokens.join(", ")}; the dashboard is available but those upstream calls will return 503.`);

  const shutdown = async () => {
    clearOwnerFile(instance.services.config.port);
    await instance.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
