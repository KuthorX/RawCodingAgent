import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getCatalogModel, listCatalogModels, PROVIDERS, validateModelSelection } from "../src/providers/catalog.ts";
import { PI_MAX_OUTPUT_TOKENS, PiProvider, PiProviderError, toPiContext } from "../src/providers/pi.ts";
import type { CompletionRequest, Message, ModelDelta } from "../src/types.ts";

interface Call { url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }
async function endpoint(t: TestContext, respond: (call: Call, res: ServerResponse) => void) {
  const calls: Call[] = [];
  const server = createServer(async (req, res) => {
    try {
      let text = "";
      for await (const chunk of req) text += String(chunk);
      const call = { url: req.url ?? "", headers: req.headers, body: JSON.parse(text) as Record<string, unknown> };
      calls.push(call);
      respond(call, res);
    } catch { res.destroy(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

const request: CompletionRequest = {
  system: "Follow the task.", messages: [{ role: "user", content: "Inspect the file." }],
  tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
};
const sse = (events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
const namedSse = (events: { type: string; [key: string]: unknown }[]) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

function deepseekReply(tool = false) {
  return sse([
    { choices: [{ index: 0, delta: { reasoning_content: "inspect reasoning" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] },
    ...(tool ? [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_ds", type: "function", function: { name: "read_file", arguments: '{"path":' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }, finish_reason: "tool_calls" }] },
    ] : [{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]),
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 40, total_tokens: 110 } },
  ]);
}

test("Pi catalog scopes model IDs and thinking levels to a provider", () => {
  for (const provider of PROVIDERS.filter((provider) => provider.id !== "legacy")) {
    assert.ok(listCatalogModels(provider.id).some((model) => model.id === provider.defaultModel));
  }
  const flash = getCatalogModel("deepseek", "deepseek-flash");
  assert.deepEqual(flash.thinkingLevels, ["off", "low", "high", "max"]);
  assert.equal(flash.vision, true);
  assert.throws(() => validateModelSelection({ provider: "deepseek", model: "deepseek-flash", thinkEffort: "medium" }), /not supported/);
  assert.throws(() => getCatalogModel("anthropic", "deepseek-flash"), /Unknown model/);
  assert.throws(() => validateModelSelection({ provider: "openai", model: "gpt-6.1-sol", thinkEffort: "off" }), /not supported/);
});

test("Pi refuses a missing explicit key even when a provider key is in the environment", async () => {
  const saved = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "ambient-key-must-not-be-used";
  try {
    const provider = new PiProvider({ provider: "deepseek", model: "deepseek-flash", thinkEffort: "off" }, { apiKey: "" });
    await assert.rejects(provider.complete(request), /No API key configured/);
  } finally {
    if (saved === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = saved;
  }
});

test("Pi DeepSeek streams reasoning/tools, replays native reasoning, and accounts for cache tokens once", async (t) => {
  let count = 0;
  const server = await endpoint(t, (_call, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(deepseekReply(++count === 1)); });
  const provider = new PiProvider({ provider: "deepseek", model: "deepseek-flash", thinkEffort: "high" }, { apiKey: "test-deepseek-key", baseURL: `${server.url}/v1` });
  const deltas: ModelDelta[] = [];
  const first = await provider.complete(request, undefined, (delta) => deltas.push(delta));
  assert.equal(first.stopReason, "tool_use");
  assert.deepEqual(first.message.toolCalls, [{ id: "call_ds", name: "read_file", input: { path: "README.md" } }]);
  assert.equal(first.message.reasoningContent, "inspect reasoning");
  assert.equal(first.message.piMessage?.provider, "deepseek");
  assert.equal(first.usage.inputTokens, 100);
  assert.equal(first.usage.cachedInputTokens, 40);
  assert.equal(first.usage.outputTokens, 10);
  const rates = getCatalogModel("deepseek", "deepseek-flash").cost;
  assert.ok(Math.abs(first.usage.costUsd! - (60 * rates.input + 40 * rates.cacheRead + 10 * rates.output) / 1_000_000) < 1e-12);
  assert.equal(deltas.flatMap((delta) => delta.text ?? []).join(""), "hello");
  assert.equal(deltas.flatMap((delta) => delta.reasoning ?? []).join(""), "inspect reasoning");
  await provider.complete({ ...request, messages: [...request.messages, first.message, { role: "tool_results", results: [{ callId: "call_ds", content: "file content", isError: false }] }] });
  const sent = server.calls[1]!.body as { messages: { role: string; reasoning_content?: string; tool_call_id?: string }[]; thinking: { type: string }; reasoning_effort: string; max_tokens: number };
  assert.equal(sent.messages.find((message) => message.role === "assistant")?.reasoning_content, "inspect reasoning");
  assert.equal(sent.messages.find((message) => message.role === "tool")?.tool_call_id, "call_ds");
  assert.equal(sent.thinking.type, "enabled");
  assert.equal(sent.reasoning_effort, "high");
  assert.equal(sent.max_tokens, PI_MAX_OUTPUT_TOKENS);
  assert.equal(server.calls[0]!.url, "/v1/chat/completions");
  assert.equal(server.calls[0]!.headers.authorization, "Bearer test-deepseek-key");
});

test("native DeepSeek off explicitly disables thinking for every catalog model exposing off", async (t) => {
  const server = await endpoint(t, (_call, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse([{ choices: [{ index: 0, delta: { content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }]));
  });
  const models = listCatalogModels("deepseek").filter((model) => model.thinkingLevels.includes("off"));
  assert.ok(models.length > 0);
  for (const model of models) {
    const provider = new PiProvider({ provider: "deepseek", model: model.id, thinkEffort: "off" }, { apiKey: "test-key", baseURL: `${server.url}/v1` });
    await provider.complete(request);
  }
  assert.equal(server.calls.length, models.length);
  for (const call of server.calls) {
    assert.deepEqual(call.body.thinking, { type: "disabled" });
    assert.equal(call.body.reasoning_effort, undefined);
  }
});

function anthropicReply() {
  return namedSse([
    { type: "message_start", message: { id: "msg_a", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "signed thinking" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque-anthropic-signature" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_a", name: "read_file", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 8 } },
    { type: "message_stop" },
  ]);
}

test("Pi Anthropic preserves signatures, counts cache writes, and caps thinking plus answer output", async (t) => {
  const server = await endpoint(t, (_call, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(anthropicReply()); });
  const provider = new PiProvider({ provider: "anthropic", model: "claude-sonnet-4-5", thinkEffort: "high" }, { apiKey: "test-anthropic-key", baseURL: server.url });
  const first = await provider.complete(request);
  assert.equal(first.stopReason, "tool_use");
  assert.equal(first.message.piMessage?.content.find((block) => block.type === "thinking")?.thinkingSignature, "opaque-anthropic-signature");
  assert.equal(first.usage.inputTokens, 100);
  assert.equal(first.usage.cachedInputTokens, 20);
  assert.equal(first.usage.cacheWriteTokens, 30);
  const rates = getCatalogModel("anthropic", "claude-sonnet-4-5").cost;
  assert.ok(Math.abs(first.usage.costUsd! - (50 * rates.input + 20 * rates.cacheRead + 30 * rates.cacheWrite + 8 * rates.output) / 1_000_000) < 1e-12);
  const body = server.calls[0]!.body as { max_tokens: number; thinking: { type: string; budget_tokens: number } };
  assert.ok(body.max_tokens <= PI_MAX_OUTPUT_TOKENS);
  assert.ok(body.thinking.budget_tokens < body.max_tokens);
  assert.equal(server.calls[0]!.url, "/v1/messages?beta=true");
  const followup = { ...request, messages: [...request.messages, first.message, { role: "tool_results" as const, results: [{ callId: "tool_a", content: "file", isError: false }] }] };
  await provider.complete(followup);
  assert.match(JSON.stringify(server.calls[1]!.body), /opaque-anthropic-signature/);
  const cross = await endpoint(t, (_call, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(deepseekReply()); });
  await new PiProvider({ provider: "deepseek", model: "deepseek-flash", thinkEffort: "off" }, { apiKey: "test-key", baseURL: `${cross.url}/v1` }).complete(followup);
  assert.doesNotMatch(JSON.stringify(cross.calls[0]!.body), /opaque-anthropic-signature|signed thinking/);
  assert.match(JSON.stringify(cross.calls[0]!.body), /tool_a/);
});

test("Pi OpenAI uses Responses and retains encrypted reasoning and text signatures", async (t) => {
  const reasoning = { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "considered" }], encrypted_content: "encrypted-reasoning" };
  const message = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "answer", annotations: [] }] };
  const server = await endpoint(t, (_call, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(namedSse([
      { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { ...reasoning, summary: [], encrypted_content: undefined } },
      { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "considered" },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      { type: "response.output_item.added", output_index: 1, item: { ...message, content: [] } },
      { type: "response.output_text.delta", output_index: 1, delta: "answer" },
      { type: "response.output_item.done", output_index: 1, item: message },
      { type: "response.completed", response: { id: "resp_1", status: "completed", output: [reasoning, message], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 120 } } },
    ]));
  });
  const provider = new PiProvider({ provider: "openai", model: "gpt-6.1-sol", thinkEffort: "xhigh" }, { apiKey: "test-openai-key", baseURL: `${server.url}/v1` });
  const result = await provider.complete(request);
  assert.equal(result.message.text, "answer");
  assert.equal(result.message.piMessage?.api, "openai-responses");
  assert.match(result.message.piMessage?.content.find((block) => block.type === "thinking")?.thinkingSignature ?? "", /encrypted-reasoning/);
  assert.ok(result.message.piMessage?.content.find((block) => block.type === "text")?.textSignature);
  assert.deepEqual([result.usage.inputTokens, result.usage.cachedInputTokens, result.usage.cacheWriteTokens, result.usage.outputTokens], [100, 30, 10, 20]);
  const sent = server.calls[0]!.body as { reasoning: { effort: string }; max_output_tokens: number; input: unknown[] };
  // New Responses models encode the selected effort as a transcript configuration update.
  assert.ok(sent.input.some((item) => typeof item === "object" && item !== null && (item as { type?: string }).type === "configuration_update" && (item as { reasoning?: { effort?: string } }).reasoning?.effort === "xhigh"));
  assert.equal(result.message.piMessage?.providerThinkingLevel, "xhigh");
  assert.equal(sent.max_output_tokens, PI_MAX_OUTPUT_TOKENS);
  assert.ok(Array.isArray(sent.input));
  assert.equal(server.calls[0]!.url, "/v1/responses");
  await provider.complete({ ...request, messages: [...request.messages, result.message, { role: "user", content: "continue" }] });
  assert.match(JSON.stringify(server.calls[1]!.body), /encrypted-reasoning/);
});

test("Pi Google uses its native protocol and streaming preference only controls UI deltas", async (t) => {
  const server = await endpoint(t, (_call, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "google answer" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 3, candidatesTokenCount: 4, thoughtsTokenCount: 2, totalTokenCount: 16 } })}\n\n`);
  });
  const provider = new PiProvider({ provider: "google", model: "gemini-2.5-flash", thinkEffort: "off" }, { apiKey: "test-google-key", baseURL: `${server.url}/v1beta`, stream: false });
  const deltas: ModelDelta[] = [];
  const result = await provider.complete(request, undefined, (delta) => deltas.push(delta));
  assert.equal(result.message.text, "google answer");
  assert.deepEqual([result.usage.inputTokens, result.usage.cachedInputTokens, result.usage.outputTokens], [10, 3, 6]);
  assert.deepEqual(deltas, []);
  assert.match(server.calls[0]!.url, /models\/gemini-2\.5-flash:streamGenerateContent/);
  assert.ok(Array.isArray(server.calls[0]!.body.contents));
});

test("Pi abort and provider errors reject partial tool calls, preserve known usage and redact explicit keys", async (t) => {
  const server = await endpoint(t, (_call, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse([
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
      { choices: [{ index: 0, delta: { content: "partial", tool_calls: [{ index: 0, id: "unfinished", type: "function", function: { name: "read_file", arguments: '{"path":' } }] }, finish_reason: null }] },
    ]).replace("data: [DONE]\n\n", ""));
  });
  const provider = new PiProvider({ provider: "deepseek", model: "deepseek-flash", thinkEffort: "off" }, { apiKey: "test-key", baseURL: `${server.url}/v1` });
  const controller = new AbortController();
  await assert.rejects(provider.complete(request, controller.signal, () => controller.abort()), (error: unknown) => {
    assert.ok(error instanceof PiProviderError);
    assert.equal(error.stopReason, "aborted");
    assert.equal(error.usage?.inputTokens, 12);
    return true;
  });
  const failed = await endpoint(t, (_call, res) => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "rejected private-test-key", type: "invalid_request_error" } })); });
  const bad = new PiProvider({ provider: "deepseek", model: "deepseek-flash", thinkEffort: "off" }, { apiKey: "private-test-key", baseURL: `${failed.url}/v1` });
  await assert.rejects(bad.complete(request), (error: unknown) => {
    assert.ok(error instanceof PiProviderError);
    assert.doesNotMatch(error.message, /private-test-key/);
    assert.match(error.message, /REDACTED/);
    return true;
  });
});

test("Pi context retains native provenance and labels old histories as legacy", () => {
  const native: AssistantMessage = { role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5", content: [{ type: "thinking", thinking: "", thinkingSignature: "encrypted", redacted: true }, { type: "toolCall", id: "native", name: "read_file", arguments: { path: "a" }, thoughtSignature: "tool-signature" }], timestamp: 1, stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const messages: Message[] = [
    { role: "assistant", text: "old", reasoningContent: "old reasoning", toolCalls: [] },
    { role: "assistant", text: "", toolCalls: [{ id: "native", name: "read_file", input: { path: "a" } }], piMessage: native },
    { role: "tool_results", results: [{ callId: "native", content: "file contents", isError: false }] },
  ];
  const context = toPiContext({ ...request, messages }, false);
  assert.ok(context.messages[0]?.role === "assistant" && context.messages[0].provider === "legacy");
  assert.equal(context.messages[1], native);
  assert.ok(context.messages[2]?.role === "toolResult" && context.messages[2].toolName === "read_file");
});
