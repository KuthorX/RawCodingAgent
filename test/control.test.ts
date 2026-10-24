import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn } from "../src/agent/loop.ts";
import { bashTool } from "../src/tools/bash.ts";
import { SessionRunner } from "../src/session/runner.ts";
import type { SessionEvent } from "../src/session/events.ts";
import { makeDeps, ManualProvider, reply, testRuntime, tempWorkspace } from "./helpers.ts";

const write = (id: string, path: string) => ({ id, name: "write_file", input: { path, content: "x" } });

test("stopping during a model call ends the turn as interrupted with a valid history", async () => {
  const provider = new ManualProvider();
  const controller = new AbortController();
  const turn = runTurn([], "go", makeDeps(provider), { signal: controller.signal });
  await provider.requested(1);
  controller.abort();
  const result = await turn;
  assert.equal(result.finishReason, "interrupted");
  assert.deepEqual(result.messages.map((m) => m.role), ["user"]);
});

test("stopping between tool calls answers the remaining calls without running them", async () => {
  const provider = new ManualProvider();
  const controller = new AbortController();
  const deps = makeDeps(provider, {
    onEvent: (e) => {
      if (e.type === "tool_result") controller.abort(); // stop right after the first call finishes
    },
  });
  const turn = runTurn([], "go", deps, { signal: controller.signal });
  await provider.requested(1);
  provider.respond(reply("", [write("a", "one"), write("b", "two")]));
  const result = await turn;

  assert.equal(result.finishReason, "interrupted");
  const last = result.messages.at(-1)!;
  assert.ok(last.role === "tool_results");
  assert.equal(last.results[0]!.isError, false);
  assert.match(last.results[1]!.content, /stopped the turn/);
  assert.equal(provider.requests.length, 1);
});

test("interjections are injected before the next model call", async () => {
  const provider = new ManualProvider();
  let queue = [{ role: "user" as const, content: "actually, use two.txt" }];
  const turn = runTurn([], "go", makeDeps(provider), {
    takeInterjections: () => {
      const taken = queue;
      queue = [];
      return taken;
    },
  });
  await provider.requested(1);
  assert.deepEqual(provider.requests[0]!.messages.map((m) => m.role), ["user"]); // not on the first step
  provider.respond(reply("", [write("a", "one.txt")]));
  await provider.requested(2);
  const sent = provider.requests[1]!.messages;
  assert.deepEqual(sent.map((m) => m.role), ["user", "assistant", "tool_results", "user"]);
  assert.deepEqual(sent.at(-1), { role: "user", content: "[User interjection]\nactually, use two.txt" });
  provider.respond(reply("ok"));
  assert.equal((await turn).finishReason, "end_turn");
});

test("bash is killed when the turn is stopped", async () => {
  const controller = new AbortController();
  const started = Date.now();
  // A compound command: bash forks `sleep`, which must be killed too.
  const run = bashTool.run({ command: "sleep 20 && echo late" }, { workspace: tempWorkspace(), signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  assert.match(await run, /stopped by the user/);
  assert.ok(Date.now() - started < 5000);
});

function sessionWith(provider: ManualProvider, approvalMode: "ask" | "auto" = "ask") {
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(runtime.store.root, "m", approvalMode);
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  const events: SessionEvent[] = [];
  runner.subscribe((e) => events.push(e));
  return { runner, events, runtime, meta };
}

test("a message sent mid-turn is queued, then delivered at the next step", async () => {
  const provider = new ManualProvider();
  const { runner, events } = sessionWith(provider, "auto");
  const { done } = runner.send("start");
  await provider.requested(1);
  assert.equal(runner.send("also do X").queued, true);
  provider.respond(reply("", [write("a", "f")]));
  await provider.requested(2);
  assert.equal(provider.requests[1]!.messages.at(-1)!.role, "user");
  provider.respond(reply("done"));
  await done;
  assert.deepEqual(
    events.map((e) => e.type),
    ["user", "user", "tool_call", "tool_result", "interjection_delivered", "assistant_text", "turn_end"],
  );
});

test("a message that arrives after the last step starts the next turn automatically", async () => {
  const provider = new ManualProvider();
  const { runner, events, runtime, meta } = sessionWith(provider);
  const { done } = runner.send("start");
  await provider.requested(1);
  runner.send("follow-up");
  provider.respond(reply("first answer")); // no tool calls: the turn ends before delivery
  await provider.requested(2);
  assert.deepEqual(provider.requests[1]!.messages.at(-1), { role: "user", content: "follow-up" });
  provider.respond(reply("second answer"));
  await done;
  assert.equal(events.filter((e) => e.type === "turn_end").length, 2);
  assert.equal(runtime.store.getMeta(meta.id).turns, 2);
});

test("stop aborts the turn, denies waiting approvals, drops queued messages, and the session continues", async () => {
  const provider = new ManualProvider();
  const { runner, events, runtime, meta } = sessionWith(provider);
  const { done } = runner.send("start");
  await provider.requested(1);
  // A write command: read-only bash no longer waits for approval, so this must be something that does.
  provider.respond(reply("", [{ id: "b", name: "bash", input: { command: "rm -rf build" } }]));
  while (!events.some((e) => e.type === "approval_request")) await new Promise((r) => setTimeout(r, 5));
  runner.send("never mind");

  assert.equal(runner.stop(), true);
  await done;
  assert.equal(runner.isBusy, false);
  assert.equal(runner.stop(), false);
  const types = events.map((e) => e.type);
  assert.ok(types.includes("interjection_dropped"));
  assert.deepEqual(events.find((e) => e.type === "approval_resolved"), { type: "approval_resolved", id: (events.find((e) => e.type === "approval_request") as { id: string }).id, allow: false });
  assert.deepEqual(events.at(-1), { type: "turn_end", finishReason: "interrupted", steps: 1 });
  assert.deepEqual(runtime.store.loadMessages(meta.id).map((m) => m.role), ["user", "assistant", "tool_results"]);

  const next = runner.send("try again");
  await provider.requested(2);
  provider.respond(reply("ok"));
  await next.done;
  assert.equal(events.at(-1)?.type, "turn_end");
});
