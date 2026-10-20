import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runTurn } from "../src/agent/loop.ts";
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

test("stops at maxSteps", async () => {
  const loopCall = () => reply("", [{ id: "a", name: "bash", input: { command: "true" } }]);
  const provider = new ScriptedProvider([loopCall(), loopCall(), loopCall()]);
  const result = await runTurn([], "go", makeDeps(provider, { maxSteps: 2 }));
  assert.equal(result.finishReason, "max_steps");
  assert.equal(provider.requests.length, 2);
});

test("does not execute tool calls from a truncated response but keeps history valid", async () => {
  const provider = new ScriptedProvider([
    reply("", [{ id: "a", name: "write_file", input: { path: "x", content: "partial" } }], "max_tokens"),
  ]);
  const deps = makeDeps(provider);
  const result = await runTurn([], "go", deps);
  assert.equal(result.finishReason, "max_tokens");
  const last = result.messages.at(-1)!;
  assert.ok(last.role === "tool_results" && last.results[0]!.isError);
  assert.throws(() => readFileSync(join(deps.workspace, "x")));
});

test("does not mutate the history passed in", async () => {
  const history = [{ role: "user" as const, content: "earlier" }, reply("earlier reply").message];
  const snapshot = structuredClone(history);
  await runTurn(history, "next", makeDeps(new ScriptedProvider([reply("ok")])));
  assert.deepEqual(history, snapshot);
});
