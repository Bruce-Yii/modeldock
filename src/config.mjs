import process from "node:process";
import os from "node:os";
import path from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { profileById } from "./profiles.mjs";

try {
  process.loadEnvFile?.(".env");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

function integer(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function normalizedBaseUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported upstream protocol: ${parsed.protocol}`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function tomlStringValue(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return "";
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return "";
}

export function tokenFromCodexToml(source) {
  let provider = "";
  for (const line of String(source || "").split(/\r?\n/)) {
    const section = line.match(/^\s*\[model_providers\.([^\]]+)\]\s*(?:#.*)?$/i);
    if (section) {
      provider = section[1].replace(/^['"]|['"]$/g, "").toLowerCase();
      continue;
    }
    if (/^\s*\[/.test(line)) {
      provider = "";
      continue;
    }
    if (!new Set(["opencode", "opencode_go", "console_go"]).has(provider)) continue;
    const token = line.match(/^\s*experimental_bearer_token\s*=\s*(.+?)\s*(?:#.*)?$/i);
    if (token) return tomlStringValue(token[1]);
  }
  return "";
}

function discoverCodexGoToken(codexHome) {
  try {
    const candidates = readdirSync(codexHome)
      .filter((name) => name === "config.toml" || name.startsWith("config.toml.bak"))
      .map((name) => {
        const file = path.join(codexHome, name);
        return { file, modified: statSync(file).mtimeMs };
      })
      .sort((left, right) => right.modified - left.modified);
    for (const candidate of candidates) {
      const token = tokenFromCodexToml(readFileSync(candidate.file, "utf8"));
      if (token && token !== "local-modeldock") return { token, source: "codex-config-backup" };
    }
  } catch {
    // An environment token remains the explicit fallback if discovery is unavailable.
  }
  return { token: "", source: "missing" };
}

export function loadConfig() {
  const host = process.env.MODELDOCK_HOST || "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("MODELDOCK_HOST must be a loopback address for this MVP");
  }

  const codexHome = path.resolve(process.env.MODELDOCK_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const profileId = (process.env.MODELDOCK_PROFILE || "opencode-go").trim().toLowerCase();
  const profile = profileById(profileId);
  // Codex config backups only ever hold OpenCode Go bearer tokens; never reuse them for
  // another provider (an opencode token sent to api.deepseek.com would be a leak).
  const discovered = process.env[profile.tokenEnvName]
    ? { token: process.env[profile.tokenEnvName], source: "environment" }
    : (profileId === "opencode-go" ? discoverCodexGoToken(codexHome) : { token: "", source: "missing" });

  const opencodeGoToken = process.env.OPENCODE_GO_TOKEN || discoverCodexGoToken(codexHome).token;
  const deepseekToken = process.env.DEEPSEEK_API_KEY || "";
  const tokens = {
    "opencode-go": opencodeGoToken,
    "deepseek-official": deepseekToken,
  };

  const debug = {
    enabled: process.env.MODELDOCK_DEBUG === "1" || process.env.MODELDOCK_DEBUG === "true",
    noReasoning: process.env.MODELDOCK_NO_REASONING === "1",
    dumpDir: process.env.MODELDOCK_DUMP_DIR || "",
  };

  return Object.freeze({
    host,
    port: integer("MODELDOCK_PORT", 4097, { min: 1, max: 65535 }),
    profile,
    profileId: profile.id,
    debug,
    // Per-camp base URLs: the OpenCode Go camp is profile-independent so a DeepSeek main
    // model can still route its vision/web harness to the Go camp, and vice versa.
    opencodeBaseUrl: normalizedBaseUrl(process.env.MODELDOCK_UPSTREAM_BASE_URL || "https://opencode.ai/zen/go/v1"),
    goBaseUrl: normalizedBaseUrl(process.env.MODELDOCK_UPSTREAM_BASE_URL || "https://opencode.ai/zen/go/v1"),
    deepseekBaseUrl: normalizedBaseUrl(process.env.MODELDOCK_DEEPSEEK_BASE_URL || "https://api.deepseek.com"),
    goToken: discovered.token,
    goTokenSource: discovered.source,
    tokens,
    mainModel: process.env.MODELDOCK_MAIN_MODEL || "deepseek-v4-flash",
    visionModel: process.env.MODELDOCK_VISION_MODEL || "mimo-v2.5-free",
    visionFallbackModel: process.env.MODELDOCK_VISION_FALLBACK_MODEL || "minimax-m3",
    visionTimeoutMs: integer("MODELDOCK_VISION_TIMEOUT_MS", 90_000, { min: 1_000, max: 300_000 }),
    mediaTtlMs: integer("MODELDOCK_MEDIA_TTL_MS", 3_600_000, { min: 60_000 }),
    mediaMaxBytes: integer("MODELDOCK_MEDIA_MAX_BYTES", 10 * 1024 * 1024, { min: 1_024 }),
    mediaMaxEntries: integer("MODELDOCK_MEDIA_MAX_ENTRIES", 64, { min: 1, max: 1_024 }),
    exaMcpUrl: normalizedBaseUrl(process.env.EXA_MCP_URL || "https://mcp.exa.ai/mcp"),
    exaApiKey: process.env.EXA_API_KEY || "",
    recentLimit: integer("MODELDOCK_RECENT_LIMIT", 50, { min: 10, max: 500 }),
    modelRefreshHours: Number(process.env.MODELDOCK_MODEL_REFRESH_HOURS || 24),
    modelProbeEnabled: process.env.MODELDOCK_MODEL_PROBE_ENABLED !== "0",
    codexHome,
  });
}

export function publicConfig(config) {
  return {
    bind: `${config.host}:${config.port}`,
    profile: config.profileId,
    goBaseUrl: config.goBaseUrl,
    opencodeBaseUrl: config.opencodeBaseUrl,
    deepseekBaseUrl: config.deepseekBaseUrl,
    mainModel: config.mainModel,
    visionModel: config.visionModel,
    visionFallbackModel: config.visionFallbackModel,
    exaMcpUrl: config.exaMcpUrl,
    tokenConfigured: Boolean(config.goToken),
    tokenSource: config.goTokenSource || (config.goToken ? "configured" : "missing"),
    debug: {
      enabled: Boolean(config.debug?.enabled),
      noReasoning: Boolean(config.debug?.noReasoning),
      dumpDir: config.debug?.dumpDir || "",
    },
  };
}
