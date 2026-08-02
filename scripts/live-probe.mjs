import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { deflateSync } from "node:zlib";
import { loadConfig } from "../src/config.mjs";
import { extractOutputText } from "../src/upstreams.mjs";
import { startServer } from "../src/server.mjs";

const config = loadConfig();
if (!config.goToken) throw new Error("Set OPENCODE_GO_TOKEN or add it to .env before running npm run probe:live");

const instance = await startServer({ ...config, port: 0 });
const port = instance.server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;
const result = { baseUrl, responses: {}, mcp: {}, web: {}, vision: {} };
let client;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function solidBluePngDataUrl() {
  const width = 256;
  const height = 256;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    scanlines[row] = 0;
    for (let x = 0; x < width; x += 1) scanlines.set([35, 126, 220], row + 1 + x * 3);
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND"),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

try {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.mainModel,
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly GATE_OK." }] }],
      tools: [
        { type: "tool_search" },
        { type: "web_search" },
        { type: "function", name: "safe_probe", description: "Unused probe function", parameters: { type: "object", properties: {} } },
      ],
      tool_choice: "auto",
      max_output_tokens: 256,
      stream: false,
    }),
  });
  const responseBody = await response.json();
  result.responses.nonstream = {
    status: response.status,
    output: extractOutputText(responseBody),
    usage: responseBody.usage,
  };

  const stream = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      model: config.mainModel,
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly STREAM_OK." }] }],
      max_output_tokens: 256,
      stream: true,
    }),
  });
  const streamBody = await stream.text();
  result.responses.stream = {
    status: stream.status,
    completedEvent: streamBody.includes("response.completed"),
    bytes: Buffer.byteLength(streamBody),
  };

  client = new Client({ name: "modeldock-live-probe", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
  const tools = await client.listTools();
  result.mcp.tools = tools.tools.map((tool) => tool.name);

  const web = await client.callTool({
    name: "web_search_exa",
    arguments: { query: "OpenCode Go official documentation", numResults: 2, type: "fast", livecrawl: "fallback" },
  });
  const webText = web.content?.find((item) => item.type === "text")?.text || "";
  result.web = { isError: Boolean(web.isError), outputBytes: Buffer.byteLength(webText), hasUrl: /https?:\/\//.test(webText) };

  const imageRef = instance.services.mediaStore.put(solidBluePngDataUrl());
  const vision = await client.callTool({
    name: "vision_inspect",
    arguments: { image_ref: imageRef, question: "Describe the dominant visible color in one short sentence.", mode: "general" },
  });
  const visionText = vision.content?.find((item) => item.type === "text")?.text || "";
  let visionPayload;
  try {
    visionPayload = JSON.parse(visionText);
  } catch {
    visionPayload = { answer: visionText };
  }
  result.vision = {
    isError: Boolean(vision.isError),
    model: visionPayload.model,
    fallbackUsed: visionPayload.fallbackUsed,
    answer: String(visionPayload.answer || "").slice(0, 240),
  };

  result.status = instance.services.metrics.snapshot({ media: instance.services.mediaStore.snapshot() });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client?.close().catch(() => {});
  await instance.stop();
}
