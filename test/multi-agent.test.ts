import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { runTurn } from "../src/agent/loop.ts";
import { runCommand } from "../src/session/commands.ts";
import type { SessionEvent } from "../src/session/events.ts";
import { SessionRunner } from "../src/session/runner.ts";
import type { Tool } from "../src/tools/types.ts";
import { makeDeps, reply, ScriptedProvider, tempWorkspace, testRuntime } from "./helpers.ts";

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
