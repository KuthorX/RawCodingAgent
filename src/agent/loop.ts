import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { costUsd, DEFAULT_PRICING, type Pricing, type TokenUsage } from "../pricing.ts";
import type { Tool } from "../tools/index.ts";
import { ToolError } from "../tools/index.ts";
import type { CompletionRequest, CompletionResponse, Message, Provider, StopReason, ToolCall, ToolResult, UserMessage } from "../types.ts";
import { callSignature, isRepeating, limitDetail, limitNotice, type LimitHit } from "./limits.ts";
import { needsApproval, type ApprovalMode, type ApprovalOutcome, type Confirm } from "./permissions.ts";
import type { Tracer } from "./trace.ts";
import { truncateOutput } from "./truncate.ts";

export interface AgentDeps {
  provider: Provider;
  tools: readonly Tool[];
  system: string;
  workspace: string;
  maxSteps: number;
  // D1 guards besides maxSteps. Per turn; null/undefined cost = no cost limit, maxRepeats defaults to 3.
  maxTurnCostUsd?: number | null;
  // What is left of the tightest spending cap over the session, its workspace and its project when the
  // turn starts (scope names it for the user). The turn stops once its own cost goes past it.
  budget?: { remainingUsd: number; scope: string } | null;
  maxRepeats?: number;
  pricing?: Pricing;
  // Read before every tool call, so a mode switched mid-turn applies to the next call.
  approvalMode: () => ApprovalMode;
  confirm: Confirm;
  tracer: Tracer;
  onEvent?: (event: AgentEvent) => void;
  // Waits before each retry of a model call whose connection dropped; its length is the number of retries.
  retryDelaysMs?: readonly number[];
}

export type AgentEvent =
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; call: ToolCall; result: ToolResult }
  | { type: "interjection_delivered"; count: number };

export type FinishReason = Exclude<StopReason, "tool_use"> | LimitHit | "interrupted";

// Live controls for a running turn.
export interface TurnControl {
  // Aborted when the user stops the turn.
  signal?: AbortSignal;
  // Messages the user sent while the turn was running; injected before the next model call.
  takeInterjections?: () => string[];
}

const INTERRUPTED_RESULT = "not executed: the user stopped the turn";
const REPEATED_RESULT = "not executed: the same call was already made several times in a row without progress";
const DEFAULT_MAX_REPEATS = 3;

export interface TurnResult {
  messages: Message[];
  finishReason: FinishReason;
  steps: number;
}

const INPUT_PREVIEW_CHARS = 500;

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
  if (needsApproval(tool, deps.approvalMode())) {
    const t0 = performance.now();
    const allowed = await deps.confirm(call);
    approvalMs = Math.round(performance.now() - t0);
    approval = allowed ? "allowed" : "denied";
    if (!allowed) return { result: fail("the user denied this tool call"), approval, approvalMs };
  }
  try {
    const output = await tool.run(call.input, { workspace: deps.workspace, signal });
    return { result: { callId: call.id, content: truncateOutput(output), isError: false }, approval, approvalMs };
  } catch (err) {
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
): Promise<CompletionResponse> {
  // The summary request keeps the same tools as every other request: it only differs by the appended notice,
  // so the prompt cache still hits. (tool_choice "none" would make DeepSeek drop the tools and miss the cache.)
  const request = { system: deps.system, messages, tools: deps.tools.map((t) => t.spec) };
  const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await callModelOnce(request, step, deps, parentId, attempt, signal, summary);
    } catch (err) {
      if (signal?.aborted || attempt >= delays.length || !isDroppedConnection(err)) throw err;
      // Rejects if the user stops the turn while waiting; the caller then sees the abort.
      await sleep(delays[attempt], undefined, { signal });
    }
  }
}

async function callModelOnce(
  request: CompletionRequest,
  step: number,
  deps: AgentDeps,
  parentId: string,
  attempt: number,
  signal: AbortSignal | undefined,
  summary: boolean,
): Promise<CompletionResponse> {
  const attrs = { step, messages: request.messages.length, ...(summary ? { summary: true } : {}), ...(attempt > 0 ? { retry: attempt } : {}) };
  const span = deps.tracer.startSpan("llm", deps.provider.model, parentId, attrs);
  try {
    const response = await deps.provider.complete(request, signal);
    span.end({
      inputTokens: response.usage.inputTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
      outputTokens: response.usage.outputTokens,
      stopReason: response.stopReason,
      toolCalls: response.message.toolCalls.length,
    });
    deps.tracer.log("response", response);
    return response;
  } catch (err) {
    span.end(signal?.aborted ? { aborted: true } : { error: errorMessage(err) }, signal?.aborted ? "ok" : "error");
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
  const pricing = deps.pricing ?? DEFAULT_PRICING;
  let usage: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  let signatures: string[] = [];
  const stopAt = async (hit: LimitHit, steps: number): Promise<TurnResult> => {
    const detail = limitDetail(hit, { maxSteps: deps.maxSteps, maxCostUsd: maxCost, maxRepeats, budgetScope: deps.budget?.scope });
    deps.tracer.log("limit", { hit, steps, costUsd: costUsd(usage, pricing) });
    messages = await summarize(messages, detail, steps + 1, deps, turnId, signal);
    return { messages, finishReason: hit, steps };
  };

  for (let step = 1; step <= deps.maxSteps; step++) {
    if (signal?.aborted) return interrupted(step - 1);
    // D18: user messages sent mid-turn join the context at the next step boundary.
    const interjections = step > 1 ? (control.takeInterjections?.() ?? []) : [];
    if (interjections.length > 0) {
      messages = [...messages, ...interjections.map((content) => ({ role: "user" as const, content }))];
      deps.onEvent?.({ type: "interjection_delivered", count: interjections.length });
    }

    let response: CompletionResponse;
    try {
      response = await callModel(messages, step, deps, turnId, signal);
    } catch (err) {
      if (signal?.aborted) return interrupted(step - 1);
      throw new TurnAbortedError(err, messages);
    }
    messages = [...messages, response.message];
    const u = response.usage;
    usage = {
      inputTokens: usage.inputTokens + u.inputTokens,
      cachedInputTokens: usage.cachedInputTokens + u.cachedInputTokens,
      outputTokens: usage.outputTokens + u.outputTokens,
    };
    if (response.message.text) deps.onEvent?.({ type: "assistant_text", text: response.message.text });

    if (response.message.toolCalls.length === 0) {
      const finishReason = response.stopReason === "tool_use" ? "other" : response.stopReason;
      return { messages, finishReason, steps: step };
    }

    // Tool input may be cut off: don't run it, but answer every call so the history stays valid.
    if (response.stopReason === "max_tokens" || response.stopReason === "refusal") {
      const skipped = response.message.toolCalls.map((c) => ({
        callId: c.id,
        content: `not executed: response ended with ${response.stopReason}`,
        isError: true,
      }));
      return { messages: [...messages, { role: "tool_results", results: skipped }], finishReason: response.stopReason, steps: step };
    }

    // D2: tool calls run sequentially, results returned together in one message.
    // After a stop, every remaining call still gets a result so the history stays valid.
    const results: ToolResult[] = [];
    let repeated = false;
    for (const call of response.message.toolCalls) {
      if (signal?.aborted || repeated) {
        results.push({ callId: call.id, content: repeated ? REPEATED_RESULT : INTERRUPTED_RESULT, isError: true });
        continue;
      }
      signatures = [...signatures, callSignature(call)];
      if (isRepeating(signatures, maxRepeats)) {
        repeated = true;
        results.push({ callId: call.id, content: REPEATED_RESULT, isError: true });
        continue;
      }
      deps.onEvent?.({ type: "tool_call", call });
      const result = await executeToolCall(call, deps, turnId, signal);
      deps.onEvent?.({ type: "tool_result", call, result });
      results.push(result);
    }
    messages = [...messages, { role: "tool_results", results }];
    if (signal?.aborted) return interrupted(step);
    if (repeated) return stopAt("repeated", step);
    if (maxCost !== null && costUsd(usage, pricing) > maxCost) return stopAt("max_cost", step);
    if (deps.budget && costUsd(usage, pricing) > deps.budget.remainingUsd) return stopAt("budget", step);
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
    const response = await callModel(withNotice, step, deps, turnId, signal, true);
    // Tool calls are not allowed here; drop any the model still makes so no call is left unanswered.
    const text = response.message.text || `(stopped: ${detail})`;
    deps.onEvent?.({ type: "assistant_text", text });
    return [...withNotice, { role: "assistant", text, toolCalls: [] }];
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
  const attrs = { input: input.content.slice(0, INPUT_PREVIEW_CHARS), ...(input.images?.length ? { images: input.images.length } : {}) };
  const span = deps.tracer.startSpan("turn", "turn", null, attrs);
  try {
    const result = await loop(history, input, deps, span.id, control);
    span.end({ finishReason: result.finishReason, steps: result.steps });
    return result;
  } catch (err) {
    span.end({ error: errorMessage(err) }, "error");
    throw err;
  }
}
