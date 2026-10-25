import assert from "node:assert/strict";
import test from "node:test";
import { compare, experimentTable, runProfile, summarize, type RunInfo } from "../src/eval/report.ts";
import { runAgentTurn, toOutcome } from "../src/eval/runner.ts";
import { DEFAULT_PRICING } from "../src/pricing.ts";
import type { ModelSelection } from "../src/providers/catalog.ts";
import { reply, ScriptedProvider, tempWorkspace, testRuntime } from "./helpers.ts";

test("eval uses the startup provider, model and effort and reports the matching native pricing source", async () => {
  const usage = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, costUsd: 0.002 };
  const scripted = new ScriptedProvider([reply("finished", [], undefined, usage)]);
  const runtime = testRuntime(scripted);
  const snapshot: ModelSelection = { provider: "openai", model: "selected-native-model", thinkEffort: "high" };
  runtime.initialSelection = snapshot;
  runtime.model = "old-environment-model";
  runtime.settings.update({ defaultProvider: "anthropic", defaultModel: "later-global-default", defaultThinkEffort: "low" });
  const seen: ModelSelection[] = [];
  const windows: { model: string; provider?: string }[] = [];
  let replacementCalls = 0;
  runtime.makeProvider = () => { replacementCalls++; throw new Error("Eval must retain its BudgetedProvider wrapper"); };
  const makeDeps = runtime.makeDeps;
  runtime.makeDeps = (meta, hooks) => {
    seen.push({ provider: meta.provider!, model: meta.model, thinkEffort: meta.thinkEffort! });
    return { ...makeDeps(meta, hooks), provider: { name: meta.provider!, model: meta.model, complete: scripted.complete.bind(scripted) } };
  };
  runtime.contextWindow = (model, provider) => { windows.push({ model, provider }); return 64_000; };
  const budget = { maxSteps: 5, maxCostUsd: 0.01 };
  const turn = await runAgentTurn(runtime, { workspace: tempWorkspace(), title: "native selection", prompt: "answer", budget });
  assert.deepEqual(seen, [snapshot]);
  assert.ok(windows.length > 0 && windows.every((entry) => entry.model === snapshot.model && entry.provider === snapshot.provider));
  assert.equal(replacementCalls, 0);
  const meta = runtime.store.getMeta(turn.sessionId);
  assert.deepEqual({ provider: meta.provider, model: meta.model, thinkEffort: meta.thinkEffort }, snapshot);
  assert.equal(turn.finishReason, "end_turn");
  assert.equal(turn.costUsd, usage.costUsd);
  const outcome = toOutcome(turn, "selection-test", 1, meta.workspace, budget, { passed: true, exitCode: 0, output: "", timedOut: false });
  const profile = runProfile(runtime);
  const summary = summarize({ runId: "native", ...profile, startedAt: "now", promptRules: [], hashes: { "selection-test": "fixed" } }, [outcome]);
  assert.equal(summary.provider, snapshot.provider);
  assert.equal(summary.model, snapshot.model);
  assert.equal(summary.thinkEffort, snapshot.thinkEffort);
  assert.equal(summary.pricingSource, "pi-catalog");
  assert.equal(Object.hasOwn(summary, "pricing"), false, "native reports must not present legacy PRICE_* as their rates");
  assert.equal(summary.costUsd, usage.costUsd);
});

test("evals without an initial selection remain legacy/off and retain configured price metadata", async () => {
  const runtime = testRuntime(new ScriptedProvider([reply("finished")]));
  const turn = await runAgentTurn(runtime, { workspace: tempWorkspace(), title: "legacy", prompt: "answer", budget: { maxSteps: 2, maxCostUsd: 1 } });
  const meta = runtime.store.getMeta(turn.sessionId);
  assert.deepEqual({ provider: meta.provider, model: meta.model, thinkEffort: meta.thinkEffort }, { provider: "legacy", model: runtime.model, thinkEffort: "off" });
  assert.deepEqual(runProfile(runtime), { provider: "legacy", model: runtime.model, thinkEffort: "off", pricingSource: "legacy-config", pricing: runtime.pricing });
});

test("native eval budgets still stop on per-request reported cost rather than legacy token prices", async () => {
  const usage = { inputTokens: 1, outputTokens: 0, cachedInputTokens: 0, costUsd: 0.02 };
  const scripted = new ScriptedProvider([
    reply("", [{ id: "over-budget", name: "read_file", input: { path: "unneeded.txt" } }], undefined, usage),
    reply("must not run"),
  ]);
  const runtime = testRuntime(scripted);
  runtime.initialSelection = { provider: "openai", model: "native-budget-model", thinkEffort: "high" };
  const makeDeps = runtime.makeDeps;
  runtime.makeDeps = (meta, hooks) => ({ ...makeDeps(meta, hooks), provider: { name: meta.provider!, model: meta.model, complete: scripted.complete.bind(scripted) } });
  runtime.makeProvider = () => { throw new Error("Budget wrapper must not be replaced"); };
  const turn = await runAgentTurn(runtime, { workspace: tempWorkspace(), title: "native cap", prompt: "inspect", budget: { maxSteps: 5, maxCostUsd: 0.01 } });
  assert.equal(scripted.requests.length, 1);
  assert.equal(turn.finishReason, "max_cost");
  assert.equal(turn.costUsd, 0.02);
  assert.equal(turn.toolCalls, 0);
});

test("report comparisons warn on provider, reasoning and pricing-source differences while old reports stay compatible", () => {
  const base: RunInfo = { runId: "before", model: "same-model-id", pricing: DEFAULT_PRICING, promptRules: [], startedAt: "then", hashes: {} };
  const old = summarize(base, []);
  const explicitLegacy = summarize({ ...base, runId: "legacy", provider: "legacy", thinkEffort: "off", pricingSource: "legacy-config" }, []);
  assert.ok(compare(explicitLegacy, old).every((line) => !line.includes("differs")));
  const native = summarize({ ...base, runId: "native", provider: "openai", thinkEffort: "high", pricingSource: "pi-catalog", pricing: undefined }, []);
  const compared = compare(native, old).join("\n");
  assert.match(compared, /provider differs: legacy → openai/);
  assert.match(compared, /thinking effort differs: off → high/);
  assert.match(compared, /pricing source differs: legacy-config → pi-catalog/);
  const table = experimentTable([{ summary: old, outcomes: [] }, { summary: native, outcomes: [] }], {});
  assert.match(table, /openai\s+high\s+pi-catalog/);
  assert.match(table, /providers differ between runs/);
  assert.match(table, /thinking efforts differ between runs/);
  assert.match(table, /pricing sources differ between runs/);
});
