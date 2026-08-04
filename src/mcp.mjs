import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";

function textResult(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

function errorResult(error) {
  return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
}

export function createMcpNodeHandler({ upstreams, onError = () => {} }) {
  const handler = createMcpHandler(
    () => {
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

      return server;
    },
    { legacy: "stateless", onerror: onError },
  );

  const nodeHandler = toNodeHandler(handler);
  nodeHandler.close = () => handler.close();
  return nodeHandler;
}
