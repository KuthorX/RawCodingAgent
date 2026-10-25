import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../src/session/commands.ts";
import { SessionRunner } from "../src/session/runner.ts";
import type { SessionEvent } from "../src/session/events.ts";
import { ManualProvider, reply, ScriptedProvider, testRuntime } from "./helpers.ts";

test("/plan exposes only read-only tools and persists until /plan off", async () => {
  const provider = new ScriptedProvider([reply("explored")]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(runtime.store.root, "m", "ask");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });

  const started = runCommand(runner, "/plan inspect the repo");
  assert.equal(started!.task, "inspect the repo");
  assert.equal(runner.info.mode, "plan");
  await runner.send(started!.task!).done;

  const request = provider.requests[0]!;
  const tools = request.tools.map((tool) => tool.name);
  assert.ok(tools.includes("plan") && tools.includes("read_file"));
  for (const tool of ["bash", "write_file", "edit_file", "verify_changes", "multi_agent"]) assert.ok(!tools.includes(tool), `plan mode must not expose ${tool}`);
  assert.match(request.system, /\[Plan mode\]/);

  runCommand(runner, "/plan off");
  assert.equal(runner.info.mode, undefined);
  assert.doesNotMatch(runner.deps.system, /\[Plan mode\]/);
});

test("the GUI can replace the plan while idle and is refused while busy", async () => {
  const provider = new ManualProvider();
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(runtime.store.root, "m", "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });

  runner.setPlan([{ text: "one", status: "pending" }, { text: "two", status: "in_progress" }]);
  assert.deepEqual(runtime.store.getMeta(meta.id).plan, [{ text: "one", status: "pending" }, { text: "two", status: "in_progress" }]);
  runner.setPlan([{ text: "two", status: "completed" }]);
  assert.deepEqual(runtime.store.getMeta(meta.id).plan, [{ text: "two", status: "completed" }]);
  assert.ok(runtime.store.loadEvents(meta.id).some((event) => event.type === "plan"));

  const done = runner.send("go").done;
  await provider.requested(1);
  assert.throws(() => runner.setPlan([]), /正在运行/);
  assert.throws(() => runner.setMode("plan"), /正在运行/);
  runner.stop();
  await done;
});

test("/loop auto-continues while the plan is unfinished and stops when it is complete", async () => {
  const provider = new ScriptedProvider([
    reply("", [{ id: "p1", name: "plan", input: { items: [{ text: "one", status: "in_progress" }] } }]),
    reply("working"),
    reply("", [{ id: "p2", name: "plan", input: { items: [{ text: "one", status: "completed" }] } }]),
    reply("done"),
  ]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(runtime.store.root, "m", "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  const events: SessionEvent[] = [];
  runner.subscribe((event) => events.push(event));

  const started = runCommand(runner, "/loop --max 4 do the work");
  assert.equal(started!.task, "do the work");
  assert.equal(runner.info.mode, "loop");
  assert.equal(runner.info.loopMax, 4);
  await runner.send(started!.task!).done;

  assert.equal(provider.requests.length, 4, "unfinished plan continued once, then the completed plan ended the loop");
  assert.match(String((provider.requests[2]!.messages.at(-1) as { content?: string }).content), /继续/);
  assert.equal(runtime.store.getMeta(meta.id).mode, undefined);
  assert.match(runner.deps.system, /^(?!.*\[Loop mode\])/);
  const notes = events.filter((event) => event.type === "mode").map((event) => (event as Extract<SessionEvent, { type: "mode" }>).note ?? "");
  assert.ok(notes.some((note) => note.includes("计划已完成")));
  assert.ok(events.filter((event) => event.type === "turn_end").some((event) => (event as Extract<SessionEvent, { type: "turn_end" }>).continues));
});

test("/loop stops at its turn cap", async () => {
  const provider = new ScriptedProvider([reply("working"), reply("working")]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(runtime.store.root, "m", "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  runner.setPlan([{ text: "never done", status: "in_progress" }]);
  runner.setMode("loop", { max: 2 });
  await runner.send("start").done;

  assert.equal(provider.requests.length, 2);
  assert.equal(runtime.store.getMeta(meta.id).mode, undefined);
  assert.ok(runtime.store.loadEvents(meta.id).some((event) => event.type === "mode" && /上限/.test(event.note ?? "")));
});

test("stopping a running loop ends the loop as well as the turn", async () => {
  const provider = new ManualProvider();
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(runtime.store.root, "m", "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  runner.setMode("loop");
  runner.setPlan([{ text: "unfinished", status: "in_progress" }]);

  const done = runner.send("start").done;
  await provider.requested(1);
  assert.equal(runner.stop(), true);
  await done;

  assert.equal(runtime.store.getMeta(meta.id).mode, undefined);
  assert.ok(runtime.store.loadEvents(meta.id).some((event) => event.type === "mode" && event.mode === null));
});

test("/loop rejects invalid caps and exits with stop", () => {
  const runtime = testRuntime(new ScriptedProvider([]));
  const meta = runtime.store.create(runtime.store.root, "m", "ask");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  assert.throws(() => runCommand(runner, "/loop --max 0 task"), /1-50/);
  assert.equal(runner.info.mode, undefined);
  assert.equal(runCommand(runner, "/loop task")!.task, "task");
  assert.equal(runner.info.mode, "loop");
  runCommand(runner, "/loop stop");
  assert.equal(runner.info.mode, undefined);
  runner.close();
});
