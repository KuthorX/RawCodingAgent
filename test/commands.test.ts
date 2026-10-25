import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PROJECT_ROOT } from "../src/app.ts";
import { discoverSkills } from "../src/agent/skills.ts";
import { commandCatalog, runCommand } from "../src/session/commands.ts";
import { SessionRunner } from "../src/session/runner.ts";
import { SessionManager } from "../src/gui/manager.ts";
import { createGuiServers, listen } from "../src/gui/server.ts";
import { ManualProvider, reply, ScriptedProvider, tempWorkspace, testRuntime } from "./helpers.ts";

function fixture(provider = new ScriptedProvider([reply("done"), reply("summary"), reply("after clear")])) {
  const runtime = testRuntime(provider);
  const workspace = tempWorkspace();
  const root = join(workspace, ".agents", "skills");
  const directory = join(root, "command-test");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  writeFileSync(path, "---\nname: command-test\ndescription: Test instructions\n---\nAlways include BLUEBERRY in the answer.");
  const meta = runtime.store.create(workspace, provider.model, "ask");
  return { runtime, provider, workspace, meta, path, skills: discoverSkills(workspace, [root]) };
}

test("skill snapshots survive later turns, compaction, restart and fork; clear preserves history and settings", async () => {
  const f = fixture();
  let runner = new SessionRunner({ store: f.runtime.store, meta: f.meta, makeDeps: f.runtime.makeDeps });
  runCommand(runner, "/skill command-test", undefined, f.skills);
  runCommand(runner, "/command-test", undefined, f.skills);
  assert.equal(runner.info.skills?.length, 1);
  assert.equal(f.provider.requests.length, 0, "selecting a skill is free of model calls");
  assert.match(runCommand(runner, "/skills", undefined, f.skills)!.message!, /\[已加载\]/);
  const task = runCommand(runner, "/command-test inspect changes", undefined, f.skills)!.task!;
  assert.equal(task, "inspect changes");
  await runner.send(task).done;
  assert.match(f.provider.requests[0]!.system, /BLUEBERRY/);
  const oldMessages = f.runtime.store.loadMessages(f.meta.id);
  // A long transcript makes the deterministic summary smaller, without a paid model.
  runner.close();
  f.runtime.store.saveMessages(f.meta.id, [{ role: "user", content: "old detail ".repeat(2000) }, ...oldMessages]);
  runner = new SessionRunner({ store: f.runtime.store, meta: f.runtime.store.getMeta(f.meta.id), makeDeps: f.runtime.makeDeps });
  await runCommand(runner, "/compact")!.done;
  assert.match(runner.deps.system, /BLUEBERRY/);
  writeFileSync(f.path, "Changed on disk.");
  runner.close();
  const settings = { provider: "legacy", thinkEffort: "off" as const, limits: { maxSteps: 4 }, budgetUsd: 3, notifications: false };
  f.runtime.store.updateMeta(f.meta.id, settings);
  runner = new SessionRunner({ store: f.runtime.store, meta: f.runtime.store.getMeta(f.meta.id), makeDeps: f.runtime.makeDeps });
  assert.match(runner.deps.system, /BLUEBERRY/, "resuming uses the selected snapshot");
  assert.match(runCommand(runner, "/skills", undefined, [])!.message!, /已加载：command-test/);
  assert.match(f.runtime.store.fork(f.meta.id).skills![0]!.content, /BLUEBERRY/);
  const before = f.runtime.store.loadMessages(f.meta.id);
  const cleared = runCommand(runner, "/clear")!.session!;
  assert.notEqual(cleared.id, f.meta.id);
  for (const [key, value] of Object.entries(settings)) assert.deepEqual(cleared[key as keyof typeof cleared], value);
  assert.equal(cleared.workspace, f.workspace);
  assert.equal(cleared.model, f.meta.model);
  assert.equal(cleared.approvalMode, "ask");
  assert.equal(cleared.skills, undefined);
  assert.equal(cleared.plan, undefined);
  assert.equal(cleared.turns, 0);
  assert.deepEqual(f.runtime.store.loadMessages(cleared.id), []);
  assert.deepEqual(f.runtime.store.loadMessages(f.meta.id), before);
  assert.ok(f.runtime.store.loadEvents(f.meta.id).some((e) => e.type === "skill_loaded"));
  const fresh = new SessionRunner({ store: f.runtime.store, meta: cleared, makeDeps: f.runtime.makeDeps });
  await fresh.send("fresh task").done;
  assert.doesNotMatch(f.provider.requests.at(-1)!.system, /BLUEBERRY/);
  assert.deepEqual(f.provider.requests.at(-1)!.messages, [{ role: "user", content: "fresh task" }]);
  fresh.close();
  runner.close();
});

test("unknown commands, arguments, collisions and active turns cannot clear or change instructions", async () => {
  const f = fixture();
  const runner = new SessionRunner({ store: f.runtime.store, meta: f.meta, makeDeps: f.runtime.makeDeps });
  assert.equal(runCommand(runner, "ordinary text"), null);
  for (const text of ["/", "/missing", "/skill ../../secret", "/clear now"]) {
    assert.throws(() => runCommand(runner, text, undefined, f.skills), /未知|不接受/);
  }
  const collision = [{ ...f.skills[0]!, name: "clear" }];
  runCommand(runner, "/skill clear", undefined, collision);
  assert.equal(runner.info.skills![0]!.name, "clear");
  const before = runner.info.skills;
  assert.throws(() => runner.useSkill({ ...f.skills[0]!, content: "x".repeat(100_001) }), /预算/);
  assert.deepEqual(runner.info.skills, before);
  runner.setApprovalMode("auto");
  assert.equal(runCommand(runner, "/clear", "ask")!.session!.approvalMode, "ask", "public entry keeps its safer default");
  runner.close();

  const provider = new ManualProvider();
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(f.workspace, provider.model);
  const busy = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  const turn = busy.send("working").done;
  await provider.requested(1);
  assert.throws(() => runCommand(busy, "/clear"), /正在运行/);
  assert.throws(() => runCommand(busy, "/command-test", undefined, f.skills), /正在运行/);
  assert.equal(runtime.store.list().length, 1);
  assert.match(runCommand(busy, "/help")!.message!, /\/clear/);
  busy.stop();
  await turn;
  busy.close();
});

test("HTTP catalog and commands load skills, reject attachments and switch clear to a safe empty session", async () => {
  const f = fixture(new ScriptedProvider([reply("BLUEBERRY")]));
  const manager = new SessionManager(f.runtime);
  const server = createGuiServers(manager, "command-test-token").local;
  const port = await listen(server, 0);
  const call = (action: string, body?: unknown, token = "command-test-token") => fetch(`http://127.0.0.1:${port}/api/sessions/${f.meta.id}/${action}`, {
    method: body === undefined ? "GET" : "POST", headers: { "x-agent-token": token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    assert.equal((await call("commands", undefined, "wrong")).status, 401);
    const catalog = await (await call("commands")).json() as ReturnType<typeof commandCatalog>;
    assert.ok(catalog.commands.some((c) => c.command === "/command-test"));
    for (const text of ["/help", "/skills", "/skill command-test"]) assert.equal((await call("message", { text })).status, 200);
    assert.equal(f.provider.requests.length, 0);
    assert.equal((await call("message", { text: "/unknown-command-for-test" })).status, 400);
    assert.equal((await call("message", { text: "/clear", images: ["data:image/png;base64,YQ=="] })).status, 400);
    assert.equal((await call("message", { text: "/command-test inspect" })).status, 202);
    await manager.get(f.meta.id).whenIdle();
    assert.match(f.provider.requests[0]!.system, /BLUEBERRY/);
    const response = await call("message", { text: "/clear" });
    assert.equal(response.status, 200);
    const result = await response.json() as { session: { id: string } };
    assert.notEqual(result.session.id, f.meta.id);
    assert.deepEqual(f.runtime.store.loadMessages(result.session.id), []);
    assert.equal(f.runtime.store.loadMessages(f.meta.id).length, 2);
  } finally {
    manager.get(f.meta.id).close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("CLI handles help, skill loading, clear and continued input without model calls", () => {
  const f = fixture();
  const script = `
    import { runCli } from './src/cli.ts';
    import { ScriptedProvider, testRuntime } from './test/helpers.ts';
    const provider = new ScriptedProvider([]);
    const runtime = testRuntime(provider);
    await runCli(runtime, { workspace: ${JSON.stringify(f.workspace)}, resumeId: undefined, task: '', forceAuto: false });
    console.log(JSON.stringify({ calls: provider.requests.length, sessions: runtime.store.list().length }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: PROJECT_ROOT, encoding: "utf8", input: "/help\n/skill command-test\n/clear\n/help\n/exit\n", timeout: 15_000,
  });
  assert.match(output, /已加载技能 command-test/);
  assert.match(output, /上下文已清空/);
  assert.match(output, /"calls":0,"sessions":2/);
});
