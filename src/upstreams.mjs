function upstreamUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function safeErrorBody(text) {
  return String(text || "").replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]").slice(0, 1_000);
}

export function extractOutputText(response) {
  const texts = [];
  for (const item of response?.output || []) {
    if (item?.type !== "message") continue;
    for (const part of item.content || []) {
      if ((part?.type === "output_text" || part?.type === "text") && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
  }
  return texts.join("\n").trim();
}

export function parseMcpTextResult(body) {
  const payloads = [];
  const trimmed = String(body || "").trim();
  if (trimmed.startsWith("{")) payloads.push(trimmed);
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith("data:")) payloads.push(line.slice(5).trim());
  }

  for (const payload of payloads) {
    try {
      const parsed = JSON.parse(payload);
      const content = parsed?.result?.content;
      if (!Array.isArray(content)) continue;
      const texts = content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text);
      if (texts.length) return texts.join("\n");
    } catch {
      // Try the next JSON or SSE payload.
    }
  }
  return "";
}

export function createUpstreams({ config, metrics, mediaStore, getVisionModel = () => config.visionModel }) {
  async function searchWeb(args) {
    const finish = metrics.begin("web", { operation: "web_search_exa", query: args.query.slice(0, 160) });
    const endpoint = new URL(config.exaMcpUrl);
    if (config.exaApiKey) endpoint.searchParams.set("exaApiKey", config.exaApiKey);
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query: args.query,
          type: args.type || "auto",
          numResults: args.numResults || 8,
          livecrawl: args.livecrawl || "fallback",
          ...(args.contextMaxCharacters ? { contextMaxCharacters: args.contextMaxCharacters } : {}),
        },
      },
    };

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(25_000),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`Exa MCP returned ${response.status}: ${safeErrorBody(body)}`);
      const output = parseMcpTextResult(body);
      if (!output) throw new Error("Exa MCP returned no text content");
      finish({ ok: true, httpStatus: response.status, outputBytes: Buffer.byteLength(output) });
      return output;
    } catch (error) {
      finish({ ok: false, error: error.message });
      throw error;
    }
  }

  async function callVisionModel(model, images, prompt) {
    if (!config.goToken) throw new Error("OPENCODE_GO_TOKEN is not configured");
    const content = [{ type: "input_text", text: prompt }];
    for (const image of images) content.push({ type: "input_image", image_url: image.imageUrl });
    const response = await fetch(upstreamUrl(config.goBaseUrl, "responses"), {
      method: "POST",
      headers: { Authorization: `Bearer ${config.goToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: [{ role: "user", content }],
        max_output_tokens: 4_096,
        stream: false,
      }),
      signal: AbortSignal.timeout(config.visionTimeoutMs),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`${model} returned ${response.status}: ${safeErrorBody(raw)}`);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${model} returned invalid JSON`);
    }
    const answer = extractOutputText(parsed);
    if (!answer) throw new Error(`${model} returned no output text`);
    return { answer, responseId: parsed.id, usage: parsed.usage };
  }

  async function inspectVision({ image_ref, compare_image_ref, question, mode = "general" }) {
    const refs = [image_ref, compare_image_ref].filter(Boolean);
    const images = refs.map((ref) => {
      const item = mediaStore.get(ref);
      if (!item) throw new Error(`Unknown or expired image_ref: ${ref}`);
      return item;
    });
    const finish = metrics.begin("vision", { operation: "vision_inspect", mode, imageRefs: refs });
    const prompt = [
      `Vision task mode: ${mode}.`,
      question,
      "Return a concise, evidence-based answer. Preserve exact visible text and numbers. Do not expose chain-of-thought.",
    ].join("\n");
    const models = [...new Set([getVisionModel(), config.visionFallbackModel].filter(Boolean))];
    const failures = [];

    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      try {
        const result = await callVisionModel(model, images, prompt);
        const fallbackUsed = index > 0;
        metrics.recordVisionModel(model, fallbackUsed);
        finish({ ok: true, model, fallbackUsed, inputImages: images.length });
        return { model, fallbackUsed, mode, imageRefs: refs, answer: result.answer, usage: result.usage };
      } catch (error) {
        failures.push(`${model}: ${error.message}`);
      }
    }

    const message = failures.join(" | ");
    finish({ ok: false, error: message });
    throw new Error(message);
  }

  return { searchWeb, inspectVision };
}
