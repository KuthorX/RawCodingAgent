import { performance } from "node:perf_hooks";
import type { Tool } from "../tools/index.ts";
import { ToolError } from "../tools/index.ts";
import type { CompletionResponse, Message, Provider, StopReason, ToolCall, ToolResult } from "../types.ts";
import { needsApproval, type ApprovalMode, type ApprovalOutcome, type Confirm } from "./permissions.ts";
import type { Tracer } from "./trace.ts";
import { truncateOutput } from "./truncate.ts";

export interface AgentDeps {
  provider: Provider;
  tools: readonly Tool[];
  system: string;
  workspace: string;
  maxSteps: number;
  // Read before every tool call, so a mode switched mid-turn applies to the next call.
  approvalMode: () => ApprovalMode;
  confirm: Confirm;
  tracer: Tracer;
  onEvent?: (event: AgentEvent) => void;
}

export type AgentEvent =
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; call: ToolCall; result: ToolResult }
  | { type: "interjection_delivered"; count: number };

export type FinishReason = Exclude<StopReason, "tool_use"> | "max_steps" | "interrupted";

// Live controls for a running turn.
export interface TurnControl {
  // Aborted when the user stops the turn.
  signal?: AbortSignal;
  // Messages the user sent while the turn was running; injected before the next model call.
  takeInterjections?: () => string[];
}

const INTERRUPTED_RESULT = "not executed: the user stopped the turn";

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
): Promise<CompletionResponse> {
  const span = deps.tracer.startSpan("llm", deps.provider.model, parentId, { step, messages: messages.length });
  try {
    const request = { system: deps.system, messages, tools: deps.tools.map((t) => t.spec) };
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
  userInput: string,
  deps: AgentDeps,
  turnId: string,
  control: TurnControl,
): Promise<TurnResult> {
  const { signal } = control;
  let messages: Message[] = [...history, { role: "user", content: userInput }];
  const interrupted = (steps: number): TurnResult => ({ messages, finishReason: "interrupted", steps });

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
    for (const call of response.message.toolCalls) {
      if (signal?.aborted) {
        results.push({ callId: call.id, content: INTERRUPTED_RESULT, isError: true });
        continue;
      }
      deps.onEvent?.({ type: "tool_call", call });
      const result = await executeToolCall(call, deps, turnId, signal);
      deps.onEvent?.({ type: "tool_result", call, result });
      results.push(result);
    }
    messages = [...messages, { role: "tool_results", results }];
    if (signal?.aborted) return interrupted(step);
  }
  return { messages, finishReason: "max_steps", steps: deps.maxSteps };
}

export async function runTurn(
  history: Message[],
  userInput: string,
  deps: AgentDeps,
  control: TurnControl = {},
): Promise<TurnResult> {
  const span = deps.tracer.startSpan("turn", "turn", null, { input: userInput.slice(0, INPUT_PREVIEW_CHARS) });
  try {
    const result = await loop(history, userInput, deps, span.id, control);
    span.end({ finishReason: result.finishReason, steps: result.steps });
    return result;
  } catch (err) {
    span.end({ error: errorMessage(err) }, "error");
    throw err;
  }
}
