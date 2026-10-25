import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "../src/gui/manager.ts";
import { SendRejected, SessionRunner } from "../src/session/runner.ts";
import { reply, ScriptedProvider, tempWorkspace, testRuntime } from "./helpers.ts";

const call = (id: string) => ({ id, name: "glob", input: { pattern: `*${id}` } });
// 0.3 $/MTok input (default pricing): 10k input tokens = $0.003 per model call.
const usage = { inputTokens: 10_000, outputTokens: 0, cachedInputTokens: 0 };
const toolReply = (id: string) => reply("", [call(id)], undefined, usage);

test("session limits override the defaults: unlimited steps, but a per-turn cost cap", async () => {
  // Default maxSteps in the test runtime is 10; 12 steps only fit when the session lifts it.
  const provider = new ScriptedProvider([...Array.from({ length: 12 }, (_, i) => reply("", [call(String(i))])), reply("done")]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(tempWorkspace(), "m", "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  runner.setLimits({ limits: { maxSteps: null } });
  await runner.send("go").done;
  assert.deepEqual(runtime.store.loadEvents(meta.id).at(-1), { type: "turn_end", finishReason: "end_turn", steps: 13 });
  assert.deepEqual(runtime.store.getMeta(meta.id).limits, { maxSteps: null });

  const costly = new ScriptedProvider([toolReply("a"), toolReply("b"), reply("summary")]);
  const rt2 = testRuntime(costly);
  const m2 = rt2.store.create(tempWorkspace(), "m", "auto");
  const r2 = new SessionRunner({ store: rt2.store, meta: m2, makeDeps: rt2.makeDeps });
  r2.setLimits({ limits: { maxSteps: null, maxTurnCostUsd: 0.005 } });
  await r2.send("go").done;
  const end = rt2.store.loadEvents(m2.id).at(-1)!;
  assert.deepEqual(end, { type: "turn_end", finishReason: "max_cost", steps: 2 });
});

test("a spending budget stops the turn, and a used-up budget refuses the next message", async () => {
  const provider = new ScriptedProvider([toolReply("a"), toolReply("b"), reply("summary")]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(tempWorkspace(), "m", "auto");
  let remaining = 0.005;
  const runner = new SessionRunner({
    store: runtime.store,
    meta,
    makeDeps: runtime.makeDeps,
    budget: () => ({ remainingUsd: remaining, scope: 'workspace "w"', label: "工作区 w " }),
  });
  await runner.send("go").done;
  assert.deepEqual(runtime.store.loadEvents(meta.id).at(-1), { type: "turn_end", finishReason: "budget", steps: 2 });
  // No extra paid request is allowed once the budget is exhausted.
  assert.equal(provider.requests.length, 2);
  assert.match(JSON.stringify(runtime.store.loadMessages(meta.id).at(-1)), /spending budget/);
  remaining = 0;
  assert.throws(() => runner.send("more"), (err: unknown) => err instanceof SendRejected && /工作区 w 的额度已经用完/.test(err.message));
});

test("budgetFor: the tightest of session, workspace and project caps", async () => {
  const runtime = testRuntime(new ScriptedProvider([]));
  const dir = tempWorkspace();
  const project = runtime.projects.add(dir);
  const manager = new SessionManager(runtime);
  const meta = runtime.store.create(project.path, "m");
  await manager.describeProjects();
  assert.equal(manager.budgetFor(meta), null);

  manager.setBudget(project.path, 5);
  assert.deepEqual(manager.budgetFor(meta), { remainingUsd: 5, scope: `project "${project.name}"`, label: `项目 ${project.name} ` });
  manager.setBudget(project.path, 2, project.path);
  assert.equal(manager.budgetFor(meta)?.remainingUsd, 2);
  assert.match(manager.budgetFor(meta)!.scope, /^workspace/);
  assert.equal(manager.budgetFor({ ...meta, budgetUsd: 1 })?.scope, "session");
  manager.setBudget(project.path, null, project.path);
  manager.setBudget(project.path, null);
  assert.equal(manager.budgetFor(meta), null);
  const views = await manager.describeProjects();
  assert.deepEqual([views[0]!.budgetUsd, views[0]!.spentUsd, views[0]!.workspaces[0]!.budgetUsd], [null, 0, null]);
});
