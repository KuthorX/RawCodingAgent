import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runTurn } from "../src/agent/loop.ts";
import { createMemoryTracer } from "../src/agent/trace.ts";
import { makeDeps, reply, ScriptedProvider } from "./helpers.ts";

test("returns immediately when the model makes no tool calls", async () => {
  const provider = new ScriptedProvider([reply("hello")]);
  const result = await runTurn([], "hi", makeDeps(provider));
  assert.equal(result.finishReason, "end_turn");
  assert.equal(result.steps, 1);
  assert.deepEqual(result.messages.map((m) => m.role), ["user", "assistant"]);
});

test("executes tool calls and feeds results back until done", async () => {
  const provider = new ScriptedProvider([
    reply("", [{ id: "c1", name: "write_file", input: { path: "a.txt", content: "hi" } }]),
    reply("done"),
  ]);
  const deps = makeDeps(provider);
  const result = await runTurn([], "write a file", deps);

  assert.equal(readFileSync(join(deps.workspace, "a.txt"), "utf8"), "hi");
  assert.equal(result.steps, 2);
  const second = provider.requests[1]!.messages.at(-1)!;
  assert.equal(second.role, "tool_results");
  assert.equal(second.role === "tool_results" && second.results[0]!.isError, false);
});

test("returns all parallel results in a single tool_results message", async () => {
  const provider = new ScriptedProvider([
    reply("", [
      { id: "a", name: "write_file", input: { path: "x", content: "1" } },
      { id: "b", name: "write_file", input: { path: "y", content: "2" } },
    ]),
    reply("ok"),
  ]);
  const result = await runTurn([], "go", makeDeps(provider));
  const toolMsgs = result.messages.filter((m) => m.role === "tool_results");
  assert.equal(toolMsgs.length, 1);
  assert.deepEqual(toolMsgs[0]!.role === "tool_results" && toolMsgs[0]!.results.map((r) => r.callId), ["a", "b"]);
});

test("reports unknown tools and invalid arguments as errors instead of throwing", async () => {
  const provider = new ScriptedProvider([
    reply("", [
      { id: "a", name: "nope", input: {} },
      { id: "b", name: "read_file", input: { __invalid_arguments: "{bad" } },
      { id: "c", name: "read_file", input: { path: "missing.txt" } },
    ]),
    reply("ok"),
  ]);
  const result = await runTurn([], "go", makeDeps(provider));
  const msg = result.messages[2]!;
  assert.ok(msg.role === "tool_results");
  assert.ok(msg.results.every((r) => r.isError));
  assert.match(msg.results[0]!.content, /unknown tool/);
  assert.match(msg.results[1]!.content, /not valid JSON/);
  assert.match(msg.results[2]!.content, /ENOENT/);
});

test("denied calls are reported to the model", async () => {
  const provider = new ScriptedProvider([reply("", [{ id: "a", name: "bash", input: { command: "echo hi" } }]), reply("ok")]);
  const result = await runTurn([], "go", makeDeps(provider, { approvalMode: () => "ask", confirm: async () => false }));
  const msg = result.messages[2]!;
  assert.ok(msg.role === "tool_results");
  assert.match(msg.results[0]!.content, /denied/);
});

test("stops at maxSteps, then asks the model for a summary", async () => {
  const call = (n: number) => reply("", [{ id: `a${n}`, name: "bash", input: { command: `echo ${n}` } }]);
  const provider = new ScriptedProvider([call(1), call(2), reply("done A, B is left")]);
  const events: string[] = [];
  const deps = makeDeps(provider, { maxSteps: 2, onEvent: (e) => e.type === "assistant_text" && events.push(e.text) });
  const result = await runTurn([], "go", deps);
  assert.equal(result.finishReason, "max_steps");
  assert.equal(result.steps, 2);
  assert.equal(provider.requests.length, 3);
  const summaryReq = provider.requests[2]!;
  // Same tools as the earlier requests: only the notice is appended, so the prompt cache still hits.
  assert.deepEqual(summaryReq.tools, provider.requests[1]!.tools);
  const notice = summaryReq.messages.at(-1)!;
  assert.match(notice.role === "user" ? notice.content : "", /step limit \(2/);
  assert.deepEqual(events, ["done A, B is left"]);
  assert.deepEqual(result.messages.map((m) => m.role), ["user", "assistant", "tool_results", "assistant", "tool_results", "user", "assistant"]);
});

test("a summary that still calls tools is kept as text only, and a failed summary keeps history valid", async () => {
  const call = reply("", [{ id: "a", name: "bash", input: { command: "echo 1" } }]);
  const sneaky = reply("summary", [{ id: "b", name: "bash", input: { command: "rm -rf /" } }]);
  const kept = await runTurn([], "go", makeDeps(new ScriptedProvider([call, sneaky]), { maxSteps: 1 }));
  const last = kept.messages.at(-1)!;
  assert.deepEqual(last.role === "assistant" && [last.text, last.toolCalls.length], ["summary", 0]);

  // Script exhausted -> summary call throws -> no dangling notice.
  const failed = await runTurn([], "go", makeDeps(new ScriptedProvider([reply("", [{ id: "a", name: "bash", input: { command: "echo 1" } }])]), { maxSteps: 1 }));
  assert.equal(failed.finishReason, "max_steps");
  assert.equal(failed.messages.at(-1)!.role, "tool_results");
});

test("stops when the same call is made several times in a row; different calls in between reset it", async () => {
  const same = (id: string) => reply("", [{ id, name: "bash", input: { command: "cat x" } }]);
  const other = reply("", [{ id: "o", name: "bash", input: { command: "ls" } }]);
  const provider = new ScriptedProvider([same("1"), same("2"), other, same("3"), same("4"), same("5"), reply("stuck on x")]);
  const result = await runTurn([], "go", makeDeps(provider, { maxRepeats: 3 }));
  assert.equal(result.finishReason, "repeated");
  assert.equal(result.steps, 6);
  // The third identical call in a row was not executed.
  const lastResults = result.messages.findLast((m) => m.role === "tool_results")!;
  assert.match(lastResults.role === "tool_results" ? lastResults.results[0]!.content : "", /not executed: the same call/);
});

test("stops when the turn's cost passes the limit", async () => {
  // $0.3/MTok input: 1M tokens = $0.30 per call; limit $0.5 is crossed after the second call.
  const big = (n: number) => reply("", [{ id: `c${n}`, name: "bash", input: { command: `echo ${n}` } }], undefined, { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 });
  const provider = new ScriptedProvider([big(1), big(2), big(3), reply("spent too much")]);
  const result = await runTurn([], "go", makeDeps(provider, { maxTurnCostUsd: 0.5 }));
  assert.equal(result.finishReason, "max_cost");
  assert.equal(result.steps, 2);
  assert.equal(provider.requests.length, 3);
});

test("does not execute tool calls from a truncated response but keeps history valid", async () => {
  const truncated = (id: string) => reply("", [{ id, name: "write_file", input: { path: "x", content: "partial" } }], "max_tokens");
  const provider = new ScriptedProvider([truncated("a"), truncated("b"), truncated("c")]);
  const deps = makeDeps(provider);
  const result = await runTurn([], "go", deps);
  // Two retries asking for smaller pieces, then the turn gives up.
  assert.equal(result.finishReason, "max_tokens");
  assert.equal(provider.requests.length, 3);
  const last = result.messages.at(-1)!;
  assert.ok(last.role === "tool_results" && last.results[0]!.isError);
  assert.throws(() => readFileSync(join(deps.workspace, "x")));
});

test("a tool call cut off by max_tokens is retried in smaller pieces", async () => {
  const events: string[] = [];
  const provider = new ScriptedProvider([
    reply("", [{ id: "a", name: "write_file", input: { path: "x", content: "par" } }], "max_tokens"),
    reply("", [{ id: "b", name: "write_file", input: { path: "x", content: "small" } }]),
    reply("done"),
  ]);
  const deps = makeDeps(provider, { onEvent: (e) => events.push(e.type) });
  const result = await runTurn([], "go", deps);
  assert.equal(result.finishReason, "end_turn");
  assert.equal(readFileSync(join(deps.workspace, "x"), "utf8"), "small");
  const retryPrompt = provider.requests[1]!.messages.at(-1)!;
  assert.ok(retryPrompt.role === "tool_results" && /output token limit/.test(retryPrompt.results[0]!.content));
  assert.ok(events.includes("output_truncated"));
});

test("does not mutate the history passed in", async () => {
  const history = [{ role: "user" as const, content: "earlier" }, reply("earlier reply").message];
  const snapshot = structuredClone(history);
  await runTurn(history, "next", makeDeps(new ScriptedProvider([reply("ok")])));
  assert.deepEqual(history, snapshot);
});

test("system prompt rules are appended in order and unknown rules are rejected", async () => {
  const { buildSystemPrompt, PROMPT_RULES } = await import("../src/agent/system-prompt.ts");
  const { loadConfig } = await import("../src/config.ts");
  const prompt = buildSystemPrompt("/w", ["spec", "debug"]);
  assert.ok(prompt.includes("/w"));
  assert.ok(prompt.endsWith(`${PROMPT_RULES.spec}\n${PROMPT_RULES.debug}`));
  assert.equal(buildSystemPrompt("/w").split("\n").length, 4);
  assert.deepEqual(loadConfig({ OPENAI_API_KEY: "k", AGENT_PROMPT_RULES: " debug, spec ,debug" }).promptRules, ["debug", "spec"]);
  assert.deepEqual(loadConfig({ OPENAI_API_KEY: "k" }).promptRules, ["spec", "tools"]);
  assert.deepEqual(loadConfig({ OPENAI_API_KEY: "k", AGENT_PROMPT_RULES: "" }).promptRules, []);
  assert.throws(() => loadConfig({ OPENAI_API_KEY: "k", AGENT_PROMPT_RULES: "debug,nope" }), /unknown rule\(s\) nope/);
});

// Fails with the given errors first, then answers.
function flakyProvider(errors: Error[]) {
  const provider = new ScriptedProvider([reply("ok")]);
  return {
    name: provider.name,
    model: provider.model,
    calls: 0,
    async complete(req: Parameters<ScriptedProvider["complete"]>[0]) {
      this.calls++;
      const err = errors.shift();
      if (err) throw err;
      return provider.complete(req);
    },
  };
}

test("a model call whose connection dropped is retried, each attempt traced", async () => {
  const tracer = createMemoryTracer();
  const provider = flakyProvider([new TypeError("terminated"), new Error("socket", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) })]);
  const result = await runTurn([], "go", makeDeps(provider, { tracer, retryDelaysMs: [0, 0] }));
  assert.equal(result.finishReason, "end_turn");
  assert.equal(provider.calls, 3);
  assert.deepEqual(tracer.spans.filter((s) => s.kind === "llm").map((s) => [s.status, s.attrs.retry]), [["error", undefined], ["error", 1], ["ok", 2]]);
});

test("model calls give up after the last retry, and other errors are not retried", async () => {
  const dropped = flakyProvider([new TypeError("terminated"), new TypeError("terminated"), new TypeError("terminated")]);
  await assert.rejects(runTurn([], "go", makeDeps(dropped, { retryDelaysMs: [0, 0] })), /terminated/);
  assert.equal(dropped.calls, 3);
  const badRequest = flakyProvider([new Error("400 invalid request")]);
  await assert.rejects(runTurn([], "go", makeDeps(badRequest, { retryDelaysMs: [0, 0] })), /400/);
  assert.equal(badRequest.calls, 1);
});

test("stopping the turn while waiting to retry ends it as interrupted", async () => {
  const controller = new AbortController();
  const provider = flakyProvider([new TypeError("terminated")]);
  setTimeout(() => controller.abort(), 20);
  const result = await runTurn([], "go", makeDeps(provider, { retryDelaysMs: [10_000] }), { signal: controller.signal });
  assert.equal(result.finishReason, "interrupted");
  assert.equal(provider.calls, 1);
});
