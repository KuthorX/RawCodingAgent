import { mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { Runtime } from "../app.ts";
import type { FinishReason } from "../agent/loop.ts";
import { costUsd, pricingForModel, usageFromError, type Pricing, type TokenUsage } from "../pricing.ts";
import type { SessionEvent } from "../session/events.ts";
import { SessionRunner } from "../session/runner.ts";
import { parseTrace, totals } from "../trace/analyze.ts";
import { toolMix, type ToolMix } from "../trace/bash-usage.ts";
import type { Tool } from "../tools/index.ts";
import type { CompletionRequest, CompletionResponse, Provider } from "../types.ts";
import { copyRepo, initGit, overlay, runCheck, type Budget, type CheckResult, type EvalTask } from "./tasks.ts";

// "error" means the attempt could not be evaluated (API failure, harness bug), not that the agent failed;
// such attempts are reported separately and left out of the pass rate.
export type FailReason = "error" | "over_steps" | "over_cost" | "not_finished" | "check_failed";

export interface TaskOutcome {
  taskId: string;
  attempt: number;
  sessionId: string;
  workspace: string;
  passed: boolean;
  reasons: FailReason[];
  finishReason: FinishReason | null; // null when the turn failed with an error
  error: string | null;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  // D4: file work through bash vs the dedicated tools. Missing in results saved before it was added.
  toolMix?: ToolMix;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  budget: Budget;
  check: CheckResult;
}

export interface JudgeInput {
  finishReason: FinishReason | null;
  error: string | null;
  steps: number;
  costUsd: number;
  budget: Budget;
  checkPassed: boolean;
}

// PASS = the check passes AND the agent ended the turn by itself AND it stayed within both budgets.
export function judge(r: JudgeInput): FailReason[] {
  const reasons: FailReason[] = [];
  if (r.error !== null) reasons.push("error");
  const overSteps = r.finishReason === "max_steps" || r.steps > r.budget.maxSteps;
  const overCost = r.costUsd > r.budget.maxCostUsd;
  if (overSteps) reasons.push("over_steps");
  if (overCost) reasons.push("over_cost");
  // Stopped by the cost guard counts as over_cost only; anything else that isn't a clean end is not_finished.
  if (r.error === null && !overSteps && !overCost && r.finishReason !== "end_turn") reasons.push("not_finished");
  if (!r.checkPassed) reasons.push("check_failed");
  return reasons;
}

// Wraps the real provider to keep a running cost, and calls onOverBudget once the budget is exceeded,
// so a runaway task is stopped right after the call that crossed the line instead of at maxSteps.
export class BudgetedProvider implements Provider {
  readonly name: string;
  readonly model: string;
  private cost = 0;
  private readonly inner: Provider;
  private readonly pricing: Pricing;
  private readonly maxCostUsd: number;
  private readonly onOverBudget: () => void;

  constructor(inner: Provider, pricing: Pricing, maxCostUsd: number, onOverBudget: () => void) {
    this.inner = inner;
    this.name = inner.name;
    this.model = inner.model;
    this.pricing = pricing;
    this.maxCostUsd = maxCostUsd;
    this.onOverBudget = onOverBudget;
  }

  // Same per-request pricing as the trace totals used for the verdict, so the guard
  // and the judge never disagree about whether the budget was crossed.
  get spentUsd(): number {
    return this.cost;
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse> {
    try {
      const response = await this.inner.complete(req, signal);
      this.charge(response.usage);
      return response;
    } catch (error) {
      const usage = usageFromError(error);
      if (usage) this.charge(usage);
      throw error;
    }
  }

  private charge(usage: TokenUsage): void {
    const wasUnder = this.spentUsd <= this.maxCostUsd;
    this.cost += costUsd(usage, pricingForModel(this.pricing, this.model));
    if (wasUnder && this.spentUsd > this.maxCostUsd) this.onOverBudget();
  }
}

// Whole-word match: GIT_CONFIG_KEY_0 or a *_PANE_KEY are configuration, not secrets, and git breaks without the former.
const SECRET_NAME = /(^|_)(API_?KEY|ACCESS_?KEY|AUTH_?TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(_|$)/i;

export function secretEnvNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((name) => SECRET_NAME.test(name) && !name.startsWith("GIT_CONFIG_"));
}

type FinalEvent = Extract<SessionEvent, { type: "turn_end" | "error" }>;

export interface RunTaskOptions {
  // Fresh directory the repo is copied into. Keep it outside this project and outside any git repo:
  // bash is not confined, and anything reachable from the workspace (hidden tests, .env) can leak.
  workspace: string;
  attempt: number;
}

export interface AgentTurnOptions {
  workspace: string;
  title: string;
  prompt: string;
  budget: Budget;
  // Swaps tools for this session only, e.g. a bash that runs inside a container (SWE-bench).
  tools?: (tools: readonly Tool[]) => readonly Tool[];
}

// What one unattended turn did, before grading.
export type AgentTurn = Omit<TaskOutcome, "taskId" | "attempt" | "workspace" | "passed" | "reasons" | "budget" | "check">;

// Lets the agent work unattended (auto approval) on one prompt within the budget, and reads back what it did.
export async function runAgentTurn(runtime: Runtime, options: AgentTurnOptions): Promise<AgentTurn> {
  const selection = runtime.initialSelection ?? { provider: "legacy", model: runtime.model, thinkEffort: "off" as const };
  const meta = runtime.store.create(options.workspace, selection.model, "auto");
  runtime.store.updateMeta(meta.id, { title: options.title, provider: selection.provider, thinkEffort: selection.thinkEffort });

  let runner: SessionRunner | null = null;
  runner = new SessionRunner({
    store: runtime.store,
    meta: runtime.store.getMeta(meta.id),
    verifyChanges: false,
    contextWindow: (session) => runtime.contextWindow(session.model, session.provider),
    makeDeps: (m, hooks) => {
      const deps = runtime.makeDeps(m, hooks);
      const provider = new BudgetedProvider(deps.provider, runtime.pricing, options.budget.maxCostUsd, () => {
        runner?.stop();
      });
      const tools = options.tools ? options.tools(deps.tools) : deps.tools;
      return { ...deps, provider, tools, maxSteps: options.budget.maxSteps, maxTurnCostUsd: Math.min(deps.maxTurnCostUsd ?? Infinity, options.budget.maxCostUsd) };
    },
  });

  let final: FinalEvent | null = null;
  const unsubscribe = runner.subscribe((event) => {
    if ((event.type === "turn_end" || event.type === "error") && !event.continues) final = event;
  });
  const t0 = performance.now();
  await runner.send(options.prompt).done;
  const durationMs = Math.round(performance.now() - t0);
  unsubscribe();

  const spans = parseTrace(runtime.store.readFile(meta.id, "trace.jsonl"));
  const t = totals(spans, runtime.pricing);
  const end = final as FinalEvent | null;
  return {
    sessionId: meta.id,
    finishReason: end?.type === "turn_end" ? end.finishReason : null,
    error: end === null ? "turn produced no result" : end.type === "error" ? end.message : null,
    // Steps the turn actually took; the extra summary call after a limit is not a step.
    steps: end?.type === "turn_end" ? end.steps : t.llmCalls,
    toolCalls: t.toolCalls,
    toolErrors: t.toolErrors,
    toolMix: toolMix(spans, options.workspace),
    inputTokens: t.inputTokens,
    cachedInputTokens: t.cachedInputTokens,
    outputTokens: t.outputTokens,
    costUsd: t.costUsd,
    durationMs,
  };
}

// Combines a turn with its grade into the saved outcome, judged the same way for every kind of task.
export function toOutcome(turn: AgentTurn, taskId: string, attempt: number, workspace: string, budget: Budget, check: CheckResult): TaskOutcome {
  const reasons = judge({ finishReason: turn.finishReason, error: turn.error, steps: turn.steps, costUsd: turn.costUsd, budget, checkPassed: check.passed });
  return { taskId, attempt, workspace, passed: reasons.length === 0, reasons, budget, check, ...turn };
}

// One attempt: copy the repo, let the agent work within the budget,
// then restore the hidden canonical tests and run the check.
export async function runTask(runtime: Runtime, task: EvalTask, options: RunTaskOptions): Promise<TaskOutcome> {
  mkdirSync(options.workspace, { recursive: true });
  copyRepo(task, options.workspace);
  initGit(options.workspace);
  const turn = await runAgentTurn(runtime, {
    workspace: options.workspace,
    title: `[eval] ${task.id} #${options.attempt}`,
    prompt: task.prompt,
    budget: task.budget,
  });
  overlay(task, "check", options.workspace);
  const check = await runCheck(task, options.workspace);
  return toOutcome(turn, task.id, options.attempt, options.workspace, task.budget, check);
}
