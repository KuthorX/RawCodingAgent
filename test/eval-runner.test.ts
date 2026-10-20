import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { PROJECT_ROOT } from "../src/app.ts";
import { compare, formatTable, summarize, type RunInfo } from "../src/eval/report.ts";
import { BudgetedProvider, judge, runTask, secretEnvNames, type JudgeInput } from "../src/eval/runner.ts";
import { loadTasks } from "../src/eval/tasks.ts";
import { DEFAULT_PRICING } from "../src/pricing.ts";
import { reply, ScriptedProvider, tempWorkspace, testRuntime } from "./helpers.ts";

const budget = { maxSteps: 5, maxCostUsd: 0.01 };
const base: JudgeInput = { finishReason: "end_turn", error: null, steps: 3, costUsd: 0.001, budget, checkPassed: true };
// Fixed budget, so the tests don't depend on how the real task's budget is tuned.
const task = { ...loadTasks(join(PROJECT_ROOT, "eval", "tasks")).find((t) => t.id === "py-paginate")!, budget };
const solution = readFileSync(join(task.dir, "solution", "paginate.py"), "utf8");
const usage = (inputTokens: number) => ({ inputTokens, outputTokens: 0, cachedInputTokens: 0 });

test("judge: pass needs a clean end, both budgets, and a passing check", () => {
  assert.deepEqual(judge(base), []);
  assert.deepEqual(judge({ ...base, checkPassed: false }), ["check_failed"]);
  assert.deepEqual(judge({ ...base, finishReason: "max_steps", steps: 5 }), ["over_steps"]);
  assert.deepEqual(judge({ ...base, costUsd: 0.02, finishReason: "interrupted" }), ["over_cost"]);
  assert.deepEqual(judge({ ...base, finishReason: "max_tokens" }), ["not_finished"]);
  assert.deepEqual(judge({ ...base, finishReason: null, error: "boom", checkPassed: false }), ["error", "check_failed"]);
  // Solving it is not enough when the budget was blown.
  assert.deepEqual(judge({ ...base, costUsd: 0.5 }), ["over_cost"]);
});

test("BudgetedProvider fires once, on the call that crosses the budget", async () => {
  // 0.3 $/MTok input: 20k tokens = $0.006 per call, so the second call crosses $0.01.
  const inner = new ScriptedProvider([reply("a", [], undefined, usage(20_000)), reply("b", [], undefined, usage(20_000)), reply("c", [], undefined, usage(20_000))]);
  let fired = 0;
  const p = new BudgetedProvider(inner, DEFAULT_PRICING, 0.01, () => fired++);
  const req = { system: "", messages: [], tools: [] };
  await p.complete(req);
  assert.equal(fired, 0);
  await p.complete(req);
  await p.complete(req);
  assert.equal(fired, 1);
  assert.ok(Math.abs(p.spentUsd - 0.018) < 1e-9);
});

test("runTask: agent fixes the repo within budget -> PASS, and edits to tests are undone", async () => {
  const provider = new ScriptedProvider([
    reply("", [{ id: "1", name: "write_file", input: { path: "paginate.py", content: solution } }]),
    // Weakening the visible test must not help: check/ restores it before grading.
    reply("", [{ id: "2", name: "write_file", input: { path: "tests/test_paginate.py", content: "" } }]),
    // A test the agent adds (here a wrong one) must not affect the grade either.
    reply("", [{ id: "3", name: "write_file", input: { path: "tests/test_extra.py", content: "import unittest\nclass T(unittest.TestCase):\n    def test_x(self):\n        self.fail()\n" } }]),
    reply("done"),
  ]);
  const runtime = testRuntime(provider);
  const outcome = await runTask(runtime, task, { workspace: join(tempWorkspace(), "w"), attempt: 1 });
  assert.deepEqual(outcome.reasons, []);
  assert.equal(outcome.passed, true);
  assert.equal(outcome.steps, 4);
  assert.equal(existsSync(join(outcome.workspace, "tests", "test_extra.py")), false);
  // The workspace is its own git repo, so the agent's git commands can't reach anything outside it.
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: outcome.workspace, encoding: "utf8" }).trim();
  assert.equal(top, realpathSync(outcome.workspace));
  assert.equal(outcome.finishReason, "end_turn");
  assert.notEqual(readFileSync(join(outcome.workspace, "tests", "test_paginate.py"), "utf8"), "");
  assert.match(runtime.store.getMeta(outcome.sessionId).title, /\[eval\] py-paginate/);
});

test("runTask: cost guard stops the turn and the attempt fails as over_cost", async () => {
  const read = (id: string) => reply("", [{ id, name: "read_file", input: { path: "paginate.py" } }], undefined, usage(30_000));
  const provider = new ScriptedProvider([read("1"), read("2"), read("3"), reply("never reached")]);
  const outcome = await runTask(testRuntime(provider), task, { workspace: join(tempWorkspace(), "w"), attempt: 1 });
  // $0.009 after call 1, $0.018 after call 2 -> stopped before call 3.
  assert.equal(outcome.steps, 2);
  assert.equal(outcome.finishReason, "interrupted");
  assert.deepEqual(outcome.reasons, ["over_cost", "check_failed"]);
});

test("runTask: hitting maxSteps fails as over_steps", async () => {
  // Different commands each time, so this hits the step limit rather than the repeat guard.
  const run = (id: string) => reply("", [{ id, name: "bash", input: { command: `echo ${id}` } }]);
  const provider = new ScriptedProvider([...Array.from({ length: task.budget.maxSteps }, (_, i) => run(String(i))), reply("summary")]);
  const outcome = await runTask(testRuntime(provider), task, { workspace: join(tempWorkspace(), "w"), attempt: 1 });
  assert.equal(outcome.steps, task.budget.maxSteps);
  assert.deepEqual(outcome.reasons, ["over_steps", "check_failed"]);
});

test("report: table and comparison with a previous run", () => {
  const o = (taskId: string, passed: boolean) => ({
    taskId, attempt: 1, sessionId: "s", workspace: "w", passed, reasons: passed ? [] : ["check_failed" as const],
    finishReason: "end_turn" as const, error: null, steps: 2, toolCalls: 1, toolErrors: 0, inputTokens: 1, cachedInputTokens: 0,
    outputTokens: 1, costUsd: 0.002, durationMs: 1500, budget, check: { passed, exitCode: passed ? 0 : 1, output: "", timedOut: false },
  });
  const info = (runId: string, hashes: Record<string, string>): RunInfo => ({ runId, model: "m", pricing: DEFAULT_PRICING, startedAt: "t", hashes });
  const errored = { ...o("py-slugify", false), reasons: ["error" as const] };
  const now = summarize(info("r2", { "py-paginate": "h1", "py-slugify": "h2" }), [o("py-paginate", true), errored]);
  const before = summarize(info("r1", { "py-paginate": "h1", "py-slugify": "h2" }), [o("py-paginate", false), o("py-slugify", true)]);
  // Errors are counted separately, not as failed attempts.
  assert.deepEqual([now.passed, now.attempts, now.errors], [1, 1, 1]);
  assert.match(formatTable([task], [o("py-paginate", true)]), /py-paginate\s+easy\s+PASS\s+2\/5\s+\$0\.0020\/\$0\.0100/);
  assert.deepEqual(compare(now, before), ["vs r1 (m), 2 comparable task(s): 1/2 → 1/1", "  ↑ py-paginate: 0/1 → 1/1"]);
  // A task whose content changed is left out of the comparison.
  const edited = summarize(info("r1", { "py-paginate": "OLD", "py-slugify": "h2" }), [o("py-paginate", false)]);
  assert.deepEqual(compare(now, edited), ["vs r1 (m), 0 comparable task(s): 0/0 → 0/0", "  ! task content changed, not compared: py-paginate"]);
});

test("secretEnvNames picks credentials but leaves git and other config alone", () => {
  const env = { DEEPSEEK_API_KEY: "x", OPENAI_API_KEY: "x", ANTHROPIC_AUTH_TOKEN: "x", GH_TOKEN: "x", DB_PASSWORD: "x",
    GIT_CONFIG_KEY_0: "x", GIT_CONFIG_COUNT: "1", PANE_KEY: "x", PATH: "/bin", KEYBOARD: "us" };
  assert.deepEqual(secretEnvNames(env).sort(), ["ANTHROPIC_AUTH_TOKEN", "DB_PASSWORD", "DEEPSEEK_API_KEY", "GH_TOKEN", "OPENAI_API_KEY"]);
});
