import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { parseArguments, toOpenAIMessages } from "../src/providers/openai.ts";
import type { Message } from "../src/types.ts";

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
