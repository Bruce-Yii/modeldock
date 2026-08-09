// Provider token validation at the write boundary (settings API). Providers
// reject malformed keys at request time with confusing errors, so the shape is
// checked before anything reaches the .env - DeepSeek setup-script semantics
// (:324-354): the key must carry its documented prefix and must not contain
// quotes. A failed validation aborts the write; the .env is left untouched.
export function validateProviderToken(provider, value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return { ok: false, error: "The token is empty." };
  }
  if (/["']/.test(raw)) {
    return { ok: false, error: "The token must not contain quotes." };
  }
  if (provider === "deepseek-official" && !raw.startsWith("sk-")) {
    return { ok: false, error: "A DeepSeek API key must start with sk- (create one at https://platform.deepseek.com/api_keys)." };
  }
  if (provider === "exa" && !/^exa_[A-Za-z0-9]+$/.test(raw)) {
    return { ok: false, error: "An Exa API key must look like exa_<token>." };
  }
  return { ok: true, value: raw };
}
