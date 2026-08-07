// Rewrites upstream error bodies before they reach Codex. Providers disagree on
// where the human-readable message lives and report exhausted quota under many
// different statuses, so classification has to read the body before mapping the
// status: a quota 429 must not advise "retry shortly", and a no-credits 403 must
// not blame credentials.

const DETAIL_LIMIT = 300;

// Providers disagree on where the message lives: OpenAI-style error.message,
// bare error strings, top-level message (Alibaba), FastAPI detail, or MiniMax's
// base_resp.status_msg (minimax-m3 is our vision fallback, so that shape shows
// up in real traffic).
export function parseUpstreamError(bodyText) {
  if (typeof bodyText !== "string" || !bodyText) return { message: "", type: undefined };
  try {
    const parsed = JSON.parse(bodyText);
    const error = parsed?.error;
    const message =
      (typeof error === "string" && error) ||
      (typeof error?.message === "string" && error.message) ||
      (typeof parsed?.base_resp?.status_msg === "string" && parsed.base_resp.status_msg) ||
      (typeof parsed?.message === "string" && parsed.message) ||
      (typeof parsed?.detail === "string" && parsed.detail) ||
      bodyText;
    const type = [error?.type, error?.code, error?.status].find((value) => typeof value === "string");
    return { message, type };
  } catch {
    // Non-JSON bodies (HTML gateway pages, plain text) pass through as-is.
    return { message: bodyText, type: undefined };
  }
}

// Quota exhaustion appears under 429 (OpenAI insufficient_quota), 402
// (DeepSeek), and 403 (xAI), so patterns run before any status mapping.
const QUOTA_PATTERNS = [
  /insufficient[_\s]quota/i,
  /exceeded your current quota/i,
  /insufficient (?:balance|credits?)/i,
  /credit balance is too low/i,
  /(?:no|any|out of) credits/i,
  /usage limit (?:reached|exceeded)/i,
  /quota (?:reached|exceeded|exhausted)/i,
];

const AUTH_PATTERNS = [
  /invalid (?:api[_\s]?key|token|authentication)/i,
  /incorrect api key/i,
  /authentication(?:_error| failed| required)/i,
  /unauthorized/i,
];

export function classifyUpstreamError(status, message, type) {
  const text = `${type || ""} ${message || ""}`;
  if (QUOTA_PATTERNS.some((pattern) => pattern.test(text))) return "quota_exhausted";
  if (status === 401 || AUTH_PATTERNS.some((pattern) => pattern.test(text))) return "auth_failed";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_unavailable";
  return "invalid_request";
}

const CLASS_HINTS = {
  quota_exhausted: "The upstream account is out of quota or credits; retrying will not help until it is topped up.",
  auth_failed: "The upstream rejected the API token; check the configured key.",
  rate_limited: "The upstream is rate limiting; retry shortly.",
  upstream_unavailable: "The upstream provider is unavailable; retry shortly.",
};

// Produce the JSON body the gateway forwards to Codex in place of the raw
// upstream body. Codex renders error.message, so the cleaned detail leads and
// the hint (when any) follows. The upstream provider is named because Codex
// only sees "ModelDock" otherwise, and a provider outage reads like a gateway
// bug.
export function translateUpstreamError({ provider, status, bodyText }) {
  const { message, type } = parseUpstreamError(bodyText);
  const detail = String(message || "").trim().slice(0, DETAIL_LIMIT) || `Upstream returned ${status}`;
  const classification = classifyUpstreamError(status, detail, type);
  const hint = CLASS_HINTS[classification];
  return {
    classification,
    body: {
      error: {
        type: classification,
        message: `[${provider}] ${detail}${hint ? ` — ${hint}` : ""}`,
      },
    },
  };
}
