import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SessionRunner } from "../src/session/runner.ts";
import { isSessionId, titleFrom } from "../src/session/store.ts";
import { reply, ScriptedProvider, testRuntime } from "./helpers.ts";

test("store creates, lists and validates sessions", () => {
  const { store } = testRuntime(new ScriptedProvider([]));
  const a = store.create("/w", "m", "ask", new Date("2026-01-01T00:00:00Z"));
  const b = store.create("/w", "m", "ask", new Date("2026-01-02T00:00:00Z"));
  assert.ok(isSessionId(a.id));
  assert.deepEqual(store.list().map((m) => m.id), [b.id, a.id]);
  assert.equal(store.exists("../../etc"), false);
  assert.throws(() => store.getMeta("../x"), /not found/);
  assert.throws(() => store.tracePath("../x"), /invalid session id/);
  assert.equal(titleFrom("  first line\nsecond"), "first line");
  assert.equal(titleFrom("x".repeat(100)).length, 61);
});

test("a turn persists history, events, title and trace", async () => {
  const runtime = testRuntime(new ScriptedProvider([reply("hi there")]));
  const meta = runtime.store.create("/tmp", "m");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  await runner.send("hello agent").done;

  const { store } = runtime;
  assert.deepEqual(store.loadMessages(meta.id).map((m) => m.role), ["user", "assistant"]);
  assert.deepEqual(store.loadEvents(meta.id).map((e) => e.type), ["user", "assistant_text", "turn_end"]);
  assert.equal(store.getMeta(meta.id).title, "hello agent");
  assert.equal(store.getMeta(meta.id).turns, 1);
  assert.match(store.readFile(meta.id, "trace.jsonl"), /"kind":"turn"/);
});

test("a resumed session continues from the stored history", async () => {
  const provider = new ScriptedProvider([reply("first"), reply("second")]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create("/tmp", "m");
  await new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps }).send("one").done;

  const resumed = new SessionRunner({ store: runtime.store, meta: runtime.store.getMeta(meta.id), makeDeps: runtime.makeDeps });
  const replayed: string[] = [];
  resumed.subscribe((e) => replayed.push(e.type));
  assert.deepEqual(replayed, ["user", "assistant_text", "turn_end"]);

  await resumed.send("two").done;
  assert.deepEqual(provider.requests[1]!.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(runtime.store.loadMessages(meta.id).length, 4);
});

test("manual and automatic compaction replace old history with a summary", async () => {
  const provider = new ScriptedProvider([reply("first"), reply("summary"), reply("second")]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create("/tmp", "m");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps, compactionTokens: () => 1 });
  await runner.send("one").done;
  await runner.send("two").done;
  assert.match((runtime.store.loadMessages(meta.id)[0] as { content?: string }).content ?? "", /summary/);
  assert.ok(runtime.store.loadEvents(meta.id).some((e) => e.type === "compacted"));
});

test("manual compaction of an empty session still completes", async () => {
  const runtime = testRuntime(new ScriptedProvider([]));
  const meta = runtime.store.create("/tmp", "m");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  const seen: string[] = [];
  runner.subscribe((event) => seen.push(event.type));

  await runner.compact();

  assert.deepEqual(seen, ["compaction_start", "compacted"]);
  assert.equal(runner.isBusy, false);
  assert.equal(runtime.store.loadEvents(meta.id)[0]?.type, "compaction_start");
});

test("a turn interrupted by a crash is closed with an error on reload", () => {
  const runtime = testRuntime(new ScriptedProvider([]));
  const meta = runtime.store.create("/tmp", "m");
  runtime.store.appendEvent(meta.id, { type: "user", text: "unfinished" });
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  const seen: string[] = [];
  runner.subscribe((e) => seen.push(e.type));
  assert.deepEqual(seen, ["user", "error"]);
});

test("approvals are surfaced as events and only one turn runs at a time", async () => {
  const provider = new ScriptedProvider([reply("", [{ id: "c", name: "bash", input: { command: "echo hi" } }]), reply("ok")]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(runtime.store.root, "m");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });

  const approval = new Promise<string>((resolve) =>
    runner.subscribe((e) => {
      if (e.type === "approval_request") resolve(e.id);
    }),
  );
  const { done } = runner.send("run it");
  assert.equal(runner.approve("nope", true), false);
  assert.equal(runner.approve(await approval, true), true);
  await done;

  const result = runtime.store.loadEvents(meta.id).find((e) => e.type === "tool_result");
  assert.ok(result?.type === "tool_result" && /hi/.test(result.result.content));
  assert.equal(runner.isBusy, false);
});

test("a model failure mid-turn keeps the completed steps in history", async () => {
  const provider = new ScriptedProvider([reply("", [{ id: "c", name: "write_file", input: { path: "f", content: "x" } }])]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(runtime.store.root, "m");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  await runner.send("go").done; // second model call fails: script exhausted

  assert.deepEqual(runtime.store.loadMessages(meta.id).map((m) => m.role), ["user", "assistant", "tool_results"]);
  assert.equal(runtime.store.loadEvents(meta.id).at(-1)?.type, "error");
  assert.equal(runner.isBusy, false);
});

test("a persistence failure never leaves the session stuck busy", async () => {
  const runtime = testRuntime(new ScriptedProvider([reply("ok"), reply("ok again")]));
  const meta = runtime.store.create("/tmp", "m");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  const original = runtime.store.saveMessages.bind(runtime.store);
  runtime.store.saveMessages = () => {
    throw new Error("disk full");
  };
  await runner.send("one").done;
  assert.equal(runner.isBusy, false);
  runtime.store.saveMessages = original;
  await runner.send("two").done;
  assert.equal(runtime.store.getMeta(meta.id).turns, 1);
});

test("a corrupt events line is skipped and the interrupted marker is persisted", () => {
  const runtime = testRuntime(new ScriptedProvider([]));
  const meta = runtime.store.create("/tmp", "m");
  runtime.store.appendEvent(meta.id, { type: "user", text: "unfinished" });
  appendFileSync(runtime.store.filePath(meta.id, "events.jsonl"), '{"type":"tool_ca');
  new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  assert.deepEqual(runtime.store.loadEvents(meta.id).map((e) => e.type), ["user", "error"]);
});

test("a session held by another live process cannot be opened", () => {
  const runtime = testRuntime(new ScriptedProvider([]));
  const meta = runtime.store.create("/tmp", "m");
  writeFileSync(join(runtime.store.root, meta.id, "lock"), String(process.ppid));
  assert.throws(() => new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps }), /another process/);
  // A lock from a dead process is taken over.
  writeFileSync(join(runtime.store.root, meta.id, "lock"), "999999");
  assert.doesNotThrow(() => new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps }));
});

test("approval mode is per session, persisted, and switching to auto releases pending calls", async () => {
  const provider = new ScriptedProvider([reply("", [{ id: "c", name: "bash", input: { command: "echo hi" } }]), reply("ok")]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(runtime.store.root, "m");
  const other = runtime.store.create(runtime.store.root, "m", "auto");
  assert.equal(meta.approvalMode, "ask");
  assert.equal(runtime.store.getMeta(other.id).approvalMode, "auto");

  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  const asked = new Promise<void>((resolve) => runner.subscribe((e) => e.type === "approval_request" && resolve()));
  const { done } = runner.send("run it");
  await asked;
  runner.setApprovalMode("auto");
  await done;

  const types = runtime.store.loadEvents(meta.id).map((e) => e.type);
  assert.deepEqual(types.slice(types.indexOf("approval_request"), types.indexOf("approval_request") + 3), [
    "approval_request",
    "approval_mode",
    "approval_resolved",
  ]);
  assert.equal(runtime.store.getMeta(meta.id).approvalMode, "auto");
  assert.equal(runtime.store.getMeta(other.id).approvalMode, "auto");
  runner.setApprovalMode("ask");
  assert.equal(runtime.store.getMeta(meta.id).approvalMode, "ask");
});

test("sessions stored before approval modes existed default to ask", () => {
  const runtime = testRuntime(new ScriptedProvider([]));
  const meta = runtime.store.create("/tmp", "m", "auto");
  const path = runtime.store.filePath(meta.id, "meta.json");
  const { approvalMode: _dropped, ...legacy } = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify(legacy));
  assert.equal(runtime.store.getMeta(meta.id).approvalMode, "ask");
});

test("fork copies history up to the last finished turn and continues independently", async () => {
  const provider = new ScriptedProvider([reply("first"), reply("from the fork"), reply("from the source")]);
  const runtime = testRuntime(provider);
  const { store } = runtime;
  const source = store.create("/tmp", "m", "auto");
  await new SessionRunner({ store, meta: source, makeDeps: runtime.makeDeps }).send("one").done;
  // A turn that started (e.g. in another process) but hasn't ended is not part of the fork.
  store.appendEvent(source.id, { type: "user", text: "still running" });

  const fork = store.fork(source.id);
  assert.notEqual(fork.id, source.id);
  assert.deepEqual(fork.forkedFrom, { id: source.id, turns: 1 });
  assert.equal(fork.title, "one");
  assert.equal(fork.approvalMode, "auto");
  assert.deepEqual(store.loadEvents(fork.id).map((e) => e.type), ["user", "assistant_text", "turn_end", "forked"]);
  assert.equal(store.readFile(fork.id, "trace.jsonl"), "");

  await new SessionRunner({ store, meta: store.getMeta(fork.id), makeDeps: runtime.makeDeps }).send("two").done;
  assert.deepEqual(provider.requests[1]!.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(store.loadMessages(fork.id).length, 4);
  assert.equal(store.loadMessages(source.id).length, 2);
});
