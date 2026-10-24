import assert from "node:assert/strict";
import { test } from "node:test";
import { forWire, WIRE_TEXT_CHARS } from "../src/gui/wire.ts";
import { SessionRunner } from "../src/session/runner.ts";
import { reply, ScriptedProvider, tempWorkspace, testRuntime } from "./helpers.ts";

const long = "x".repeat(WIRE_TEXT_CHARS + 10);

test("forWire: long tool input and output are trimmed, the result drops the repeated input", () => {
  const call = { id: "c", name: "write_file", input: { path: "a.txt", content: long } };
  const sentCall = forWire({ type: "tool_call", call }) as unknown as { call: typeof call; truncated?: true };
  assert.equal(sentCall.truncated, true);
  assert.equal(sentCall.call.input.path, "a.txt");
  assert.equal(sentCall.call.input.content.length, WIRE_TEXT_CHARS);

  const result = forWire({ type: "tool_result", call, result: { callId: "c", content: long, isError: false } });
  assert.deepEqual(result, {
    type: "tool_result",
    call: { id: "c", name: "write_file", input: {} },
    result: { callId: "c", content: long.slice(0, WIRE_TEXT_CHARS), isError: false },
    truncated: true,
  });

  // Short ones only lose the repeated input; approvals keep everything.
  const short = forWire({ type: "tool_result", call, result: { callId: "c", content: "ok", isError: false } });
  assert.ok(!("truncated" in short));
  const approval = { type: "approval_request" as const, id: "r", call };
  assert.equal(forWire(approval), approval);
});

test("runner.toolCall returns the full input and output from the log", async () => {
  const provider = new ScriptedProvider([
    reply("", [{ id: "w", name: "write_file", input: { path: "a.txt", content: long } }]),
    reply("done"),
  ]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(tempWorkspace(), "m", "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  await runner.send("go").done;
  const full = runner.toolCall("w")!;
  assert.equal(full.input.content, long);
  assert.match(full.content!, /a\.txt/);
  assert.equal(runner.toolCall("nope"), null);
});
