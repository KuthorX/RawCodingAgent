import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { runTurn } from "../src/agent/loop.ts";
import { runCommand } from "../src/session/commands.ts";
import type { SessionEvent } from "../src/session/events.ts";
import { SessionRunner } from "../src/session/runner.ts";
import type { Tool } from "../src/tools/types.ts";
import { createWorkerWorkspace, workerChangeCount } from "../src/workspace/worker.ts";
import { makeDeps, ManualProvider, reply, ScriptedProvider, tempWorkspace, testRuntime } from "./helpers.ts";

// A tool that records how many of its calls were running at the same time.
function slowTool(name: string, state: { now: number; peak: number }): Tool {
  return {
    spec: { name, description: "test", inputSchema: { type: "object", properties: {} } },
    dangerous: false,
    async run() {
      state.now++;
      state.peak = Math.max(state.peak, state.now);
      await new Promise((resolve) => setTimeout(resolve, 25));
      state.now--;
      return `${name} ok`;
    },
  };
}

test("consecutive read-only calls run in one batch and keep their order", async () => {
  const state = { now: 0, peak: 0 };
  const provider = new ScriptedProvider([
    reply("", [{ id: "a", name: "glob", input: {} }, { id: "b", name: "grep", input: {} }]),
    reply("done"),
  ]);
  const deps = makeDeps(provider, { tools: [slowTool("glob", state), slowTool("grep", state)] });
  const result = await runTurn([], "read both", deps);
  assert.equal(state.peak, 2);
  assert.equal(result.finishReason, "end_turn");
  const results = result.messages.find((message) => message.role === "tool_results");
  assert.ok(results?.role === "tool_results");
  assert.deepEqual(results.results.map((r) => r.content), ["glob ok", "grep ok"]);
});

test("multi_agent fans out read-only scouts and keeps their messages out of the parent history", async () => {
  const provider = new ScriptedProvider([
    reply("", [{ id: "m1", name: "multi_agent", input: { tasks: [
      { role: "scout", prompt: "find a" }, { role: "scout", prompt: "find b" }, { role: "scout", prompt: "find c" },
    ] } }]),
    reply("found a"), reply("found b"), reply("found c"),
    reply("summarised"),
  ]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(tempWorkspace(), "m", "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  runner.setMultiAgent(true);
  await runner.send("investigate").done;

  assert.equal(provider.requests.length, 5);
  const events = runtime.store.loadEvents(meta.id);
  const starts = events.filter((event): event is Extract<SessionEvent, { type: "agent_start" }> => event.type === "agent_start");
  const ends = events.filter((event): event is Extract<SessionEvent, { type: "agent_end" }> => event.type === "agent_end");
  assert.equal(starts.length, 3);
  assert.equal(ends.length, 3);
  assert.ok(starts.every((event) => event.callId === "m1" && event.role === "scout" && event.branch === null));
  // Child events carry their agent id, so the UI can group them and replay still works.
  assert.ok(events.some((event) => event.type === "assistant_text" && event.agent === starts[0]!.agent));
  // Scouts see read-only tools only and get the scout note instead of the parent's task.
  for (const request of provider.requests.slice(1, 4)) {
    const names = request.tools.map((tool) => tool.name);
    assert.ok(names.includes("read_file"));
    for (const blocked of ["write_file", "edit_file", "bash", "multi_agent", "plan"]) assert.ok(!names.includes(blocked), `scout must not get ${blocked}`);
    assert.match(request.system, /\[Scout\]/);
  }
  // The parent history stays its own: user, its tool call, the one result message, its answer.
  assert.deepEqual(runtime.store.loadMessages(meta.id).map((message) => message.role), ["user", "assistant", "tool_results", "assistant"]);
});

test("a worker edits its own worktree and reports the branch, leaving the parent workspace untouched", async () => {
  const workspace = tempWorkspace();
  writeFileSync(join(workspace, "README.md"), "base\n");
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: workspace });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: workspace });

  const provider = new ScriptedProvider([
    reply("", [{ id: "w1", name: "multi_agent", input: { tasks: [
      { role: "worker", prompt: "create child.txt", name: "impl" },
    ] } }]),
    reply("", [{ id: "edit", name: "write_file", input: { path: "child.txt", content: "hello\n" } }]),
    reply("wrote child.txt"),
    reply("reviewed"),
  ]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(workspace, "m", "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  runner.setMultiAgent(true);
  await runner.send("add a file").done;

  assert.equal(provider.requests.length, 4);
  const events = runtime.store.loadEvents(meta.id);
  const start = events.find((event): event is Extract<SessionEvent, { type: "agent_start" }> => event.type === "agent_start");
  const end = events.find((event): event is Extract<SessionEvent, { type: "agent_end" }> => event.type === "agent_end");
  assert.ok(start && end);
  assert.equal(start.role, "worker");
  assert.match(start.branch!, /^agent\/multi-/);
  assert.notEqual(start.workspace, workspace);
  assert.equal(end.ok, true);
  assert.equal(end.files, 1);
  // The edit landed on the branch, not in the session's own checkout.
  assert.equal(existsSync(join(start.workspace, "child.txt")), true);
  assert.equal(existsSync(join(workspace, "child.txt")), false);
  assert.match(execFileSync("git", ["branch", "--list", "agent/multi-*"], { cwd: workspace, encoding: "utf8" }), /agent\/multi-/);
  // The worker's own write is traced with its agent id, and the parent's tool result names the branch.
  const childWrite = events.find((event) => event.type === "tool_call" && event.call.name === "write_file");
  assert.ok(childWrite && "agent" in childWrite && childWrite.agent);
  const result = events.find((event): event is Extract<SessionEvent, { type: "tool_result" }> => event.type === "tool_result" && event.call.name === "multi_agent");
  assert.match(result!.result.content, new RegExp(`branch agent/multi-`));

  rmSync(join(dirname(workspace), `${basename(workspace)}.worktrees`), { recursive: true, force: true });
});

test("/multiagent adds the tool and its note; off removes both", async () => {
  const provider = new ScriptedProvider([reply("one"), reply("two")]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(tempWorkspace(), "m", "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });

  await runner.send("first").done;
  assert.ok(!provider.requests[0]!.tools.some((tool) => tool.name === "multi_agent"));
  assert.doesNotMatch(provider.requests[0]!.system, /\[Multi-agent\]/);

  runCommand(runner, "/multiagent");
  assert.equal(runner.info.multiagent, true);
  assert.ok(runtime.store.loadEvents(meta.id).some((event) => event.type === "multiagent" && event.enabled));
  assert.match(runner.deps.system, /\[Multi-agent\]/);

  await runner.send("second").done;
  assert.ok(provider.requests[1]!.tools.some((tool) => tool.name === "multi_agent"));
  assert.match(provider.requests[1]!.system, /\[Multi-agent\]/);

  runCommand(runner, "/multiagent off");
  assert.equal(runner.info.multiagent, false);
  assert.doesNotMatch(runner.deps.system, /\[Multi-agent\]/);
  assert.throws(() => runCommand(runner, "/multiagent maybe"), /on 或 off/);
});

test("stopping the turn aborts the children too", async () => {
  const provider = new ManualProvider();
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(tempWorkspace(), "m", "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  runner.setMultiAgent(true);
  const done = runner.send("go").done;

  await provider.requested(1);
  provider.respond(reply("", [{ id: "m", name: "multi_agent", input: { tasks: [{ role: "scout", prompt: "look" }] } }]));
  await provider.requested(2); // the child is now waiting on its own request
  runner.stop();
  await done;

  const events = runtime.store.loadEvents(meta.id);
  const end = events.find((event): event is Extract<SessionEvent, { type: "agent_end" }> => event.type === "agent_end");
  assert.ok(end);
  assert.equal(end.ok, false);
  assert.equal(end.finishReason, "interrupted");
  const turn = events.findLast((event) => event.type === "turn_end" || event.type === "error");
  assert.ok(turn?.type === "turn_end" && turn.finishReason === "interrupted");
});

test("a read after a write sees the completed mutation", async () => {
  let value = "before";
  const order: string[] = [];
  const write: Tool = {
    spec: { name: "write_file", description: "test", inputSchema: {} },
    dangerous: true,
    async run() {
      order.push("write started");
      await new Promise((resolve) => setImmediate(resolve));
      value = "after";
      order.push("write finished");
      return value;
    },
  };
  const read: Tool = {
    spec: { name: "read_file", description: "test", inputSchema: {} },
    dangerous: false,
    async run() { order.push(`read ${value}`); return value; },
  };
  const provider = new ScriptedProvider([
    reply("", [{ id: "w", name: "write_file", input: {} }, { id: "r", name: "read_file", input: {} }]),
    reply("done"),
  ]);
  const deps = makeDeps(provider, { tools: [write, read] });
  try {
    const result = await runTurn([], "write then read", deps);
    assert.equal(result.finishReason, "end_turn");
    assert.deepEqual(order, ["write started", "write finished", "read after"]);
    const batch = result.messages.find((message) => message.role === "tool_results");
    assert.ok(batch?.role === "tool_results");
    assert.deepEqual(batch.results.map((item) => item.content), ["after", "after"]);
    assert.ok(batch.results.every((item) => !item.isError));
  } finally { rmSync(deps.workspace, { recursive: true, force: true }); }
});

test("a read waits for the preceding write approval", async () => {
  const requested = Promise.withResolvers<void>();
  const approval = Promise.withResolvers<boolean>();
  const order: string[] = [];
  const provider = new ScriptedProvider([
    reply("", [{ id: "w", name: "edit_file", input: {} }, { id: "r", name: "read_file", input: {} }]),
    reply("done"),
  ]);
  const deps = makeDeps(provider, {
    tools: ["edit_file", "read_file"].map((name) => ({
      spec: { name, description: "test", inputSchema: {} },
      dangerous: name === "edit_file",
      async run() { order.push(name); return name; },
    })),
    approvalMode: () => "ask",
    confirm: () => { requested.resolve(); return approval.promise; },
  });
  const done = runTurn([], "edit then read", deps);
  try {
    await requested.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, [], "later reads must not run while a preceding mutation awaits approval");
    approval.resolve(true);
    const result = await done;
    assert.equal(result.finishReason, "end_turn");
    assert.deepEqual(order, ["edit_file", "read_file"]);
  } finally {
    approval.resolve(false);
    await done;
    rmSync(deps.workspace, { recursive: true, force: true });
  }
});

test("a worker starts at its parent worktree commit and preserves the project subdirectory", async () => {
  const root = tempWorkspace();
  const repo = join(root, "repo");
  const feature = join(root, "feature");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", [
    "-c", "user.name=t", "-c", "user.email=t@t", ...args,
  ], { cwd, encoding: "utf8" }).trim();
  try {
    mkdirSync(join(repo, "pkg"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "pkg", "version.txt"), "main\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "main");
    const mainHead = git(repo, "rev-parse", "HEAD");
    git(repo, "worktree", "add", "-q", "-b", "feature", feature);
    writeFileSync(join(feature, "pkg", "version.txt"), "feature\n");
    git(feature, "add", ".");
    git(feature, "commit", "-qm", "feature");
    const parentHead = git(feature, "rev-parse", "HEAD");
    writeFileSync(join(feature, "pkg", "version.txt"), "uncommitted\n");

    const worker = await createWorkerWorkspace(join(feature, "pkg"), "parent-base");
    assert.notEqual(parentHead, mainHead);
    assert.equal(git(worker.root, "rev-parse", "HEAD"), parentHead);
    assert.equal(worker.base, git(feature, "rev-parse", "--short", parentHead));
    assert.equal(worker.path, join(worker.root, "pkg"));
    assert.equal(readFileSync(join(worker.path, "version.txt"), "utf8"), "feature\n");
    assert.equal(await workerChangeCount(worker), 0);
    assert.equal(git(repo, "rev-parse", "HEAD"), mainHead);
    assert.equal(readFileSync(join(feature, "pkg", "version.txt"), "utf8"), "uncommitted\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
