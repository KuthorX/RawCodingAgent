import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { costUsd, DEFAULT_PRICING, pricingForModel, usageFromError, type Pricing, type TokenUsage } from "../pricing.ts";
import type { Tool } from "../tools/index.ts";
import type { PlanController } from "../tools/plan.ts";
import type { SpawnAgents } from "../tools/multi-agent.ts";
import { ToolError } from "../tools/index.ts";
import type { CompletionRequest, CompletionResponse, Message, ModelDelta, Provider, StopReason, ToolCall, ToolResult, UserMessage } from "../types.ts";
import { callSignature, isRepeating, limitDetail, limitNotice, type LimitHit } from "./limits.ts";
import { isReadOnlyBashCommand, needsApproval, type ApprovalMode, type ApprovalOutcome, type Confirm } from "./permissions.ts";
import type { Tracer } from "./trace.ts";
import { truncateOutput } from "./truncate.ts";
import { ContextLimitError, requestTokens } from "./context.ts";
import { CycleGuard, cycleNotice, observationHash } from "./cycle-guard.ts";

export interface AgentDeps {
  provider: Provider;
  tools: readonly Tool[];
  system: string;
  workspace: string;
  // Environment passed to subprocess tools; credentials are removed by createRuntime.
  toolEnv?: NodeJS.ProcessEnv;
  plan?: PlanController;
  // Spawns child agents for the multi_agent tool. Children inherit this deps object with their own overrides.
  spawnAgents?: SpawnAgents;
  maxSteps: number;
  // D1 guards besides maxSteps. Per turn; null/undefined cost = no cost limit, maxRepeats defaults to 3.
  maxTurnCostUsd?: number | null;
  // What is left of the tightest spending cap over the session, its workspace and its project when the
  // turn starts (scope names it for the user). The turn stops once its own cost goes past it.
  budget?: { remainingUsd: number; scope: string } | null;
  maxRepeats?: number;
  pricing?: Pricing;
  // Shared by the main turn, compaction and read-only children.
  onUsage?: (usage: TokenUsage, model: string) => void;
  turnSpentUsd?: () => number;
  checkBudget?: () => LimitHit | null;
  inputTokenLimit?: () => number;
  prepareContext?: (messages: Message[], signal?: AbortSignal, force?: boolean) => Promise<Message[]>;
  completionCheck?: () => Promise<string | null>;
  beforeTool?: (call: ToolCall) => Promise<void>;
  afterTool?: (call: ToolCall) => Promise<void>;
  // Monotonic counter of observed workspace content changes, when the execution environment provides one.
  progressVersion?: () => number;
  subagent?: boolean;
  // Read before every tool call, so a mode switched mid-turn applies to the next call.
  approvalMode: () => ApprovalMode;
  confirm: Confirm;
  tracer: Tracer;
  onEvent?: (event: AgentEvent) => void;
  // Called before each tool and immediately after its result. Pending calls have explicit recovery results.
  onStep?: (messages: Message[]) => void;
  // Waits before each retry of a model call whose connection dropped; its length is the number of retries.
  retryDelaysMs?: readonly number[];
}

export type AgentEvent =
  | { type: "assistant_text"; text: string }
  // Incremental text while a streamed response is being generated; not persisted (assistant_text carries the
  // final message, so a reconnecting client still sees the whole answer).
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_reasoning_delta"; text: string }
  // A retry after partial text: drop what the UI has shown so far and wait for the replacement stream.
  | { type: "assistant_reset" }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; call: ToolCall; result: ToolResult }
  | { type: "interjection_delivered"; count: number }
  // A tool call was cut off by max_tokens; the model is asked to retry in smaller pieces.
  | { type: "output_truncated"; retry: number };

export type FinishReason = Exclude<StopReason, "tool_use"> | LimitHit | "interrupted" | "unverified";

// Live controls for a running turn.
export interface TurnControl {
  // Aborted when the user stops the turn.
  signal?: AbortSignal;
  // Messages the user sent while the turn was running; injected before the next model call.
  takeInterjections?: () => UserMessage[];
}

const INTERRUPTED_RESULT = "not executed: the user stopped the turn";
const REPEATED_RESULT = "not executed: the same call was already made several times in a row without progress";
const DEFAULT_MAX_REPEATS = 3;
const MAX_TRUNCATION_RETRIES = 2;
const TRUNCATED_RESULT =
  "not executed: your response hit the output token limit, so this tool call was cut off. " +
  "Keep each tool call much smaller: write a large file as a short skeleton with write_file first, then fill it in " +
  "with several smaller edit_file calls, or split it into several files.";

export interface TurnResult {
  messages: Message[];
  finishReason: FinishReason;
  steps: number;
}

const INPUT_PREVIEW_CHARS = 500;
// Consecutive independent reads run together, so one model step can fan out instead of paying latency per call.
const PARALLEL_READ_TOOLS = new Set(["read_file", "list_dir", "glob", "grep", "web_fetch", "web_search"]);
const PARALLEL_READ_MAX = 3;

export class ModelBudgetError extends Error {
  readonly hit: LimitHit;
  constructor(hit: LimitHit) {
    super(`Model request blocked: ${hit}`);
    this.hit = hit;
  }
}

// Thrown when a turn fails midway. `messages` is the history up to the last completed step,
// so tool calls that already ran (and changed files) are not forgotten on resume.
export class TurnAbortedError extends Error {
  readonly messages: Message[];
  constructor(cause: unknown, messages: Message[]) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TurnAbortedError";
    this.messages = messages;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

const DEFAULT_RETRY_DELAYS_MS = [1_000, 3_000];
const DROPPED_CONNECTION_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET"]);

// The connection dropped while the response was being read: fetch rejects with TypeError("terminated"),
// which the SDK doesn't retry since the response had already started. Safe to resend: a chat request has no side effects.
export function isDroppedConnection(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    if (e instanceof TypeError && (e.message === "terminated" || e.message === "fetch failed")) return true;
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && DROPPED_CONNECTION_CODES.has(code)) return true;
  }
  return false;
}

function isContextOverflow(err: unknown): boolean {
  return err instanceof ContextLimitError || err instanceof Error && /context_length_exceeded|maximum context|context (?:length|window)|too many (?:input )?tokens/i.test(err.message);
}

interface ToolRun {
  result: ToolResult;
  approval: ApprovalOutcome | null; // null when the call never reached the approval step
  approvalMs: number | null;
}

async function runTool(call: ToolCall, deps: AgentDeps, signal?: AbortSignal): Promise<ToolRun> {
  const fail = (content: string): ToolResult => ({ callId: call.id, content, isError: true });
  const tool = deps.tools.find((t) => t.spec.name === call.name);
  if (!tool) return { result: fail(`unknown tool "${call.name}"`), approval: null, approvalMs: null };
  if ("__invalid_arguments" in call.input) {
    const result = fail(`arguments are not valid JSON: ${String(call.input.__invalid_arguments)}`);
    return { result, approval: null, approvalMs: null };
  }

  let approval: ApprovalOutcome = tool.dangerous ? "auto" : "not_required";
  let approvalMs: number | null = null;
  if (needsApproval(tool, deps.approvalMode(), call)) {
    const t0 = performance.now();
    const allowed = await deps.confirm(tool.approvalInput ? { ...call, input: tool.approvalInput } : call);
    approvalMs = Math.round(performance.now() - t0);
    approval = allowed ? "allowed" : "denied";
    if (!allowed) return { result: fail("the user denied this tool call"), approval, approvalMs };
  }
  try {
    signal?.throwIfAborted();
    await deps.beforeTool?.(call);
    signal?.throwIfAborted();
    const output = await tool.run(call.input, { workspace: deps.workspace, callId: call.id, signal, env: deps.toolEnv, plan: deps.plan });
    await deps.afterTool?.(call);
    return { result: { callId: call.id, content: truncateOutput(output), isError: false, observationHash: observationHash(call.name, output) }, approval, approvalMs };
  } catch (err) {
    await deps.afterTool?.(call);
    // ToolError = expected failure the model should fix; anything else is reported with its type for debugging.
    return { result: fail(err instanceof ToolError ? err.message : errorMessage(err)), approval, approvalMs };
  }
}

export async function executeToolCall(
  call: ToolCall,
  deps: AgentDeps,
  parentId: string | null = null,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const span = deps.tracer.startSpan("tool", call.name, parentId, { callId: call.id, input: call.input });
  const { result, approval, approvalMs } = await runTool(call, deps, signal);
  span.end(
    {
      isError: result.isError,
      outputChars: result.content.length,
      approval,
      approvalMs,
      ...(result.isError ? { error: result.content } : {}),
    },
    result.isError ? "error" : "ok",
  );
  deps.tracer.log("tool", { call, result });
  return result;
}

async function callModel(
  messages: Message[],
  step: number,
  deps: AgentDeps,
  parentId: string,
  signal?: AbortSignal,
  summary = false,
  onText?: (delta: ModelDelta) => void,
): Promise<CompletionResponse> {
  // The summary request keeps the same tools as every other request: it only differs by the appended notice,
  // so the prompt cache still hits. (tool_choice "none" would make DeepSeek drop the tools and miss the cache.)
  const request = { system: deps.system, messages, tools: deps.tools.map((t) => t.spec) };
  const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let streamed = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await completeModel(request, deps, { step, parentId, attempt, signal, summary, onDelta: onText ? (delta) => {
        streamed = true;
        onText(delta);
      } : undefined });
    } catch (err) {
      if (signal?.aborted || attempt >= delays.length || !isDroppedConnection(err)) throw err;
      // A retry starts the answer over: clear the partial text the UI has already shown.
      if (streamed) {
        deps.onEvent?.({ type: "assistant_reset" });
        streamed = false;
      }
      // Rejects if the user stops the turn while waiting; the caller then sees the abort.
      await sleep(delays[attempt], undefined, { signal });
    }
  }
}

export async function completeModel(
  request: CompletionRequest,
  deps: AgentDeps,
  options: { step?: number; parentId?: string; attempt?: number; signal?: AbortSignal; summary?: boolean; onDelta?: (delta: ModelDelta) => void } = {},
): Promise<CompletionResponse> {
  const { step = 0, parentId = null, attempt = 0, signal, summary = false, onDelta } = options;
  signal?.throwIfAborted();
  const hit = deps.checkBudget?.();
  if (hit) throw new ModelBudgetError(hit);
  const limit = deps.inputTokenLimit?.();
  if (limit && requestTokens(request) > limit) throw new ContextLimitError(`Request exceeds the input budget (${limit} estimated tokens); shorten the input or configure the model context window.`);
  const attrs = { step, provider: deps.provider.name, messages: request.messages.length, ...(summary ? { summary: true } : {}), ...(attempt > 0 ? { retry: attempt } : {}) };
  const model = deps.provider.model;
  const span = deps.tracer.startSpan("llm", model, parentId, attrs);
  try {
    const response = await deps.provider.complete(request, signal, onDelta);
    span.end({
      ...response.usage,
      stopReason: response.stopReason,
      toolCalls: response.message.toolCalls.length,
    });
    deps.onUsage?.(response.usage, model);
    deps.tracer.log("response", response);
    return response;
  } catch (err) {
    const usage = usageFromError(err);
    span.end({ ...(usage ?? { usageUncertain: true }), ...(signal?.aborted ? { aborted: true } : { error: errorMessage(err) }) }, signal?.aborted ? "ok" : "error");
    if (usage) deps.onUsage?.(usage, model);
    throw err;
  }
}

// D1: the agent loop. Runs one user turn until the model stops calling tools.
async function loop(
  history: Message[],
  userInput: UserMessage,
  deps: AgentDeps,
  turnId: string,
  control: TurnControl,
): Promise<TurnResult> {
  const { signal } = control;
  let messages: Message[] = [...history, userInput];
  const interrupted = (steps: number): TurnResult => ({ messages, finishReason: "interrupted", steps });
  const maxRepeats = deps.maxRepeats ?? DEFAULT_MAX_REPEATS;
  const maxCost = deps.maxTurnCostUsd ?? null;
  let localCost = 0;
  const onUsage = deps.onUsage;
  deps = { ...deps, onUsage: (usage, model) => {
    localCost += costUsd(usage, pricingForModel(deps.pricing ?? DEFAULT_PRICING, model));
    onUsage?.(usage, model);
  } };
  let signatures: string[] = [];
  const cycles = new CycleGuard();
  let truncations = 0; // consecutive responses cut off by max_tokens inside a tool call
  const spent = () => deps.turnSpentUsd?.() ?? localCost;
  const budgetHit = (): LimitHit | null => deps.checkBudget?.() ??
    (maxCost !== null && spent() >= maxCost ? "max_cost" : deps.budget && spent() >= deps.budget.remainingUsd ? "budget" : null);
  const checkpoint = () => {
    try { deps.onStep?.(messages); }
    catch (err) { throw new TurnAbortedError(err, messages); }
  };
  const stopAt = async (hit: LimitHit, steps: number): Promise<TurnResult> => {
    const detail = limitDetail(hit, { maxSteps: deps.maxSteps, maxCostUsd: maxCost, maxRepeats, budgetScope: deps.budget?.scope });
    deps.tracer.log("limit", { hit, steps, costUsd: spent() });
    // An exhausted budget must not trigger another paid request just to explain the limit.
    if (hit === "max_cost" || hit === "budget") {
      const text = `[agent limit] ${detail}. Completed tool results are saved; work may be incomplete.`;
      messages = [...messages, { role: "assistant", text, toolCalls: [] }];
      deps.onEvent?.({ type: "assistant_text", text });
    } else messages = await summarize(messages, detail, steps + 1, deps, turnId, signal);
    checkpoint();
    return { messages, finishReason: hit, steps };
  };

  for (let step = 1; step <= deps.maxSteps; step++) {
    if (signal?.aborted) return interrupted(step - 1);
    const hit = budgetHit();
    if (hit) return stopAt(hit, step - 1);
    // D18: user messages sent mid-turn join the context at the next step boundary.
    const interjections = step > 1 ? (control.takeInterjections?.() ?? []) : [];
    if (interjections.length > 0) {
      signatures = [];
      cycles.reset();
      messages = [...messages, ...interjections.map((message) => ({ ...message, content: `[User interjection]\n${message.content}` }))];
      deps.onEvent?.({ type: "interjection_delivered", count: interjections.length });
    }

    const cycle = cycles.evaluate();
    const warning = cycle?.kind === "warning" ? cycleNotice(cycle.period) : null;
    const keepWarning = () => {
      const last = messages.at(-1);
      if (warning && !(last?.role === "user" && last.content === warning)) messages = [...messages, { role: "user", content: warning }];
    };
    if (cycle?.kind === "stop") return stopAt("stagnant", step - 1);
    if (cycle?.kind === "warning") {
      keepWarning();
      deps.tracer.log("loop_warning", { period: cycle.period });
      deps.onEvent?.({ type: "assistant_text", text: `[agent] 检测到 ${cycle.period} 步调用及结果重复三轮，已提醒调整排查方向。` });
      checkpoint();
    }

    let response: CompletionResponse;
    try {
      messages = await deps.prepareContext?.(messages, signal) ?? messages;
      keepWarning();
      const onDelta = (delta: ModelDelta) => {
        if (delta.text) deps.onEvent?.({ type: "assistant_delta", text: delta.text });
        if (delta.reasoning) deps.onEvent?.({ type: "assistant_reasoning_delta", text: delta.reasoning });
      };
      try { response = await callModel(messages, step, deps, turnId, signal, false, onDelta); }
      catch (err) {
        if (!deps.prepareContext || !isContextOverflow(err) || signal?.aborted) throw err;
        messages = await deps.prepareContext(messages, signal, true);
        keepWarning();
        deps.onEvent?.({ type: "assistant_reset" });
        response = await callModel(messages, step, deps, turnId, signal, false, onDelta);
      }
    } catch (err) {
      if (signal?.aborted) return interrupted(step - 1);
      if (err instanceof ModelBudgetError) return stopAt(err.hit, step - 1);
      throw new TurnAbortedError(err, messages);
    }
    messages = [...messages, response.message];
    const afterModel = budgetHit();
    if (afterModel) {
      if (response.message.toolCalls.length) messages = [...messages, { role: "tool_results", results: response.message.toolCalls.map((call) => ({ callId: call.id, content: "not executed: model budget exhausted", isError: true })) }];
      return stopAt(afterModel, step);
    }

    if (response.message.toolCalls.length === 0) {
      if (response.stopReason === "end_turn") {
        const blocked = deps.plan?.get().some((item) => item.status !== "completed")
          ? "The plan still has unfinished items. Work is not verified complete."
          : await deps.completionCheck?.();
        if (blocked) {
          const text = `[unverified] ${blocked}${response.message.text ? `\n\n${response.message.text}` : ""}`;
          messages = [...messages.slice(0, -1), { role: "assistant", text, toolCalls: [] }];
          deps.onEvent?.({ type: "assistant_text", text });
          checkpoint();
          return { messages, finishReason: "unverified", steps: step };
        }
      }
      if (response.message.text) deps.onEvent?.({ type: "assistant_text", text: response.message.text });
      const finishReason = response.stopReason === "tool_use" ? "other" : response.stopReason;
      checkpoint();
      return { messages, finishReason, steps: step };
    }
    if (response.message.text) deps.onEvent?.({ type: "assistant_text", text: response.message.text });

    // Tool input may be cut off: don't run it, but answer every call so the history stays valid.
    if (response.stopReason === "max_tokens" || response.stopReason === "refusal") {
      // Usually one call tried to write a whole large file at once: tell the model to split it and go on.
      const retry = response.stopReason === "max_tokens" && truncations < MAX_TRUNCATION_RETRIES;
      const skipped = response.message.toolCalls.map((c) => ({
        callId: c.id,
        content: retry ? TRUNCATED_RESULT : `not executed: response ended with ${response.stopReason}`,
        isError: true,
      }));
      messages = [...messages, { role: "tool_results", results: skipped }];
      checkpoint();
      if (!retry) return { messages, finishReason: response.stopReason, steps: step };
      truncations++;
      deps.tracer.log("truncated", { step, retry: truncations });
      deps.onEvent?.({ type: "output_truncated", retry: truncations });
      const hit = budgetHit();
      if (hit) return stopAt(hit, step);
      continue;
    }
    truncations = 0;

    // D2: results still go back as one message, but consecutive read-only calls run together (PARALLEL_READ_*).
    // After a stop, every remaining call still gets a result so the history stays valid.
    const batch = messages;
    const results: ToolResult[] = response.message.toolCalls.map((call) => ({ callId: call.id, content: "not executed: the process stopped before this tool started", isError: true }));
    const saveResults = () => { messages = [...batch, { role: "tool_results", results: results.map((result) => ({ ...result })) }]; checkpoint(); };
    saveResults();
    let repeated = false;
    const calls = response.message.toolCalls;
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index]!;
      if (signal?.aborted || repeated) {
        results[index] = { callId: call.id, content: repeated ? REPEATED_RESULT : INTERRUPTED_RESULT, isError: true };
        saveResults();
        continue;
      }
      const hit = budgetHit();
      if (hit) return stopAt(hit, step);
      if (isRepeating([...signatures, callSignature(call)], maxRepeats)) {
        repeated = true;
        results[index] = { callId: call.id, content: REPEATED_RESULT, isError: true };
        saveResults();
        continue;
      }
      // Only read-only neighbours join the group: no call can observe another's write, and no approval is pending.
      const group = [call];
      const groupSignatures = [...signatures, callSignature(call)];
      while (group.length < PARALLEL_READ_MAX && index + group.length < calls.length) {
        const next = calls[index + group.length]!;
        if (!PARALLEL_READ_TOOLS.has(next.name)) break;
        const signature = callSignature(next);
        if (isRepeating([...groupSignatures, signature], maxRepeats)) break;
        group.push(next);
        groupSignatures.push(signature);
      }
      signatures = groupSignatures.slice(-Math.max(2, maxRepeats));
      for (const [offset, member] of group.entries()) {
        results[index + offset] = { callId: member.id, content: "execution outcome uncertain: the process stopped during this tool; inspect the workspace before retrying, do not automatically repeat side effects", isError: true };
        deps.onEvent?.({ type: "tool_call", call: member });
      }
      saveResults();
      const beforeProgress = deps.progressVersion?.();
      const settled = group.length > 1
        ? await Promise.all(group.map((member) => executeToolCall(member, deps, turnId, signal)))
        : [await executeToolCall(call, deps, turnId, signal)];
      for (const [offset, result] of settled.entries()) {
        const member = group[offset]!;
        results[index + offset] = result;
        saveResults();
        deps.onEvent?.({ type: "tool_result", call: member, result });
        const changed = beforeProgress !== deps.progressVersion?.();
        const wroteFile = !result.isError && (member.name === "write_file" || member.name === "edit_file");
        // Without workspace observations, a command may have progressed silently. Avoid guessing it did nothing.
        const unknownMutation = member.name === "bash" && !deps.progressVersion && !isReadOnlyBashCommand(String(member.input.command ?? ""));
        if (changed || wroteFile || unknownMutation) cycles.reset();
        else cycles.observe(member, result);
      }
      index += group.length - 1;
    }
    if (signal?.aborted) return interrupted(step);
    if (repeated) return stopAt("repeated", step);
    const afterTools = budgetHit();
    if (afterTools) return stopAt(afterTools, step);
  }
  return stopAt("max_steps", deps.maxSteps);
}

// One extra model call, told not to use tools, so a stopped turn ends with a summary the user can act on.
// If it fails, the turn still ends cleanly without the notice (history stays valid either way).
async function summarize(
  messages: Message[],
  detail: string,
  step: number,
  deps: AgentDeps,
  turnId: string,
  signal?: AbortSignal,
): Promise<Message[]> {
  if (signal?.aborted) return messages;
  const withNotice: Message[] = [...messages, { role: "user", content: limitNotice(detail) }];
  try {
    const prepared = await deps.prepareContext?.(withNotice, signal) ?? withNotice;
    const response = await callModel(prepared, step, deps, turnId, signal, true);
    // Tool calls are not allowed here; drop any the model still makes so no call is left unanswered.
    const text = response.message.text || `(stopped: ${detail})`;
    deps.onEvent?.({ type: "assistant_text", text });
    return [...prepared, { role: "assistant", text, toolCalls: [] }];
  } catch {
    return messages;
  }
}

// userInput: plain text, or a user message with attached images.
export async function runTurn(
  history: Message[],
  userInput: string | UserMessage,
  deps: AgentDeps,
  control: TurnControl = {},
): Promise<TurnResult> {
  const input: UserMessage = typeof userInput === "string" ? { role: "user", content: userInput } : userInput;
  const attrs = { input: input.content.slice(0, INPUT_PREVIEW_CHARS), ...(input.images?.length ? { images: input.images.length } : {}), ...(deps.subagent ? { subagent: true } : {}) };
  const span = deps.tracer.startSpan("turn", deps.subagent ? "delegate" : "turn", null, attrs);
  try {
    const result = await loop(history, input, deps, span.id, control);
    span.end({ finishReason: result.finishReason, steps: result.steps });
    return result;
  } catch (err) {
    span.end({ error: errorMessage(err) }, "error");
    throw err;
  }
}
