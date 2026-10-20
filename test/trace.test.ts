import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn } from "../src/agent/loop.ts";
import { createMemoryTracer } from "../src/agent/trace.ts";
import { parseTrace, totals, toolStats, turns } from "../src/trace/analyze.ts";
import { makeDeps, reply, ScriptedProvider } from "./helpers.ts";

test("runTurn records turn, llm and tool spans with tokens and parentage", async () => {
  const tracer = createMemoryTracer();
  const provider = new ScriptedProvider([
    reply("", [{ id: "a", name: "read_file", input: { path: "missing" } }], undefined, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 }),
    reply("done", [], undefined, { inputTokens: 150, outputTokens: 5, cachedInputTokens: 0 }),
  ]);
  await runTurn([], "go", makeDeps(provider, { tracer }));

  const [llm1, tool, llm2, turn] = tracer.spans;
  assert.deepEqual(tracer.spans.map((s) => s.kind), ["llm", "tool", "llm", "turn"]);
  assert.equal(turn!.parentId, null);
  assert.ok([llm1, tool, llm2].every((s) => s!.parentId === turn!.id));
  assert.equal(llm1!.attrs.inputTokens, 100);
  assert.equal(llm1!.attrs.stopReason, "tool_use");
  assert.equal(tool!.status, "error");
  assert.equal(tool!.attrs.approvalMs, null);
  assert.equal(turn!.attrs.finishReason, "end_turn");
  assert.equal(turn!.attrs.input, "go");
});

test("a failing model call ends llm and turn spans with error status", async () => {
  const tracer = createMemoryTracer();
  await assert.rejects(runTurn([], "go", makeDeps(new ScriptedProvider([]), { tracer })));
  assert.deepEqual(tracer.spans.map((s) => [s.kind, s.status]), [["llm", "error"], ["turn", "error"]]);
});

test("approval wait time is recorded on the tool span", async () => {
  const tracer = createMemoryTracer();
  const provider = new ScriptedProvider([reply("", [{ id: "a", name: "bash", input: { command: "true" } }]), reply("ok")]);
  const confirm = () => new Promise<boolean>((r) => setTimeout(() => r(true), 20));
  await runTurn([], "go", makeDeps(provider, { tracer, approvalMode: () => "ask", confirm }));
  const tool = tracer.spans.find((s) => s.kind === "tool")!;
  assert.ok((tool.attrs.approvalMs as number) >= 15);
});

const span = (o: Record<string, unknown>) => JSON.stringify({ type: "span", status: "ok", durationMs: 10, attrs: {}, ...o });

test("parseTrace keeps line numbers and skips events and malformed lines", () => {
  const text = [JSON.stringify({ type: "event", event: "session" }), "{oops", span({ id: "t", kind: "turn" }), ""].join("\n");
  const spans = parseTrace(text);
  assert.equal(spans.length, 1);
  assert.equal(spans[0]!.line, 3);
});

test("totals, toolStats and turns aggregate spans", () => {
  const text = [
    span({ id: "l1", parentId: "t1", kind: "llm", name: "m", start: "2026-01-01T00:00:00.000Z", attrs: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 } }),
    span({ id: "x1", parentId: "t1", kind: "tool", name: "bash", start: "2026-01-01T00:00:01.000Z", durationMs: 530, attrs: { approvalMs: 500, approval: "allowed" } }),
    span({ id: "x2", parentId: "t1", kind: "tool", name: "bash", start: "2026-01-01T00:00:02.000Z", status: "error", durationMs: 10 }),
    span({ id: "t1", parentId: null, kind: "turn", name: "turn", start: "2026-01-01T00:00:00.000Z" }),
    // A running turn: children written, turn span not yet.
    span({ id: "l2", parentId: "t2", kind: "llm", name: "m", start: "2026-01-01T00:01:00.000Z", attrs: { inputTokens: 5, outputTokens: 1 } }),
  ].join("\n");
  const spans = parseTrace(text);

  // $1 per input token, $0.1 per cached one, $2 per output token: 11 + 0.4 + 6.
  const pricing = { inputPerMTok: 1e6, cachedInputPerMTok: 1e5, outputPerMTok: 2e6 };
  assert.deepEqual(totals(spans, pricing), {
    turns: 1, llmCalls: 2, toolCalls: 2, toolErrors: 1, inputTokens: 15, cachedInputTokens: 4, outputTokens: 3, costUsd: 17.4,
    contextTokens: 5, // the latest llm span (l2) had 5 input tokens
    llmMs: 20, toolMs: 40, approvalMs: 500,
    approvals: { auto: 0, allowed: 1, denied: 0 },
  });
  assert.deepEqual(toolStats(spans), [{ name: "bash", calls: 2, errors: 1, totalMs: 40, avgMs: 20 }]);
  const views = turns(spans);
  assert.equal(views.length, 2);
  assert.deepEqual(views[0]!.children.map((s) => s.id), ["l1", "x1", "x2"]);
  assert.equal(views[1]!.turn, null);
  assert.deepEqual(views[1]!.children.map((s) => s.id), ["l2"]);
});

test("tool spans record how each call was permitted, using the mode at call time", async () => {
  const tracer = createMemoryTracer();
  let mode: "ask" | "auto" = "ask";
  const bash = (id: string) => ({ id, name: "bash", input: { command: `echo ${id}` } });
  const provider = new ScriptedProvider([
    reply("", [{ id: "r", name: "read_file", input: { path: "nope" } }, bash("b1"), bash("b2"), bash("b3")]),
    reply("ok"),
  ]);
  let asked = 0;
  // First ask: deny. Second ask: allow, and switch the session to auto, so b3 is not asked.
  const confirm = async () => {
    asked++;
    if (asked === 2) mode = "auto";
    return asked === 2;
  };
  await runTurn([], "go", makeDeps(provider, { tracer, approvalMode: () => mode, confirm }));
  const approvals = tracer.spans.filter((s) => s.kind === "tool").map((s) => s.attrs.approval);
  assert.deepEqual(approvals, ["not_required", "denied", "allowed", "auto"]);
  assert.equal(asked, 2);
});

test("contextTokens skips aborted or failed calls, which carry no usage", () => {
  const text = [
    span({ id: "l1", parentId: "t", kind: "llm", name: "m", start: "2026-01-01T00:00:00.000Z", attrs: { inputTokens: 200000, outputTokens: 1 } }),
    span({ id: "l2", parentId: "t", kind: "llm", name: "m", start: "2026-01-01T00:00:05.000Z", status: "error", attrs: { error: "503" } }),
  ].join("\n");
  assert.equal(totals(parseTrace(text)).contextTokens, 200000);
});
