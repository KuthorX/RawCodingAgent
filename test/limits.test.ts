import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "../src/gui/manager.ts";
import { SettingsStore } from "../src/gui/settings.ts";
import { SendRejected, SessionRunner } from "../src/session/runner.ts";
import { reply, ScriptedProvider, tempWorkspace, testRuntime } from "./helpers.ts";

const call = (id: string) => ({ id, name: "glob", input: { pattern: `*${id}` } });
// 0.3 $/MTok input (default pricing): 10k input tokens = $0.003 per model call.
const usage = { inputTokens: 10_000, outputTokens: 0, cachedInputTokens: 0 };
const toolReply = (id: string) => reply("", [call(id)], undefined, usage);

test("global limits reach loaded and new sessions, while explicit session overrides win", async (t) => {
  const provider = new ScriptedProvider([
    toolReply("a"), reply("step limit summary"),
    toolReply("b"), toolReply("c"), reply("done"),
    toolReply("d"), toolReply("e"),
  ]);
  const runtime = testRuntime(provider);
  const manager = new SessionManager(runtime);
  t.after(() => manager.shutdown());
  const old = await manager.create(tempWorkspace(), "auto");
  const runner = manager.get(old.id);
  runtime.settings.update({ limits: { maxSteps: 1 } });
  await runner.send("go").done;
  assert.deepEqual(runtime.store.loadEvents(old.id).at(-1), { type: "turn_end", finishReason: "max_steps", steps: 1 });

  runtime.settings.update({ limits: { maxSteps: null, maxTurnCostUsd: null } });
  await runner.send("continue with the new global settings").done;
  assert.deepEqual(runtime.store.loadEvents(old.id).at(-1), { type: "turn_end", finishReason: "end_turn", steps: 3 });

  const fresh = await manager.create(tempWorkspace(), "auto");
  runtime.settings.update({ limits: { maxSteps: 1, maxTurnCostUsd: 0.005 } });
  manager.get(fresh.id).setLimits({ limits: { maxSteps: null } });
  await manager.get(fresh.id).send("go").done;
  assert.deepEqual(runtime.store.loadEvents(fresh.id).at(-1), { type: "turn_end", finishReason: "max_cost", steps: 2 });
  assert.equal(runtime.store.getMeta(old.id).limits, undefined);
  assert.deepEqual(manager.defaults, { maxSteps: 1, maxTurnCostUsd: 0.005 });
});

test("global cumulative caps count existing spending per session and survive reload", async (t) => {
  const provider = new ScriptedProvider([toolReply("a"), toolReply("b")]);
  const runtime = testRuntime(provider);
  const manager = new SessionManager(runtime);
  t.after(() => manager.shutdown());
  const old = await manager.create(tempWorkspace(), "auto");
  const fresh = await manager.create(tempWorkspace(), "auto");
  runtime.settings.update({ budgetUsd: 0.005 });
  await manager.get(old.id).send("go").done;
  assert.deepEqual(runtime.store.loadEvents(old.id).at(-1), { type: "turn_end", finishReason: "budget", steps: 2 });
  assert.equal(provider.requests.length, 2);
  assert.throws(() => manager.get(old.id).send("more"), SendRejected);
  assert.equal(manager.budgetFor(fresh)?.remainingUsd, 0.005);
  runtime.settings.update({ budgetUsd: 0.01 });
  assert.ok(Math.abs(manager.budgetFor(old)!.remainingUsd - 0.004) < 1e-10);
  manager.get(old.id).setLimits({ budgetUsd: null });
  assert.equal(manager.budgetFor(manager.get(old.id).info), null);
  manager.get(old.id).setLimits({ budgetUsd: undefined });
  assert.ok(Math.abs(manager.budgetFor(manager.get(old.id).info)!.remainingUsd - 0.004) < 1e-10);
  await manager.shutdown();
  const reloaded = new SessionManager(runtime);
  t.after(() => reloaded.shutdown());
  assert.ok(Math.abs(reloaded.budgetFor(reloaded.get(old.id).info)!.remainingUsd - 0.004) < 1e-10);
  runtime.settings.update({ budgetUsd: 0 });
  assert.throws(() => reloaded.get(fresh.id).send("no paid requests"), SendRejected);
  assert.equal(provider.requests.length, 2);
});

test("global quota preferences persist, preserve legacy defaults, and reject corrupt stored numbers", () => {
  const file = join(tempWorkspace(), "settings.json");
  writeFileSync(file, JSON.stringify({ notifications: true }));
  const settings = new SettingsStore(file);
  assert.deepEqual(settings.get().limits, {});
  assert.equal(settings.get().budgetUsd, null);
  settings.update({ limits: { maxSteps: null, maxTurnCostUsd: 0 }, budgetUsd: 3 });
  const saved = new SettingsStore(file).get();
  assert.deepEqual(saved.limits, { maxSteps: null, maxTurnCostUsd: 0 });
  assert.equal(saved.budgetUsd, 3);
  assert.equal(saved.notifications, true);
  writeFileSync(file, '{"limits":{"maxSteps":1.5,"maxTurnCostUsd":-1},"budgetUsd":"3"}');
  assert.deepEqual(settings.get().limits, {});
  assert.equal(settings.get().budgetUsd, null);
});

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
