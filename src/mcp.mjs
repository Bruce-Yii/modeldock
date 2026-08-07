import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";

function textResult(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

function errorResult(error) {
  return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
}

export function createMcpServer({ upstreams }) {
  const server = new McpServer(
    { name: "modeldock-opencode-go", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

      server.registerTool(
        "web_search_exa",
        {
          title: "Exa Web Search",
          description: "Search the public web through Exa hosted MCP and return source URLs with relevant context.",
          inputSchema: z.object({
            query: z.string().min(1).describe("Web search query"),
            numResults: z.number().int().min(1).max(20).optional().describe("Number of results; defaults to 8"),
            livecrawl: z.enum(["fallback", "preferred"]).optional(),
            type: z.enum(["auto", "fast", "deep"]).optional(),
            contextMaxCharacters: z.number().int().min(1_000).max(50_000).optional(),
          }),
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => {
          try {
            return textResult(await upstreams.searchWeb(args));
          } catch (error) {
            return errorResult(error);
          }
        },
      );

      server.registerTool(
        "vision_inspect",
        {
          title: "Vision Inspect",
          description:
            "Inspect an image attachment referenced by image_ref. Use this before making claims about screenshots, OCR, UI layout, charts, or image comparisons.",
          inputSchema: z.object({
            image_ref: z.string().startsWith("img_").optional().describe("Image reference inserted into the conversation by the Responses gate"),
            compare_image_ref: z.string().startsWith("img_").optional().describe("Optional second image for compare mode"),
            path: z.string().min(1).optional().describe("Absolute local file path of a screenshot to inspect"),
            question: z.string().min(1).describe("What to inspect or extract"),
            mode: z.enum(["general", "ocr", "ui", "chart", "compare"]).optional(),
          }),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args) => {
          try {
            return textResult(await upstreams.inspectVision(args));
          } catch (error) {
            return errorResult(error);
          }
        },
      );

      server.registerTool(
        "speak",
        {
          title: "Text To Speech",
          description:
            "Synthesize the given text into a local speech audio file (Microsoft Edge neural voice, no API key; works on Windows/macOS/Linux - the npm package calls Microsoft's endpoint). Returns the absolute file path of the generated audio (webm/opus) so it can be surfaced in the conversation or used by other tools.",
          inputSchema: z.object({
            text: z.string().min(1).describe("The text to speak aloud. Use short paragraphs for the best result."),
            voice: z.string().optional().describe("Voice name, e.g. zh-CN-XiaoxiaoNeural (Chinese female), en-US-AriaNeural (English female), ja-JP-NanamiNeural (Japanese female). Defaults to zh-CN-XiaoxiaoNeural."),
            output: z.string().optional().describe("Optional absolute file path for the generated audio. Defaults to a temp file."),
          }),
          annotations: { readOnlyHint: false, openWorldHint: false },
        },
        async (args) => {
          try {
            const { ttsSpeak } = await import("./tts.mjs");
            const result = await ttsSpeak(args);
            return textResult([
              "TTS_SPEECH_GENERATED",
              `file: ${result.file}`,
              `bytes: ${result.bytes}`,
              `voice: ${result.voice}`,
              `text: ${result.text}`,
            ].join("\n"));
          } catch (error) {
            return errorResult(error);
          }
        },
      );

      server.registerTool(
        "hear",
        {
          title: "Speech To Text",
          description:
            "Transcribe a local audio file into text. Windows uses the built-in SAPI recognizer; macOS/Linux use whisper.cpp (small native binary, Apple Silicon friendly, no large OpenAI stack; first use auto-downloads the small ggml-tiny model). Returns the recognized text and a confidence score.",
          inputSchema: z.object({
            file: z.string().min(1).describe("Absolute local file path of the audio file to transcribe (mp3, wav, webm/opus, m4a)."),
            language: z.string().optional().describe("Optional language hint, e.g. zh-CN, en-US. Defaults to automatic detection."),
            output: z.string().optional().describe("Optional absolute file path for the intermediate WAV."),
          }),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args) => {
          try {
            const { sttTranscribe } = await import("./stt.mjs");
            const result = await sttTranscribe(args);
            return textResult([
              "STT_TRANSCRIPTION_COMPLETED",
              `text: ${result.text}`,
              `confidence: ${result.confidence.toFixed(3)}`,
              `language: ${result.language}`,
            ].join("\n"));
          } catch (error) {
            return errorResult(error);
          }
        },
      );

  return server;
}

export function createMcpNodeHandler({ upstreams, onError = () => {} }) {
  const handler = createMcpHandler(
    () => createMcpServer({ upstreams }),
    { legacy: "stateless", onerror: onError },
  );
  const nodeHandler = toNodeHandler(handler);
  nodeHandler.close = () => handler.close();
  return nodeHandler;
}
