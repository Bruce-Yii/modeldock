import { test } from "node:test";
import assert from "node:assert/strict";
import {
  responsesToChatRequest,
  chatChunkToResponsesEvents,
  chatCampForRequest,
  chatEndpointFor,
} from "./chat-bridge.mjs";

const GO_CONFIG = {
  goBaseUrl: "https://opencode.ai/zen/go/v1",
  profile: { id: "opencode-go" },
};

test("chatCampForRequest: opencode-go defaults to chat camp except responses-only models", () => {
  assert.equal(chatCampForRequest("deepseek-v4-flash", GO_CONFIG), "chat");
  assert.equal(chatCampForRequest("deepseek-v4-flash-free", GO_CONFIG), "zen-free");
  assert.equal(chatCampForRequest("minimax-m3", GO_CONFIG), "chat");
  assert.equal(chatCampForRequest("gpt-5.6-luna", GO_CONFIG), "responses");
  assert.equal(chatCampForRequest("grok-4.5", GO_CONFIG), "responses");
});

test("chatCampForRequest: non-opencode profiles and overrides pin the responses wire", () => {
  const deepseekConfig = { ...GO_CONFIG, profile: { id: "deepseek-official" } };
  assert.equal(chatCampForRequest("deepseek-v4-flash", deepseekConfig), "responses");
  const overridden = { ...GO_CONFIG, profile: { id: "opencode-go", chatCampOverride: "responses" } };
  assert.equal(chatCampForRequest("deepseek-v4-flash", overridden), "responses");
});

test("chatEndpointFor: deepseek chat on go base, free on zen, luna on responses", () => {
  const go = chatEndpointFor("deepseek-v4-flash", GO_CONFIG);
  assert.equal(go.url, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(go.style, "chat");

  const free = chatEndpointFor("deepseek-v4-flash-free", GO_CONFIG);
  assert.equal(free.url, "https://opencode.ai/zen/v1/chat/completions");
  assert.equal(free.style, "chat");

  const luna = chatEndpointFor("gpt-5.6-luna", GO_CONFIG);
  assert.equal(luna.url, "https://opencode.ai/zen/go/v1/responses");
  assert.equal(luna.style, "responses");
});

test("responsesToChatRequest: native tool pairs become chat dialect messages", () => {
  const payload = {
    model: "deepseek-v4-flash",
    stream: true,
    max_output_tokens: 128,
    input: [
      { role: "user", content: [{ type: "input_text", text: "Run ls" }] },
      { type: "function_call", call_id: "call_1", name: "shell_command", arguments: JSON.stringify({ command: "ls" }) },
      { type: "function_call_output", call_id: "call_1", output: "file1.txt" },
      { role: "user", content: [{ type: "input_text", text: "Done?" }] },
    ],
    tools: [{ type: "function", name: "shell_command", parameters: { type: "object", properties: { command: { type: "string" } } } }],
  };
  const chat = responsesToChatRequest(payload);
  assert.equal(chat.model, "deepseek-v4-flash");
  assert.equal(chat.max_tokens, 128);
  assert.equal(chat.stream, true);
  assert.equal(chat.messages.length, 4);
  assert.deepEqual(chat.messages[0], { role: "user", content: "Run ls" });
  assert.equal(chat.messages[1].role, "assistant");
  assert.equal(chat.messages[1].content, null);
  assert.equal(chat.messages[1].tool_calls.length, 1);
  assert.equal(chat.messages[1].tool_calls[0].id, "call_1");
  assert.equal(chat.messages[1].tool_calls[0].function.name, "shell_command");
  assert.equal(chat.messages[2].role, "tool");
  assert.equal(chat.messages[2].tool_call_id, "call_1");
  assert.equal(chat.messages[2].content, "file1.txt");
  assert.deepEqual(chat.tools[0], {
    type: "function",
    function: { name: "shell_command", description: "", parameters: { type: "object", properties: { command: { type: "string" } } } },
  });
});

test("responsesToChatRequest: orphan outputs become user notes, tool_choice passes through", () => {
  const payload = {
    model: "m",
    input: [
      { type: "function_call_output", call_id: "call_x", output: "orphan result" },
      { role: "user", content: "hi" },
    ],
    tool_choice: "required",
  };
  const chat = responsesToChatRequest(payload);
  assert.equal(chat.messages.length, 2);
  assert.equal(chat.messages[0].role, "user");
  assert.match(chat.messages[0].content, /orphan result/);
  assert.equal(chat.tool_choice, "required");
});

test("responsesToChatRequest: assistant string/array content flattens to text", () => {
  const payload = {
    model: "m",
    input: [
      { role: "assistant", content: "plain text" },
      { role: "assistant", content: [{ type: "output_text", text: "part one" }, { type: "output_text", text: "part two" }] },
    ],
  };
  const chat = responsesToChatRequest(payload);
  assert.equal(chat.messages[0].content, "plain text");
  assert.equal(chat.messages[1].content, "part onepart two");
});

test("chatChunkToResponsesEvents: text, reasoning, tool_calls and finish map to Responses events", () => {
  const events = [...chatChunkToResponsesEvents({
    choices: [{ index: 0, delta: { reasoning_content: "think...", content: "hello" } }],
  })];
  assert.deepEqual(events.map((e) => e.type), ["response.reasoning_text.delta", "response.output_text.delta"]);
  assert.equal(events[1].delta, "hello");

  const toolEvents = [...chatChunkToResponsesEvents({
    choices: [{ index: 0, delta: { tool_calls: [{ id: "call_t", function: { name: "shell_command", arguments: "" } }] } }],
  })];
  assert.equal(toolEvents[0].type, "response.output_item.added");
  assert.equal(toolEvents[0].item.type, "function_call");
  assert.equal(toolEvents[0].item.name, "shell_command");
  assert.equal(toolEvents[0].item.call_id, "call_t");

  const argEvents = [...chatChunkToResponsesEvents({
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"cmd" } }] } }],
  })];
  assert.equal(argEvents[0].type, "response.function_call_arguments.delta");
  assert.equal(argEvents[0].delta, '{"cmd');

  const done = [...chatChunkToResponsesEvents({
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })];
  assert.equal(done[0].type, "response.completed");
  assert.deepEqual(done[0].response.usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
});
