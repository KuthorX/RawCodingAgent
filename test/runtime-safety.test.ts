import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createRuntime } from "../src/app.ts";
import { estimateTokens, requestTokens } from "../src/agent/context.ts";
import { Verification } from "../src/agent/verification.ts";
import { runShell } from "../src/tools/bash.ts";
import { createMemoryTracer } from "../src/agent/trace.ts";
import { executeToolCall, runTurn, TurnAbortedError } from "../src/agent/loop.ts";
import { sanitizeToolEnv } from "../src/config.ts";
import { SessionRunner } from "../src/session/runner.ts";
import { SessionStore } from "../src/session/store.ts";
import { parseTrace, totals } from "../src/trace/analyze.ts";
import type { Message, Provider } from "../src/types.ts";
import { makeDeps, reply, ScriptedProvider, tempWorkspace, testRuntime } from "./helpers.ts";

test("normal runtime bash receives a sanitized environment and traces do not contain the environment", async () => {
  const names = ["OPENAI_API_KEY", "RCA_SECRET", "RCA_PRIVATE_NOTE"];
  const saved = names.map((name) => process.env[name]);
  process.env.OPENAI_API_KEY = "fake-provider-sentinel";
  process.env.RCA_SECRET = "fake-secret-sentinel";
  process.env.RCA_PRIVATE_NOTE = "private-nonsecret-sentinel";
  try {
    const runtime = createRuntime("auto", { sessionsDir: tempWorkspace(), dataDir: tempWorkspace(), webSearch: false });
    const meta = runtime.store.create(tempWorkspace(), runtime.model, "auto");
    const deps = runtime.makeDeps(meta, { approvalMode: () => "auto", confirm: async () => true });
    const result = await executeToolCall({ id: "env", name: "bash", input: { command: "node -e 'process.stdout.write(String(process.env.OPENAI_API_KEY === undefined && process.env.RCA_SECRET === undefined))'" } }, deps);
    assert.equal(result.isError, false);
    assert.match(result.content, /true/);
    const trace = runtime.store.readFile(meta.id, "trace.jsonl");
    assert.doesNotMatch(trace, /fake-provider-sentinel|fake-secret-sentinel|private-nonsecret-sentinel/);
  } finally {
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
  }
});

test("child model calls are traced, charged to the parent, and cannot start another request after the shared cap", async () => {
  const usage = { inputTokens: 1000, outputTokens: 0, cachedInputTokens: 0 };
  const provider = new ScriptedProvider([
    reply("", [{ id: "child", name: "multi_agent", input: { tasks: [{ role: "scout", prompt: "inspect" }] } }], undefined, usage),
    reply("child result", [], undefined, { ...usage, inputTokens: 10_000 }),
  ]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(tempWorkspace(), "m", "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  runner.setLimits({ limits: { maxTurnCostUsd: 0.002 } });
  runner.setMultiAgent(true);
  await runner.send("investigate").done;
  assert.equal(provider.requests.length, 2);
  assert.equal(runtime.store.loadEvents(meta.id).at(-1)?.type, "turn_end");
  const end = runtime.store.loadEvents(meta.id).at(-1)!;
  assert.ok(end.type === "turn_end" && end.finishReason === "max_cost");
  const counted = totals(parseTrace(runtime.store.readFile(meta.id, "trace.jsonl")));
  assert.equal(counted.llmCalls, 2);
  assert.equal(counted.inputTokens, 11_000);
  assert.equal(counted.turns, 1);
  assert.ok(Math.abs(counted.costUsd - 0.0033) < 1e-12);
  assert.ok(parseTrace(runtime.store.readFile(meta.id, "trace.jsonl")).some((span) => span.attrs.subagent === true));
});

test("manual compaction usage is included in the same trace and spending budget", async () => {
  const provider = new ScriptedProvider([reply("short summary", [], undefined, { inputTokens: 10_000, outputTokens: 0, cachedInputTokens: 0 })]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(tempWorkspace(), "m", "auto");
  runtime.store.saveMessages(meta.id, [{ role: "user", content: "old context ".repeat(3000) }]);
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  await runner.compact();
  const counted = totals(parseTrace(runtime.store.readFile(meta.id, "trace.jsonl")));
  assert.equal(counted.llmCalls, 1);
  assert.equal(counted.costUsd, 0.003);
  assert.match(JSON.stringify(runtime.store.loadMessages(meta.id)), /short summary/);
});

test("switching models during a request keeps trace pricing and turn budget on the requested model", async () => {
  let model = "old";
  const provider: Provider = {
    name: "switching", get model() { return model; },
    async complete() { model = "expensive"; return reply("answer", [], undefined, { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 0 }); },
  };
  const tracer = createMemoryTracer();
  const charged: string[] = [];
  const result = await runTurn([], "question", makeDeps(provider, {
    tracer, maxTurnCostUsd: 0.001, onUsage: (_usage, usedModel) => charged.push(usedModel),
    pricing: { inputPerMTok: 0.3, cachedInputPerMTok: 0, outputPerMTok: 0, models: { expensive: { inputPerMTok: 100, cachedInputPerMTok: 0, outputPerMTok: 0 } } },
  }));
  assert.equal(result.finishReason, "end_turn");
  assert.deepEqual(charged, ["old"]);
  assert.equal(tracer.spans.find((span) => span.kind === "llm")?.name, "old");
});

test("the complete request estimate counts system, schemas, reasoning and images", () => {
  const plain: Message[] = [{ role: "user", content: "hello" }];
  const rich: Message[] = [
    { role: "user", content: "hello", images: [{ path: "/image.png", mediaType: "image/png" }] },
    { role: "assistant", text: "", toolCalls: [], reasoningContent: "reason".repeat(1000) },
  ];
  assert.ok(estimateTokens(rich) > estimateTokens(plain) + 8192);
  assert.ok(requestTokens({ system: "rules".repeat(1000), tools: [{ name: "x", description: "tool", inputSchema: { type: "object" } }], messages: rich }) > estimateTokens(rich) + 1000);
});

test("a single long turn compacts before its next call and every request fits the full input budget", async () => {
  let mainCalls = 0;
  let summaries = 0;
  const requests: number[] = [];
  const provider: Provider = {
    name: "context", model: "context",
    async complete(request) {
      requests.push(requestTokens(request));
      if (!request.tools.length) { summaries++; return reply("The user wants an inspection. The large file was read twice; no files changed."); }
      mainCalls++;
      return mainCalls <= 2 ? reply("", [{ id: `read-${mainCalls}`, name: "read_file", input: { path: "big.txt" } }]) : reply("inspection complete");
    },
  };
  const runtime = testRuntime(provider);
  const workspace = tempWorkspace();
  writeFileSync(join(workspace, "big.txt"), "x".repeat(19_000));
  const meta = runtime.store.create(workspace, provider.model, "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps, contextWindow: () => 12_000 });
  await runner.send("inspect the file twice").done;
  assert.equal(mainCalls, 3);
  assert.ok(summaries > 0);
  assert.ok(requests.every((size) => size <= 9000), JSON.stringify(requests));
  assert.ok(runtime.store.loadEvents(meta.id).some((event) => event.type === "compacted"));
});

test("an oversized request with an unsuccessful compaction never reaches the main provider", async () => {
  let mainCalls = 0;
  const provider: Provider = {
    name: "context", model: "context",
    async complete(request) {
      if (request.tools.length) mainCalls++;
      return reply("still too long ".repeat(10_000));
    },
  };
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(tempWorkspace(), "m", "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps, contextWindow: () => 4000 });
  await runner.send("large input ".repeat(3000)).done;
  assert.equal(mainCalls, 0);
  assert.equal(runtime.store.loadEvents(meta.id).at(-1)?.type, "error");
});

test("a provider context rejection gets only one forced-compaction retry and keeps the latest user input", async () => {
  for (const alwaysReject of [false, true]) {
    let mainCalls = 0;
    let summaries = 0;
    const provider: Provider = {
      name: "overflow", model: "overflow",
      async complete(request) {
        if (!request.tools.length) { summaries++; return reply("Previous context summarized. Preserve the user's newest request."); }
        mainCalls++;
        if (mainCalls === 1 || alwaysReject) throw new Error("context_length_exceeded");
        assert.match(JSON.stringify(request.messages), /newest request/);
        return reply("answer");
      },
    };
    const runtime = testRuntime(provider);
    const meta = runtime.store.create(tempWorkspace(), "m", "auto");
    runtime.store.saveMessages(meta.id, [{ role: "user", content: "old context ".repeat(3000) }, { role: "assistant", text: "previous answer", toolCalls: [] }]);
    const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
    await runner.send("newest request").done;
    assert.equal(mainCalls, 2);
    assert.equal(summaries, 1);
    assert.equal(runtime.store.loadEvents(meta.id).at(-1)?.type, alwaysReject ? "error" : "turn_end");
  }
});

test("a failed recovery checkpoint prevents tool side effects", async () => {
  let executed = false;
  const provider = new ScriptedProvider([reply("", [{ id: "write", name: "effect", input: {} }])]);
  await assert.rejects(runTurn([], "go", makeDeps(provider, {
    tools: [{ spec: { name: "effect", description: "effect", inputSchema: {} }, dangerous: true, async run() { executed = true; return "done"; } }],
    onStep() { throw new Error("disk full"); },
  })), (error: unknown) => error instanceof TurnAbortedError && /disk full/.test(error.message));
  assert.equal(executed, false);
});

test("SIGKILL during a tool preserves earlier results and marks uncertain and unstarted calls without replay", { timeout: 15_000 }, async () => {
  const workspace = tempWorkspace();
  const root = tempWorkspace();
  const store = new SessionStore(root);
  const meta = store.create(workspace, "scripted", "auto");
  const source = `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { SessionRunner } from './src/session/runner.ts';
    import { reply, ScriptedProvider, testRuntime } from './test/helpers.ts';
    import { SessionStore } from './src/session/store.ts';
    const store = new SessionStore(${JSON.stringify(root)});
    const provider = new ScriptedProvider([reply('', [
      {id:'first',name:'write_file',input:{path:'first.txt',content:'saved'}},
      {id:'uncertain',name:'hang',input:{}},
      {id:'unstarted',name:'write_file',input:{path:'third.txt',content:'must not run'}}
    ])]);
    const runtime = testRuntime(provider);
    const runner = new SessionRunner({store, meta:store.getMeta(${JSON.stringify(meta.id)}), verifyChanges:false,
      makeDeps:(meta,hooks)=>{const deps=runtime.makeDeps(meta,hooks);return {...deps,tools:[...deps.tools,{
        spec:{name:'hang',description:'hang',inputSchema:{}},dangerous:true,
        async run(){writeFileSync(join(meta.workspace,'effect.txt'),'once');process.stdout.write('READY\\n');await new Promise(()=>{});return '';}
      }]};}});
    await runner.send('go').done;
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: join(import.meta.dirname, ".."), env: sanitizeToolEnv(process.env), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child did not reach tool: ${stderr}`)), 10_000);
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`child exited early: ${stderr}`)); });
      child.stdout.on("data", (chunk) => { if (String(chunk).includes("READY")) { clearTimeout(timer); resolve(); } });
    });
    child.kill("SIGKILL");
    await once(child, "exit");
    const results = store.loadMessages(meta.id).at(-1)!;
    assert.ok(results.role === "tool_results");
    assert.equal(results.results[0]!.isError, false);
    assert.match(results.results[1]!.content, /outcome uncertain/);
    assert.match(results.results[2]!.content, /before this tool started/);
    const provider = new ScriptedProvider([reply("Inspect the uncertain operation before continuing.")]);
    const runtime = testRuntime(provider);
    const resumed = new SessionRunner({ store, meta: store.getMeta(meta.id), makeDeps: runtime.makeDeps, verifyChanges: false });
    await resumed.send("continue").done;
    assert.match(JSON.stringify(provider.requests[0]!.messages), /outcome uncertain/);
    assert.equal(readFileSync(join(workspace, "effect.txt"), "utf8"), "once");
    assert.equal(existsSync(join(workspace, "third.txt")), false);
    resumed.close();
  } finally { child.kill("SIGKILL"); }
});

test("completion requires fixed real checks, rejects stale checks, and survives session reload", async () => {
  const workspace = tempWorkspace();
  writeFileSync(join(workspace, ".agent-checks.json"), JSON.stringify({ commands: ["node check.cjs"] }));
  writeFileSync(join(workspace, "check.cjs"), "require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt','utf8'),'1');");
  const provider = new ScriptedProvider([
    reply("", [{ id: "write", name: "write_file", input: { path: "value.txt", content: "1" } }]),
    reply("", [{ id: "verify", name: "verify_changes", input: {} }]),
    reply("verified complete"),
    reply("", [{ id: "edit", name: "write_file", input: { path: "value.txt", content: "2" } }]),
    reply("incorrectly claimed complete"),
  ]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(workspace, "m", "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  await runner.send("change and test").done;
  const first = runtime.store.loadEvents(meta.id).at(-1)!;
  assert.ok(first.type === "turn_end" && first.finishReason === "end_turn");
  await runner.send("change again").done;
  const second = runtime.store.loadEvents(meta.id).at(-1)!;
  assert.ok(second.type === "turn_end" && second.finishReason === "unverified");
  assert.match(JSON.stringify(runtime.store.loadMessages(meta.id).at(-1)), /\[unverified\]/);
  runner.close();
  const next = testRuntime(new ScriptedProvider([reply("complete without rechecking")]));
  const resumed = new SessionRunner({ store: runtime.store, meta: runtime.store.getMeta(meta.id), makeDeps: next.makeDeps });
  await resumed.send("continue").done;
  const last = runtime.store.loadEvents(meta.id).at(-1)!;
  assert.ok(last.type === "turn_end" && last.finishReason === "unverified");
});

test("same-workspace forks preserve pending plans and unverified changes", async () => {
  const runtime = testRuntime(new ScriptedProvider([reply("This is a read-only explanation.")]));
  const meta = runtime.store.create(tempWorkspace(), "m", "auto");
  runtime.store.updateMeta(meta.id, { plan: [{ text: "test", status: "pending" }], verification: { changed: true } });
  const fork = runtime.store.fork(meta.id);
  assert.equal(fork.verification?.changed, true);
  assert.equal(fork.plan?.[0]?.status, "pending");
  const runner = new SessionRunner({ store: runtime.store, meta: fork, makeDeps: runtime.makeDeps });
  await runner.send("explain the code").done;
  const end = runtime.store.loadEvents(fork.id).at(-1)!;
  assert.ok(end.type === "turn_end" && end.finishReason === "unverified");
  assert.match(JSON.stringify(runtime.store.loadMessages(fork.id)), /read-only explanation/);
});

test("changing npm verification scripts cannot turn a failing check into a pass, including after reload", async () => {
  const workspace = tempWorkspace();
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }));
  let state: import("../src/agent/verification.ts").VerificationState = { changed: false };
  const verification = await Verification.create(workspace, undefined, state, (value) => { state = value; });
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  await assert.rejects(verification.tool().run({}, { workspace }), /scripts changed/);
  const reloaded = await Verification.create(workspace, undefined, state);
  await assert.rejects(reloaded.tool().run({}, { workspace }), /scripts changed/);
});

test("verification approval shows the fixed commands and model arguments cannot replace them", async () => {
  const workspace = tempWorkspace();
  writeFileSync(join(workspace, ".agent-checks.json"), JSON.stringify({ commands: ["node reviewed-check.cjs"] }));
  const verification = await Verification.create(workspace);
  let shown: Record<string, unknown> | undefined;
  const deps = makeDeps(new ScriptedProvider([]), {
    workspace, tools: [verification.tool()], approvalMode: () => "ask",
    confirm: async (call) => { shown = call.input; return false; },
  });
  const result = await executeToolCall({ id: "check", name: "verify_changes", input: { commands: ["true"] } }, deps);
  assert.equal(result.isError, true);
  assert.deepEqual(shown, { commands: ["node reviewed-check.cjs"] });
});

test("stopping during tool preflight and passing an aborted shell signal execute no side effects", async () => {
  const controller = new AbortController();
  let ran = false;
  const deps = makeDeps(new ScriptedProvider([]), {
    tools: [{ spec: { name: "effect", description: "effect", inputSchema: {} }, dangerous: true, async run() { ran = true; return "done"; } }],
    beforeTool: async () => { controller.abort(); },
  });
  const result = await executeToolCall({ id: "stopped", name: "effect", input: {} }, deps, null, controller.signal);
  assert.equal(result.isError, true);
  assert.equal(ran, false);
  const workspace = tempWorkspace();
  const shell = await runShell("node -e 'require(\"node:fs\").writeFileSync(\"unexpected\",\"x\")'", { cwd: workspace, timeoutMs: 1000, signal: controller.signal });
  assert.equal(shell.stopped, true);
  assert.equal(existsSync(join(workspace, "unexpected")), false);
});

test("bash modifications and incomplete plans cannot produce a successful completion", async () => {
  const provider = new ScriptedProvider([
    reply("", [{ id: "bash-write", name: "bash", input: { command: "node -e 'require(\"node:fs\").writeFileSync(\"changed.txt\",\"x\")'" } }]),
    reply("done"),
  ]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(tempWorkspace(), "m", "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  await runner.send("change a file").done;
  const end = runtime.store.loadEvents(meta.id).at(-1)!;
  assert.ok(end.type === "turn_end" && end.finishReason === "unverified");

  const planned = await runTurn([], "finish", makeDeps(new ScriptedProvider([reply("done")]), {
    plan: { get: () => [{ text: "test", status: "pending" }], replace: () => "" },
  }));
  assert.equal(planned.finishReason, "unverified");
});

test("bash checks that leave workspace unchanged do not block completion", async () => {
  const workspace = tempWorkspace();
  const verification = await Verification.create(workspace);
  const call = { id: "check", name: "bash" as const, input: { command: "node -e 'process.exit(0)'" } };
  const result = await executeToolCall(call, makeDeps(new ScriptedProvider([]), {
    workspace,
    beforeTool: (toolCall) => verification.beforeTool(toolCall),
    afterTool: (toolCall) => verification.afterTool(toolCall),
  }));
  assert.equal(result.isError, false);
  assert.equal(await verification.check(), null);
});

test("read-only bash does not fingerprint a noisy workspace", async () => {
  const workspace = tempWorkspace();
  const verification = await Verification.create(workspace);
  const call = { id: "list", name: "bash" as const, input: { command: "ls -a . | head -20" } };
  const result = await executeToolCall(call, makeDeps(new ScriptedProvider([]), {
    workspace,
    beforeTool: (toolCall) => verification.beforeTool(toolCall),
    afterTool: (toolCall) => verification.afterTool(toolCall),
  }));
  assert.equal(result.isError, false);
  assert.equal(await verification.check(), null);
});

test("read-only research turns finish without verification", async () => {
  const provider = new ScriptedProvider([
    reply("", [{ id: "list", name: "bash", input: { command: "ls -a . | head -20" } }]),
    reply("research complete"),
  ]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(tempWorkspace(), "m", "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  await runner.send("research").done;
  const end = runtime.store.loadEvents(meta.id).at(-1)!;
  assert.ok(end.type === "turn_end" && end.finishReason === "end_turn");
  assert.doesNotMatch(JSON.stringify(runtime.store.loadMessages(meta.id)), /\[unverified\]/);
  runner.close();
});
