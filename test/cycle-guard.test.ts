import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CycleGuard, observationHash } from "../src/agent/cycle-guard.ts";
import { executeToolCall, runTurn } from "../src/agent/loop.ts";
import { SessionRunner } from "../src/session/runner.ts";
import type { CompletionRequest, Message, Provider, ToolCall, ToolResult } from "../src/types.ts";
import { makeDeps, reply, ScriptedProvider, tempWorkspace, testRuntime } from "./helpers.ts";

const call = (name: string, id = name, input: Record<string, unknown> = {}): ToolCall => ({ id, name, input });
const result = (content: string, isError = false): ToolResult => ({ callId: "ignored", content, isError });

function observe(guard: CycleGuard, names: string, output = "unchanged"): void {
  for (const [index, name] of [...names].entries()) guard.observe(call(name, String(index)), result(`${name}: ${output}`));
}

function assertProtocol(messages: readonly Message[]): void {
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant" && message.toolCalls.length) {
      const next = messages[index + 1];
      assert.ok(next?.role === "tool_results", "every tool batch must be followed by its results");
      assert.deepEqual(next.results.map((entry) => entry.callId).sort(), message.toolCalls.map((entry) => entry.id).sort());
    }
    if (message.role === "tool_results") assert.equal(messages[index - 1]?.role, "assistant");
  }
}

function reads(count: number): ToolCall[] {
  return Array.from({ length: count }, (_, index) => call("read_file", `read-${index}`, { path: index % 2 ? "b.txt" : "a.txt" }));
}

function workspace(): string {
  const directory = tempWorkspace();
  writeFileSync(join(directory, "a.txt"), "first evidence");
  writeFileSync(join(directory, "b.txt"), "second evidence");
  return directory;
}

test("AB and ABC loops warn after repeated observations and allow a recovery cycle before stopping", () => {
  for (const pattern of ["AB", "ABC"]) {
    const guard = new CycleGuard();
    observe(guard, pattern.repeat(2));
    assert.equal(guard.evaluate(), null);
    observe(guard, pattern);
    assert.deepEqual(guard.evaluate(), { kind: "warning", period: pattern.length });
    assert.equal(guard.evaluate(), null, "evaluation without another observation must not use up the grace period");
    observe(guard, pattern.slice(0, -1));
    assert.equal(guard.evaluate(), null);
    observe(guard, pattern.slice(-1));
    assert.deepEqual(guard.evaluate(), { kind: "stop", period: pattern.length });
  }
});

test("new output, new evidence and explicit reset allow a changed investigation to continue", () => {
  for (const change of ["output", "new call", "reset"]) {
    const guard = new CycleGuard();
    observe(guard, "ABABAB");
    assert.equal(guard.evaluate()?.kind, "warning");
    if (change === "output") guard.observe(call("A"), result("A: newly discovered failure"));
    else if (change === "new call") guard.observe(call("C"), result("new evidence"));
    else guard.reset();
    observe(guard, "AB");
    assert.equal(guard.evaluate(), null, change);
  }
});

test("call IDs and object key order are not evidence, but an error-state change is", () => {
  const guard = new CycleGuard();
  for (let round = 0; round < 3; round++) {
    guard.observe(call("read", `a-${round}`, round % 2 ? { limit: 10, path: "a" } : { path: "a", limit: 10 }), result("same read"));
    guard.observe(call("read", `b-${round}`, { path: "b" }), result("same second read"));
  }
  assert.equal(guard.evaluate()?.kind, "warning");
  guard.observe(call("read", "a-new", { path: "a", limit: 10 }), result("same read", true));
  assert.equal(guard.evaluate(), null);
});

test("updating a plan does not erase a repeated diagnostic cycle", () => {
  const guard = new CycleGuard();
  for (let round = 0; round < 3; round++) {
    observe(guard, "AB");
    guard.observe(call("plan", `plan-${round}`, { items: [{ text: `thinking ${round}`, status: "in_progress" }] }), result(`plan ${round}`));
  }
  assert.equal(guard.evaluate()?.kind, "warning");
  guard.observe(call("plan"), result("new plan text"));
  observe(guard, "AB");
  assert.equal(guard.evaluate()?.kind, "stop");
});

test("known runner timing and ANSI noise normalize without hiding actual values or paths", () => {
  const left = "\u001b[31m✖ rejects invalid input (12.34ms)\u001b[0m\n# duration_ms 123.4\n  duration_ms: 11.1\n=== 1 failed in 0.25s ===\nexpected: 7\nfile: a.ts";
  const right = "✖ rejects invalid input (89.0ms)\n# duration_ms 999.8\n  duration_ms: 55.2\n=== 1 failed in 1.75s ===\nexpected: 7\nfile: a.ts";
  for (const tool of ["bash", "verify_changes"]) {
    assert.equal(observationHash(tool, left), observationHash(tool, right));
    assert.notEqual(observationHash(tool, right), observationHash(tool, right.replace("expected: 7", "expected: 8")));
    assert.notEqual(observationHash(tool, right), observationHash(tool, right.replace("a.ts", "b.ts")));
  }
  assert.notEqual(observationHash("read_file", left), observationHash("read_file", right));
});

test("changes in the truncated middle remain new evidence", async () => {
  let middle = "A";
  const deps = makeDeps(new ScriptedProvider([]), {
    tools: [{ spec: { name: "large", description: "large", inputSchema: {} }, dangerous: false, async run() { return "h".repeat(12_000) + middle + "t".repeat(12_000); } }],
  });
  const first = await executeToolCall(call("large", "first"), deps);
  middle = "B";
  const second = await executeToolCall(call("large", "second"), deps);
  assert.equal(first.content, second.content, "both displayed results have the same head and tail");
  assert.notEqual(first.observationHash, second.observationHash);
  const guard = new CycleGuard();
  for (let index = 0; index < 3; index++) {
    guard.observe(call("large"), first);
    guard.observe(call("other"), result("same"));
  }
  assert.equal(guard.evaluate()?.kind, "warning");
  guard.observe(call("large"), second);
  guard.observe(call("other"), result("same"));
  assert.equal(guard.evaluate(), null);
});

test("runTurn delivers the warning before the next request, then stops a continued cycle with valid history", async () => {
  const provider = new ScriptedProvider([...reads(8).map((entry) => reply("", [entry])), reply("The investigation repeated; a new hypothesis is needed.")]);
  const outcome = await runTurn([], "investigate", makeDeps(provider, { workspace: workspace(), maxSteps: 20 }));
  assert.equal(outcome.finishReason, "stagnant");
  assert.match(JSON.stringify(provider.requests[6]!.messages.at(-1)), /agent loop warning/);
  assert.equal(provider.requests.filter((request) => JSON.stringify(request.messages.at(-1)).includes("agent loop warning")).length, 1);
  assert.match(JSON.stringify(provider.requests.at(-1)!.messages.at(-1)), /agent limit/);
  for (const request of provider.requests) assertProtocol(request.messages);
  assertProtocol(outcome.messages);
});

test("a real edit later in the same batch prevents a false cycle warning", async () => {
  const directory = workspace();
  const provider = new ScriptedProvider([
    reply("", [...reads(6), call("write_file", "fix", { path: "a.txt", content: "new evidence" })]),
    reply("fixed"),
  ]);
  const outcome = await runTurn([], "fix", makeDeps(provider, { workspace: directory }));
  assert.equal(outcome.finishReason, "end_turn");
  assert.equal(readFileSync(join(directory, "a.txt"), "utf8"), "new evidence");
  assert.doesNotMatch(JSON.stringify(provider.requests), /agent loop warning/);
  assertProtocol(outcome.messages);
});

test("an interjection resets the warning and both repeat histories", async () => {
  const provider = new ScriptedProvider([...reads(8).map((entry) => reply("", [entry])), reply("continued after the user clarified")]);
  let completed = 0;
  let delivered = false;
  const outcome = await runTurn([], "investigate", makeDeps(provider, {
    workspace: workspace(), maxSteps: 20,
    onEvent: (event) => { if (event.type === "tool_result") completed++; },
  }), {
    takeInterjections: () => {
      if (completed === 7 && !delivered) { delivered = true; return [{ role: "user", content: "Repeat the second inspection once for comparison." }]; }
      return [];
    },
  });
  assert.equal(outcome.finishReason, "end_turn");
  assert.match(JSON.stringify(provider.requests[7]!.messages.at(-1)), /User interjection/);
  assertProtocol(outcome.messages);
});

test("observed workspace progress resets cycles even when command output stays unchanged", async () => {
  let revision = 0;
  let calls = 0;
  const bash = { spec: { name: "bash", description: "controlled command", inputSchema: {} }, dangerous: false, async run() { calls++; if (calls === 7) revision++; return "same output"; } };
  const alternating = Array.from({ length: 8 }, (_, index) => reply("", [call("bash", `bash-${index}`, { command: index % 2 ? "test B" : "test A" })]));
  const provider = new ScriptedProvider([...alternating, reply("progress was made")]);
  const outcome = await runTurn([], "fix", makeDeps(provider, { tools: [bash], progressVersion: () => revision, maxSteps: 20 }));
  assert.equal(outcome.finishReason, "end_turn");
  assert.match(JSON.stringify(provider.requests[6]!.messages.at(-1)), /agent loop warning/);
});

test("unknown Bash without progress observations is not falsely classified as stagnant", async () => {
  const provider = new ScriptedProvider([
    ...Array.from({ length: 8 }, (_, index) => reply("", [call("bash", `bash-${index}`, { command: index % 2 ? "change B" : "change A" })])),
    reply("done"),
  ]);
  const outcome = await runTurn([], "work", makeDeps(provider, {
    tools: [{ spec: { name: "bash", description: "unknown", inputSchema: {} }, dangerous: false, async run() { return ""; } }], maxSteps: 20,
  }));
  assert.equal(outcome.finishReason, "end_turn");
  assert.doesNotMatch(JSON.stringify(provider.requests), /agent loop warning/);
});

test("abort and exhausted budget take priority over a pending cycle warning", async () => {
  for (const cause of ["abort", "budget"]) {
    const controller = new AbortController();
    let completed = 0;
    const provider = new ScriptedProvider(reads(6).map((entry) => reply("", [entry])));
    const outcome = await runTurn([], "investigate", makeDeps(provider, {
      workspace: workspace(), maxSteps: 20,
      checkBudget: () => cause === "budget" && completed === 6 ? "budget" : null,
      onEvent: (event) => {
        if (event.type === "tool_result" && ++completed === 6 && cause === "abort") controller.abort();
      },
    }), { signal: controller.signal });
    assert.equal(outcome.finishReason, cause === "abort" ? "interrupted" : "budget");
    assert.equal(provider.requests.length, 6);
    assert.doesNotMatch(JSON.stringify(outcome.messages), /agent loop warning/);
    assertProtocol(outcome.messages);
  }
});

test("normal sessions detect alternating reads and failed real commands with unchanged workspace content", async () => {
  const directory = workspace();
  writeFileSync(join(directory, "check.cjs"), 'process.stdout.write("same assertion failure\\n"); process.exitCode = 1;');
  const calls = Array.from({ length: 8 }, (_, index) => index % 2
    ? call("bash", `check-${index}`, { command: "node check.cjs" })
    : call("read_file", `read-${index}`, { path: "a.txt" }));
  const provider = new ScriptedProvider([...calls.map((entry) => reply("", [entry])), reply("A different diagnosis is needed.")]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(directory, provider.model, "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  await runner.send("diagnose the failure").done;
  const end = runtime.store.loadEvents(meta.id).at(-1)!;
  assert.ok(end.type === "turn_end" && end.finishReason === "stagnant");
  assert.match(runtime.store.readFile(meta.id, "trace.jsonl"), /"loop_warning"/);
  assertProtocol(runtime.store.loadMessages(meta.id));
  assert.equal(provider.requests.length, 9);
  runner.close();
});

test("context preparation cannot remove the recovery warning before delivery or its overflow retry", async () => {
  for (const overflow of [false, true]) {
    const scripted = new ScriptedProvider([...reads(8).map((entry) => reply("", [entry])), reply("The repeated investigation needs another approach.")]);
    const requests: CompletionRequest[] = [];
    let forcedPreparations = 0;
    const provider: Provider = {
      name: "compacting", model: "compacting",
      async complete(request) {
        requests.push(structuredClone(request));
        if (overflow && requests.length === 7) throw new Error("context_length_exceeded");
        return scripted.complete(request);
      },
    };
    const outcome = await runTurn([], "investigate", makeDeps(provider, {
      workspace: workspace(), maxSteps: 20,
      prepareContext: async (messages, _signal, force) => {
        if (force) forcedPreparations++;
        return messages.filter((message) => !(message.role === "user" && message.content.startsWith("[agent loop warning]")));
      },
    }));
    assert.equal(outcome.finishReason, "stagnant");
    assert.match(JSON.stringify(requests[6]!.messages.at(-1)), /agent loop warning/);
    if (overflow) assert.match(JSON.stringify(requests[7]!.messages.at(-1)), /agent loop warning/);
    assert.equal(forcedPreparations, overflow ? 1 : 0);
    for (const request of requests) assertProtocol(request.messages);
    assertProtocol(outcome.messages);
  }
});

test("failed verification commands that change workspace content do not trigger stagnation", async () => {
  const directory = workspace();
  writeFileSync(join(directory, ".agent-checks.json"), JSON.stringify({ commands: ["node check.cjs"] }));
  writeFileSync(join(directory, "check.cjs"), 'require("node:fs").appendFileSync("progress.txt", "x"); process.stdout.write("same failure\\n"); process.exitCode = 1;');
  const calls = Array.from({ length: 8 }, (_, index) => index % 2
    ? call("verify_changes", `verify-${index}`)
    : call("read_file", `read-${index}`, { path: "a.txt" }));
  const provider = new ScriptedProvider([...calls.map((entry) => reply("", [entry])), reply("Verification still fails.")]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(directory, provider.model, "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  try {
    await runner.send("investigate the failing checker").done;
    const end = runtime.store.loadEvents(meta.id).at(-1)!;
    assert.ok(end.type === "turn_end" && end.finishReason === "unverified");
    assert.equal(readFileSync(join(directory, "progress.txt"), "utf8"), "xxxx");
    assert.doesNotMatch(runtime.store.readFile(meta.id, "trace.jsonl"), /"loop_warning"/);
    assert.doesNotMatch(JSON.stringify(provider.requests), /agent loop warning/);
    assertProtocol(runtime.store.loadMessages(meta.id));
  } finally { runner.close(); }
});
