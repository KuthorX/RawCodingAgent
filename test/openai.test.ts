import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { loadConfig, sanitizeToolEnv } from "../src/config.ts";
import { loadPricing, pricingForModel } from "../src/pricing.ts";
import { OpenAIProvider, parseArguments, toOpenAIMessages } from "../src/providers/openai.ts";
import type { Message, ModelDelta } from "../src/types.ts";

const conversation: Message[] = [
  { role: "user", content: "fix it" },
  { role: "assistant", text: "looking", toolCalls: [{ id: "t1", name: "read_file", input: { path: "a" } }] },
  { role: "tool_results", results: [{ callId: "t1", content: "boom", isError: true }] },
];

test("openai: system first, tool calls stringified, one tool message per result", () => {
  const out = toOpenAIMessages("sys", conversation);
  assert.deepEqual(out[0], { role: "system", content: "sys" });
  assert.deepEqual(out[2], {
    role: "assistant",
    content: "looking",
    tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }],
  });
  assert.deepEqual(out[3], { role: "tool", tool_call_id: "t1", content: "ERROR: boom" });
});

test("openai: preserves DeepSeek reasoning content for thinking models", () => {
  const out = toOpenAIMessages("sys", [{ role: "assistant", text: "", reasoningContent: "private chain", toolCalls: [] }]);
  assert.deepEqual(out[1], { role: "assistant", content: null, reasoning_content: "private chain" });
});

test("openai: thinking models accept old assistant history without reasoning content", () => {
  const out = toOpenAIMessages("sys", [{ role: "assistant", text: "old answer", toolCalls: [] }], false, "deepseek-flash");
  assert.deepEqual(out[1], { role: "assistant", content: "old answer", reasoning_content: "" });
});

test("openai: malformed arguments are flagged, not thrown", () => {
  assert.deepEqual(parseArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(parseArguments(""), {});
  assert.deepEqual(parseArguments("{bad"), { __invalid_arguments: "{bad" });
  assert.deepEqual(parseArguments("[1]"), { __invalid_arguments: "[1]" });
});

test("config requires an API key and validates values", () => {
  assert.throws(() => loadConfig({}), /OPENAI_API_KEY/);
  assert.throws(() => loadConfig({ OPENAI_API_KEY: "k", AGENT_MAX_STEPS: "-1" }), /AGENT_MAX_STEPS/);
  assert.equal(loadConfig({ OPENAI_API_KEY: "k", AGENT_MAX_STEPS: "0" }).maxSteps, null);
  assert.equal(loadConfig({ OPENAI_API_KEY: "k", AGENT_MAX_STEPS: "40" }).maxSteps, 40);
  const config = loadConfig({ OPENAI_API_KEY: "k" });
  assert.equal(config.maxSteps, null); // no step limit by default
  assert.equal(config.llm.model, "deepseek-chat");
  assert.equal(config.llm.baseURL, undefined);
});

test("tool environment removes credentials but keeps Git control variables", () => {
  const env = sanitizeToolEnv({ OPENAI_API_KEY: "secret", TAVILY_API_KEY: "secret", GIT_CONFIG_KEY_0: "x", PATH: "/bin" });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.TAVILY_API_KEY, undefined);
  assert.equal(env.GIT_CONFIG_KEY_0, "x");
  assert.equal(env.PATH, "/bin");
});

test("config accepts model-specific context windows and pricing overrides", () => {
  const config = loadConfig({
    OPENAI_API_KEY: "k",
    MODEL_CONTEXT_WINDOWS_JSON: '{"deepseek-chat":64000}',
  });
  assert.equal(config.contextWindows["deepseek-chat"], 64000);
});

test("model-specific vision capability follows model switching", () => {
  const provider = new OpenAIProvider({ apiKey: "k", baseURL: undefined, model: "text", vision: false, stream: false, visionModels: { vision: true } });
  assert.equal(provider.vision, false);
  provider.setModel?.("vision");
  assert.equal(provider.vision, true);
});

test("pricing override selects the active model rates", () => {
  const pricing = loadPricing({ MODEL_PRICING_JSON: '{"m":{"inputPerMTok":1,"cachedInputPerMTok":0.1,"outputPerMTok":2}}' });
  assert.deepEqual(pricingForModel(pricing, "m"), { inputPerMTok: 1, cachedInputPerMTok: 0.1, outputPerMTok: 2 });
});

const request = { system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

function sse(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

test("openai: streamed text, tool-call fragments and usage are assembled", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse([
      { id: "1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: "he" }, finish_reason: null }] },
      { id: "1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: "llo" }, finish_reason: null }] },
      { id: "1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":' } }] }, finish_reason: null }] },
      { id: "1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, finish_reason: "tool_calls" }] },
      { id: "1", object: "chat.completion.chunk", created: 0, model: "m", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } } },
    ]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const provider = new OpenAIProvider({ apiKey: "k", baseURL: `http://127.0.0.1:${port}/v1`, model: "m", vision: false, stream: true });
    const deltas: ModelDelta[] = [];
    const result = await provider.complete(request, undefined, (delta) => deltas.push(delta));
    assert.equal(result.message.text, "hello");
    assert.deepEqual(result.message.toolCalls, [{ id: "call_1", name: "read_file", input: { path: "a" } }]);
    assert.equal(result.stopReason, "tool_use");
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, cachedInputTokens: 4 });
    assert.deepEqual(deltas.map((d) => d.text), ["he", "llo"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("openai: an endpoint that rejects streaming falls back to a normal request", async () => {
  let sawStream = false;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as { stream?: boolean };
      sawStream ||= body.stream === true;
      if (body.stream) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "stream_options is not supported" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "1", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "fallback" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const provider = new OpenAIProvider({ apiKey: "k", baseURL: `http://127.0.0.1:${port}/v1`, model: "m", vision: false, stream: true });
    const deltas: ModelDelta[] = [];
    const result = await provider.complete(request, undefined, (delta) => deltas.push(delta));
    assert.equal(sawStream, true);
    assert.equal(result.message.text, "fallback");
    assert.equal(deltas.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
