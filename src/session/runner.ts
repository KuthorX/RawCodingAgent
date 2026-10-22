import { randomUUID } from "node:crypto";
import type { AgentDeps } from "../agent/loop.ts";
import { runTurn, TurnAbortedError } from "../agent/loop.ts";
import type { ApprovalMode, Confirm } from "../agent/permissions.ts";
import type { ImageAttachment, Message, UserMessage } from "../types.ts";
import type { SessionEvent } from "./events.ts";
import { titleFrom, type SessionMeta, type SessionStore } from "./store.ts";

type Listener = (event: SessionEvent) => void;

export interface RunnerOptions {
  store: SessionStore;
  meta: SessionMeta;
  makeDeps: (meta: SessionMeta, hooks: Pick<AgentDeps, "confirm" | "onEvent" | "approvalMode">) => AgentDeps;
  // When omitted, approvals are surfaced as approval_request events and answered via approve().
  confirm?: Confirm;
  // Tightest spending cap left over this session and the workspace/project it belongs to; null = no cap.
  // `label` is for the user, `scope` for the model's limit notice.
  budget?: (meta: SessionMeta) => Budget | null;
  compactionTokens?: () => number;
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
Drop greetings and repeated tool output. Return only the summary.`;

function estimateTokens(messages: Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function messageText(message: Message): string {
  if (message.role === "user") return `USER:\n${message.content}`;
  if (message.role === "assistant") return `ASSISTANT:\n${message.text}`;
  return `TOOLS:\n${message.results.map((r) => `${r.isError ? "ERROR" : "OK"}: ${r.content}`).join("\n")}`;
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
  private controller: AbortController | null = null;
  private queue: UserMessage[] = [];
  private readonly store: SessionStore;
  private readonly listeners = new Set<Listener>();
  private readonly pending = new Map<string, (allow: boolean) => void>();
  private readonly budget: RunnerOptions["budget"];
  private readonly compactionTokens: RunnerOptions["compactionTokens"];
  private readonly releaseLock: () => void;

  constructor(options: RunnerOptions) {
    this.store = options.store;
    this.budget = options.budget;
    this.compactionTokens = options.compactionTokens;
    this.meta = options.meta;
    this.releaseLock = this.store.acquireLock(this.meta.id);
    this.history = this.store.loadMessages(this.meta.id);
    this.log = this.store.loadEvents(this.meta.id);
    // Persist the marker so the interrupted turn stays closed after later turns are appended.
    if (isInterrupted(this.log)) this.emit({ type: "error", message: INTERRUPTED });
    this.deps = options.makeDeps(this.meta, {
      onEvent: (event) => this.emit(event),
      confirm: options.confirm ?? ((call) => this.requestApproval(call)),
      approvalMode: () => this.meta.approvalMode,
    });
  }

  get id(): string {
    return this.meta.id;
  }

  get info(): SessionMeta & { busy: boolean } {
    return { ...this.meta, busy: this.isBusy };
  }

  get isBusy(): boolean {
    return this.running !== null;
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
    for (const event of this.log) listener(event);
    this.listeners.add(listener);
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
    this.controller = new AbortController();
    const done = this.compactHistory(focus, true, this.controller.signal).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.safely(() => this.emit({ type: "error", message }));
      throw err;
    }).finally(() => { this.running = null; this.controller = null; });
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
      budget: this.budget?.(this.meta) ?? null,
    };
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
      const limit = this.compactionTokens?.() ?? 0;
      if (limit > 0 && estimateTokens(this.history) + estimateTokens([input]) >= limit) {
        try {
          await this.compactHistory("", false, this.controller.signal);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.safely(() => this.emit({ type: "error", message }));
          return;
        }
      }
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

  private async compactHistory(focus: string, manual: boolean, signal?: AbortSignal): Promise<void> {
    if (this.history.length === 0) return;
    const beforeTokens = estimateTokens(this.history);
    const transcript = this.history.map(messageText).join("\n\n");
    const response = await this.deps.provider.complete({
      system: this.deps.system,
      messages: [{ role: "user", content: `${COMPACT_PROMPT}${focus ? `\nFocus especially on: ${focus}` : ""}\n\n${transcript}` }],
      tools: [],
    }, signal);
    const summary = response.message.text.trim() || "No summary was returned.";
    const recentUsers = this.history.filter((m): m is Extract<Message, { role: "user" }> => m.role === "user").slice(-8);
    this.history = [{ role: "user", content: `[Conversation summary]\n${summary}` }, ...recentUsers];
    this.store.saveMessages(this.id, this.history);
    this.emit({ type: "compacted", beforeTokens, afterTokens: estimateTokens(this.history), ...(manual ? { manual: true } : {}) });
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
      const result = await runTurn(this.history, input, this.turnDeps(), control);
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
    for (const listener of this.listeners) listener(event);
    this.store.appendEvent(this.id, event);
  }
}
