import { randomUUID } from "node:crypto";
import type { AgentDeps } from "../agent/loop.ts";
import { completeModel, ModelBudgetError, runTurn, TurnAbortedError } from "../agent/loop.ts";
import type { ApprovalMode, Confirm } from "../agent/permissions.ts";
import type { ImageAttachment, Message, UserMessage } from "../types.ts";
import { ContextLimitError, estimateTokens, requestTokens, textTokens } from "../agent/context.ts";
import { Verification } from "../agent/verification.ts";
import { costUsd, DEFAULT_PRICING, pricingForModel } from "../pricing.ts";
import type { LimitHit } from "../agent/limits.ts";
import type { PlanController, PlanItem } from "../tools/plan.ts";
import { planText } from "../tools/plan.ts";
import type { DelegateTask } from "../tools/delegate.ts";
import type { SessionEvent } from "./events.ts";
import { titleFrom, type SessionMeta, type SessionStore } from "./store.ts";

type Listener = (event: SessionEvent, cursor?: number) => void;

export interface RunnerOptions {
  store: SessionStore;
  meta: SessionMeta;
  makeDeps: (meta: SessionMeta, hooks: Pick<AgentDeps, "confirm" | "onEvent" | "approvalMode" | "onStep" | "plan" | "delegateTask">) => AgentDeps;
  // When omitted, approvals are surfaced as approval_request events and answered via approve().
  confirm?: Confirm;
  // Tightest spending cap left over this session and the workspace/project it belongs to; null = no cap.
  // `label` is for the user, `scope` for the model's limit notice.
  budget?: (meta: SessionMeta) => Budget | null;
  compactionTokens?: (meta: SessionMeta) => number;
  contextWindow?: (meta: SessionMeta) => number;
  // Evaluators with their own independent acceptance tests do not use the interactive completion gate.
  verifyChanges?: boolean;
}

export interface Budget {
  remainingUsd: number;
  scope: string;
  label: string;
}

// A message the session can't take right now; the GUI reports it as 409.
export class SendRejected extends Error {}

const INTERRUPTED = "上次运行在这一轮结束前中断（进程退出），这一轮的改动可能不完整。";

const COMPACT_PROMPT = `You are compacting a coding-agent conversation. Write a precise handoff summary for the next agent.
Keep: the user's goal and constraints, decisions, files changed, commands and test results, unresolved errors, and the exact next step.
Include a short "State" section listing: files created or edited, commands/tests run and whether they passed, and anything still broken.
Drop greetings and repeated tool output. Return only the summary.`;

// The summary is cheap part of compaction; keeping the last few turns verbatim keeps the model oriented
// without duplicating everything the summary already says.
const RECENT_CONTEXT_TOKENS = 20_000;
const MAX_SUMMARY_CHARS = 150_000;

function messageText(message: Message): string {
  if (message.role === "user") return `USER:\n${message.content}`;
  if (message.role === "assistant") return `ASSISTANT:\n${message.text}\n${JSON.stringify(message.toolCalls)}`;
  return `TOOLS:\n${message.results.map((r) => `${r.isError ? "ERROR" : "OK"}: ${r.content}`).join("\n")}`;
}

// Deterministic, cheap to collect, and the thing a resumed model most often gets wrong.
function touchedFiles(messages: Message[]): string[] {
  const files = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls) {
      if (call.name !== "write_file" && call.name !== "edit_file") continue;
      const path = call.input.path;
      if (typeof path === "string") files.add(path);
    }
  }
  return [...files].sort();
}

// Keep a recent suffix without separating an assistant's tool calls from their results.
function recentContext(history: Message[], budget = RECENT_CONTEXT_TOKENS): Message[] {
  const userIndexes = history.flatMap((m, i) => (m.role !== "tool_results" ? [i] : []));
  for (const start of userIndexes) {
    const slice = history.slice(start);
    if (estimateTokens(slice) <= budget) return slice;
  }
  // A single enormous message is represented by the summary instead.
  return [];
}

function chunks(transcript: string, maxChars = MAX_SUMMARY_CHARS): string[] {
  if (transcript.length <= maxChars) return [transcript];
  const parts: string[] = [];
  let rest = transcript;
  while (rest.length > 0) {
    let at = rest.lastIndexOf("\n", maxChars);
    if (at < maxChars / 2) at = maxChars;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  return parts;
}

// A turn that started but never ended means the process died mid-turn.
function isInterrupted(events: SessionEvent[]): boolean {
  const lastUser = events.findLastIndex((e) => e.type === "user");
  return lastUser !== -1 && !events.slice(lastUser).some((e) => e.type === "turn_end" || e.type === "error");
}

// Interjections that arrived too late for their turn start the next one as a single message.
function mergeMessages(queue: UserMessage[]): UserMessage {
  const images = queue.flatMap((m) => m.images ?? []);
  return { role: "user", content: queue.map((m) => m.content).filter(Boolean).join("\n\n"), ...(images.length ? { images } : {}) };
}

// Owns one persisted conversation: history, replayable event log, approvals, and the running turn.
export class SessionRunner {
  readonly deps: AgentDeps;
  private meta: SessionMeta;
  private history: Message[];
  private log: SessionEvent[];
  private running: Promise<void> | null = null;
  private compacting = false;
  private controller: AbortController | null = null;
  private queue: UserMessage[] = [];
  private readonly store: SessionStore;
  private readonly listeners = new Set<Listener>();
  private readonly pending = new Map<string, (allow: boolean) => void>();
  private readonly budget: RunnerOptions["budget"];
  private readonly compactionTokens: RunnerOptions["compactionTokens"];
  private readonly releaseLock: () => void;
  private readonly plan: PlanController;
  private readonly contextWindow: RunnerOptions["contextWindow"];
  private readonly verifyChanges: boolean;
  private turnSpent = 0;
  private turnMaxCost: number | null = null;
  private turnBudget: Budget | null = null;

  constructor(options: RunnerOptions) {
    this.store = options.store;
    this.budget = options.budget;
    this.compactionTokens = options.compactionTokens;
    this.contextWindow = options.contextWindow;
    this.verifyChanges = options.verifyChanges !== false;
    this.meta = options.meta;
    this.releaseLock = this.store.acquireLock(this.meta.id);
    this.history = this.store.loadMessages(this.meta.id);
    this.log = this.store.loadEvents(this.meta.id);
    this.plan = {
      get: () => [...(this.meta.plan ?? [])],
      replace: (items: PlanItem[]) => {
        this.meta = this.store.updateMeta(this.id, { plan: items });
        this.emit({ type: "plan", items });
        return planText(items);
      },
    };
    // Persist the marker so the interrupted turn stays closed after later turns are appended.
    if (isInterrupted(this.log)) this.emit({ type: "error", message: INTERRUPTED });
    this.deps = options.makeDeps(this.meta, {
      onEvent: (event) => {
        // Streaming deltas are a live view of a message that will be stored in full by assistant_text; writing
        // every token to events.jsonl would make replay and disk usage far worse for no benefit.
        if (event.type === "assistant_delta" || event.type === "assistant_reasoning_delta" || event.type === "assistant_reset") this.emitTransient(event);
        else this.emit(event);
      },
      onStep: (messages) => this.saveStep(messages),
      confirm: options.confirm ?? ((call) => this.requestApproval(call)),
      approvalMode: () => this.meta.approvalMode,
      plan: this.plan,
      delegateTask: (prompt, signal) => this.delegate(prompt, signal),
    });
    this.deps.onUsage = (usage, model) => { this.turnSpent += costUsd(usage, pricingForModel(this.deps.pricing ?? DEFAULT_PRICING, model)); };
    this.deps.turnSpentUsd = () => this.turnSpent;
    this.deps.checkBudget = () => this.spendingLimit();
    this.deps.inputTokenLimit = () => this.inputLimit();
    this.deps.prepareContext = (messages, signal, force) => this.prepareContext(messages, signal, force);
  }

  get id(): string {
    return this.meta.id;
  }

  get info(): SessionMeta & { busy: boolean; compacting: boolean } {
    return { ...this.meta, busy: this.isBusy, compacting: this.compacting };
  }

  private async delegate(prompt: string, signal?: AbortSignal): Promise<string> {
    const tools = this.deps.tools.filter((tool) => ["read_file", "list_dir", "glob", "grep", "web_fetch", "web_search"].includes(tool.spec.name));
    const child = {
      ...this.deps,
      tools,
      maxSteps: Math.min(this.deps.maxSteps, 8),
      maxTurnCostUsd: this.deps.maxTurnCostUsd === null || this.deps.maxTurnCostUsd === undefined ? 0.05 : Math.min(this.deps.maxTurnCostUsd, 0.05),
      approvalMode: () => "auto" as const,
      confirm: async () => true,
      tracer: this.deps.tracer,
      onEvent: undefined,
      onStep: undefined,
      plan: undefined,
      delegateTask: undefined,
      turnSpentUsd: undefined,
      prepareContext: undefined,
      completionCheck: undefined,
      beforeTool: undefined,
      afterTool: undefined,
      subagent: true,
      budget: undefined,
    } satisfies AgentDeps;
    const result = await runTurn([], { role: "user", content: prompt }, child, { signal });
    const answer = [...result.messages].reverse().find((message) => message.role === "assistant") as Extract<Message, { role: "assistant" }> | undefined;
    return answer?.text || `Child agent stopped: ${result.finishReason}`;
  }

  get isBusy(): boolean {
    return this.running !== null || this.compacting;
  }

  // Full input and output of one tool call, for a card the event stream sent trimmed. content is null while it runs.
  toolCall(callId: string): { input: Record<string, unknown>; content: string | null } | null {
    let input: Record<string, unknown> | null = null;
    for (const e of this.log) {
      if (e.type === "tool_call" && e.call.id === callId) input = e.call.input;
      if (e.type === "tool_result" && e.call.id === callId) return { input: e.call.input, content: e.result.content };
    }
    return input && { input, content: null };
  }

  // Lets go of the session (e.g. before deleting it). Only for an idle session; the runner is unusable afterwards.
  close(): void {
    this.listeners.clear();
    this.releaseLock();
  }

  subscribe(listener: Listener): () => void {
    return this.subscribeFrom(listener, 0);
  }

  subscribeFrom(listener: Listener, after = 0): () => void {
    this.listeners.add(listener);
    const start = Math.max(0, Math.floor(after));
    for (let i = start; i < this.log.length; i++) listener(this.log[i]!, i);
    return () => this.listeners.delete(listener);
  }

  // Idle: starts a turn. Busy: queues the text as an interjection, delivered before the next model call
  // (or as the next turn if the current one ends first). `done` resolves when the session is idle again.
  send(text: string, images: (ImageAttachment & { name: string })[] = []): { queued: boolean; done: Promise<void> } {
    const message: UserMessage = { role: "user", content: text, ...(images.length ? { images: images.map(({ path, mediaType }) => ({ path, mediaType })) } : {}) };
    const names = images.length ? { images: images.map((i) => i.name) } : {};
    if (this.running) {
      this.queue = [...this.queue, message];
      this.emit({ type: "user", text, queued: true, ...names });
      return { queued: true, done: this.running };
    }
    const budget = this.budget?.(this.meta);
    if (budget && budget.remainingUsd <= 0) throw new SendRejected(`${budget.label}的额度已经用完，调高或取消上限后才能继续`);
    if (!this.meta.title) this.meta = this.store.updateMeta(this.id, { title: titleFrom(text) || "（图片）" });
    this.emit({ type: "user", text, ...names });
    const done = this.drain(message).finally(() => {
      // Always leave the busy state, even if persistence fails, so the session never gets stuck.
      this.running = null;
      this.controller = null;
    });
    this.running = done;
    return { queued: false, done };
  }

  compact(focus = ""): Promise<void> {
    if (this.running) throw new SendRejected("session is busy");
    this.startBudget();
    this.controller = new AbortController();
    this.compacting = true;
    this.safely(() => this.emit({ type: "compaction_start", manual: true }));
    const done = this.compactHistory(focus, true, this.controller.signal).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.safely(() => this.emit({ type: "error", message }));
      throw err;
    }).finally(() => { this.compacting = false; this.running = null; this.controller = null; });
    this.running = done;
    return this.running;
  }

  // Stops the running turn: aborts the model request and running bash, denies waiting approvals,
  // and drops interjections that were not delivered yet. Returns false when idle.
  stop(): boolean {
    if (!this.running || !this.controller || this.controller.signal.aborted) return false;
    this.controller.abort();
    this.deps.tracer.log("stop", { pendingApprovals: this.pending.size, droppedInterjections: this.queue.length });
    for (const id of [...this.pending.keys()]) this.approve(id, false);
    if (this.queue.length > 0) {
      this.emit({ type: "interjection_dropped", count: this.queue.length });
      this.queue = [];
    }
    return true;
  }

  whenIdle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  approve(id: string, allow: boolean): boolean {
    const resolve = this.pending.get(id);
    if (!resolve) return false;
    this.pending.delete(id);
    this.emit({ type: "approval_resolved", id, allow });
    resolve(allow);
    return true;
  }

  // Turn guards and spending cap of this session; effective from the next turn.
  setLimits(patch: { limits?: SessionMeta["limits"]; budgetUsd?: number | null }): void {
    this.meta = this.store.updateMeta(this.id, patch);
    this.deps.tracer.log("limits", patch);
  }

  setArchived(archived: boolean): void {
    this.meta = this.store.updateMeta(this.id, { archived });
  }

  // The session's own turn guards override the defaults baked into deps; the budget is looked up per turn,
  // since other sessions of the same workspace/project spend from it too.
  private turnDeps(): AgentDeps {
    const limits = this.meta.limits ?? {};
    return {
      ...this.deps,
      ...(limits.maxSteps !== undefined ? { maxSteps: limits.maxSteps ?? Infinity } : {}),
      ...(limits.maxTurnCostUsd !== undefined ? { maxTurnCostUsd: limits.maxTurnCostUsd } : {}),
      budget: this.turnBudget,
    };
  }

  private spendingLimit(): LimitHit | null {
    if (this.turnMaxCost !== null && this.turnSpent >= this.turnMaxCost) return "max_cost";
    const current = this.budget?.(this.meta);
    if ((this.turnBudget && this.turnSpent >= this.turnBudget.remainingUsd) || (current && current.remainingUsd <= 0)) return "budget";
    return null;
  }

  private startBudget(): void {
    this.turnSpent = 0;
    this.turnMaxCost = this.turnDeps().maxTurnCostUsd ?? null;
    this.turnBudget = this.budget?.(this.meta) ?? null;
  }

  private inputLimit(): number {
    const window = this.contextWindow?.(this.meta) ?? 64_000;
    return Math.max(1, window - Math.min(8192, Math.ceil(window / 4)));
  }

  // Session-level permission switch; persisted, and effective from the next tool call.
  // Switching to "auto" also lets through calls that are already waiting.
  setApprovalMode(mode: ApprovalMode): void {
    if (mode === this.meta.approvalMode) return;
    this.meta = this.store.updateMeta(this.id, { approvalMode: mode });
    this.deps.tracer.log("approval_mode", { mode });
    this.emit({ type: "approval_mode", mode });
    if (mode === "auto") for (const id of [...this.pending.keys()]) this.approve(id, true);
  }

  setNotifications(notifications: boolean | null): void {
    this.meta = this.store.updateMeta(this.id, { notifications: notifications ?? undefined });
  }

  setModel(model: string): void {
    if (!model.trim()) throw new Error("model must not be empty");
    if (!this.deps.provider.setModel) throw new Error("this provider cannot switch models");
    this.deps.provider.setModel(model.trim());
    this.meta = this.store.updateMeta(this.id, { model: model.trim() });
  }

  private requestApproval(call: Parameters<Confirm>[0]): Promise<boolean> {
    return new Promise((resolve) => {
      const id = randomUUID();
      this.pending.set(id, resolve);
      this.emit({ type: "approval_request", id, call });
    });
  }

  // Runs a turn, then keeps going while interjections arrived too late to join it.
  private async drain(first: UserMessage): Promise<void> {
    let input: UserMessage | null = first;
    while (input !== null) {
      this.controller = new AbortController();
      this.startBudget();
      const final = await this.run(input, this.controller.signal);
      const stopped = this.controller.signal.aborted;
      input = !stopped && this.queue.length > 0 ? mergeMessages(this.queue) : null;
      this.queue = [];
      // Clear busy before announcing the end, so a client reacting to it can send immediately.
      if (input === null) {
        this.running = null;
        this.controller = null;
      }
      this.safely(() => this.emit(input === null ? final : { ...final, continues: true }));
    }
  }

  private async summaryCall(transcript: string, focus: string, signal?: AbortSignal): Promise<string> {
    const response = await completeModel({
      system: this.deps.system,
      messages: [{ role: "user", content: `${COMPACT_PROMPT}${focus ? `\nFocus especially on: ${focus}` : ""}\n\n${transcript}` }],
      tools: [],
    }, this.deps, { signal, summary: true });
    if (response.stopReason !== "end_turn" || response.message.toolCalls.length) throw new Error("Compaction did not return a complete summary");
    return response.message.text.trim();
  }

  // Long histories are summarized in parts first: a single prompt would exceed the model's context window,
  // which is exactly the situation compaction exists for.
  private async summarize(transcript: string, focus: string, signal?: AbortSignal): Promise<string> {
    const overhead = textTokens(this.deps.system) + textTokens(COMPACT_PROMPT + focus) + 512;
    const available = this.inputLimit() - overhead;
    if (available < 128) throw new ContextLimitError("System instructions leave no room for a compaction request");
    const parts = chunks(transcript, Math.min(MAX_SUMMARY_CHARS, available));
    if (parts.length === 1) return this.summaryCall(parts[0]!, focus, signal);
    const partials: string[] = [];
    for (const [i, part] of parts.entries()) {
      const note = `This is part ${i + 1} of ${parts.length}; summarize this part only, keeping facts needed by the next agent.`;
      partials.push(await this.summaryCall(part, `${focus}\n${note}`.trim(), signal));
    }
    const combined = partials.join("\n\n");
    if (combined.length >= transcript.length) throw new ContextLimitError("Compaction failed to reduce the history; no oversized request was sent");
    return this.summarize(combined, `${focus}\nCombine these part summaries into one handoff summary; keep every file path, command result and open error.`.trim(), signal);
  }

  private async prepareContext(messages: Message[], signal?: AbortSignal, force = false, availableTools = this.deps.tools): Promise<Message[]> {
    const tools = availableTools.map((tool) => tool.spec);
    const request = { system: this.deps.system, tools, messages };
    const configured = this.compactionTokens?.(this.meta) ?? this.inputLimit();
    const threshold = configured > 0 ? Math.min(configured, this.inputLimit()) : this.inputLimit();
    if (!force && requestTokens(request) < threshold) return messages;
    this.safely(() => this.emit({ type: "compaction_start" }));
    try {
      const compacted = await this.compactMessages(messages, "", signal, force ? Math.floor(this.inputLimit() / 2) : this.inputLimit(), tools);
      this.saveStep(compacted);
      this.emit({ type: "compacted", beforeTokens: estimateTokens(messages), afterTokens: estimateTokens(compacted) });
      return compacted;
    } catch (err) {
      // Keep going with the original history only if the complete request still fits the hard input budget.
      if (!(err instanceof ModelBudgetError) && !force && requestTokens(request) <= this.inputLimit()) {
        this.deps.tracer.log("compaction_failed", { message: err instanceof Error ? err.message : String(err) });
        return messages;
      }
      throw err;
    }
  }

  private async compactMessages(messages: Message[], focus: string, signal?: AbortSignal, target = this.inputLimit(), tools = this.deps.tools.map((tool) => tool.spec)): Promise<Message[]> {
    const beforeTokens = estimateTokens(messages);
    const transcript = messages.map(messageText).join("\n\n");
    const summary = (await this.summarize(transcript, focus, signal)) || "No summary was returned.";
    const files = touchedFiles(messages);
    const state = files.length > 0 ? `\n\n[Files changed in this session]\n${files.map((f) => `- ${f}`).join("\n")}` : "";
    const prefix: Message = { role: "user", content: `[Conversation summary]\n${summary}${state}` };
    const fixed = requestTokens({ system: this.deps.system, tools, messages: [prefix] });
    const result = [prefix, ...recentContext(messages, Math.max(0, Math.min(RECENT_CONTEXT_TOKENS, Math.floor(beforeTokens / 2), target - fixed - 64)))];
    if (fixed > target || estimateTokens(result) >= beforeTokens) throw new ContextLimitError("Compaction did not produce a smaller request within the input budget");
    return result;
  }

  private async compactHistory(focus: string, manual: boolean, signal?: AbortSignal): Promise<void> {
    const beforeTokens = estimateTokens(this.history);
    if (this.history.length === 0) {
      // A manual /compact still needs a completion event so the GUI can leave its busy state.
      this.emit({ type: "compacted", beforeTokens, afterTokens: beforeTokens, ...(manual ? { manual: true } : {}) });
      return;
    }
    const compacted = await this.compactMessages(this.history, focus, signal);
    this.saveStep(compacted);
    this.emit({ type: "compacted", beforeTokens, afterTokens: estimateTokens(compacted), ...(manual ? { manual: true } : {}) });
  }

  private async run(input: UserMessage, signal: AbortSignal): Promise<Extract<SessionEvent, { type: "turn_end" | "error" }>> {
    const control = {
      signal,
      takeInterjections: () => {
        const taken = this.queue;
        this.queue = [];
        return taken;
      },
    };
    try {
      const deps = this.turnDeps();
      deps.prepareContext = (messages, signal, force) => this.prepareContext(messages, signal, force, deps.tools);
      if (this.verifyChanges) {
        const verification = await Verification.create(this.meta.workspace, deps.toolEnv, this.meta.verification, (state) => {
          this.meta = this.store.updateMeta(this.id, { verification: state });
        });
        deps.tools = [...deps.tools, verification.tool()];
        deps.beforeTool = (call) => verification.beforeTool(call);
        deps.afterTool = (call) => verification.afterTool(call);
        deps.completionCheck = () => verification.check();
      }
      const result = await runTurn(this.history, input, deps, control);
      this.commit(result.messages);
      return { type: "turn_end", finishReason: result.finishReason, steps: result.steps };
    } catch (err) {
      // Keep the completed steps of a failed turn: their tool calls already changed the workspace.
      if (err instanceof TurnAbortedError) this.safely(() => this.commit(err.messages));
      const message = err instanceof Error ? err.message : String(err);
      this.safely(() => this.deps.tracer.log("error", { message }));
      return { type: "error", message };
    }
  }

  // A checkpoint between steps: the history on disk is always a valid conversation to resume from, even if the
  // process dies before the turn ends.
  private saveStep(messages: Message[]): void {
    // Fail closed: never begin the next tool if its recovery checkpoint could not be written.
    this.store.saveMessages(this.id, messages);
    this.history = messages;
  }

  // Saved at step boundaries only, so the stored history is always a valid conversation to resume from.
  private commit(messages: Message[]): void {
    this.history = messages;
    this.store.saveMessages(this.id, messages);
    this.meta = this.store.updateMeta(this.id, { updatedAt: new Date().toISOString(), turns: this.meta.turns + 1 });
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      process.stderr.write(`session ${this.id}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  private emit(event: SessionEvent): void {
    this.log = [...this.log, event];
    const cursor = this.log.length - 1;
    for (const listener of this.listeners) listener(event, cursor);
    this.store.appendEvent(this.id, event);
  }

  // Live-only events (streaming text): delivered to current subscribers, never written to the event log.
  private emitTransient(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
