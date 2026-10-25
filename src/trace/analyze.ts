import type { SpanRecord } from "../agent/trace.ts";
import { costUsd, DEFAULT_PRICING, pricingForModel, type Pricing } from "../pricing.ts";

export interface LocatedSpan extends SpanRecord {
  line: number; // 1-based line in trace.jsonl
}

export interface Totals {
  turns: number;
  llmCalls: number;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number;
  cachedInputTokens: number; // part of inputTokens served from the provider's prompt cache
  cacheHitRatio: number;
  outputTokens: number;
  costUsd: number; // estimated from the token counts and the configured pricing
  // Input tokens of the latest model call that reported usage: how big the conversation is now (D10).
  // Slightly low: it excludes that call's own output and any tool results added after it.
  contextTokens: number;
  llmMs: number;
  toolMs: number; // execution only, excluding time spent waiting for approval
  approvalMs: number;
  approvals: Record<"auto" | "allowed" | "denied", number>; // dangerous tool calls by how they were permitted
}

export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  totalMs: number;
  avgMs: number;
}

export interface TurnView {
  turn: LocatedSpan | null; // null while the turn is still running (its span is written at the end)
  children: LocatedSpan[];
}

function isSpan(value: unknown): value is SpanRecord {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "span";
}

// Skips non-span and malformed lines instead of failing the whole file.
export function parseTrace(text: string): LocatedSpan[] {
  const spans: LocatedSpan[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line) return;
    try {
      const value: unknown = JSON.parse(line);
      if (isSpan(value)) spans.push({ ...value, line: i + 1 });
    } catch {
      // ignore malformed line
    }
  });
  return spans;
}

const num = (value: unknown): number => (typeof value === "number" ? value : 0);
// Tool spans measure wall time, which includes waiting for a human to approve.
const execMs = (s: LocatedSpan): number => Math.max(0, s.durationMs - num(s.attrs.approvalMs));

export function totals(spans: readonly LocatedSpan[], pricing: Pricing = DEFAULT_PRICING): Totals {
  const of = (kind: string) => spans.filter((s) => s.kind === kind);
  const llm = of("llm");
  const tools = of("tool");
  const usage = {
    inputTokens: llm.reduce((n, s) => n + num(s.attrs.inputTokens), 0),
    cachedInputTokens: llm.reduce((n, s) => n + num(s.attrs.cachedInputTokens), 0),
    outputTokens: llm.reduce((n, s) => n + num(s.attrs.outputTokens), 0),
  };
  return {
    turns: of("turn").filter((span) => !span.attrs.subagent).length,
    llmCalls: llm.length,
    toolCalls: tools.length,
    toolErrors: tools.filter((s) => s.status === "error").length,
    ...usage,
    costUsd: llm.reduce((total, span) => total + costUsd({
      inputTokens: num(span.attrs.inputTokens),
      cachedInputTokens: num(span.attrs.cachedInputTokens),
      outputTokens: num(span.attrs.outputTokens),
    }, pricingForModel(pricing, span.name)), 0),
    cacheHitRatio: usage.inputTokens ? usage.cachedInputTokens / usage.inputTokens : 0,
    // Aborted or failed calls carry no usage; skip them so a stop doesn't reset the number to 0.
    contextTokens: num(
      llm
        .filter((s) => typeof s.attrs.inputTokens === "number")
        .reduce<LocatedSpan | null>((latest, s) => (latest === null || s.start > latest.start ? s : latest), null)?.attrs.inputTokens,
    ),
    llmMs: llm.reduce((n, s) => n + s.durationMs, 0),
    toolMs: tools.reduce((n, s) => n + execMs(s), 0),
    approvalMs: tools.reduce((n, s) => n + num(s.attrs.approvalMs), 0),
    approvals: {
      auto: tools.filter((s) => s.attrs.approval === "auto").length,
      allowed: tools.filter((s) => s.attrs.approval === "allowed").length,
      denied: tools.filter((s) => s.attrs.approval === "denied").length,
    },
  };
}

export function toolStats(spans: readonly LocatedSpan[]): ToolStat[] {
  const byName = new Map<string, LocatedSpan[]>();
  for (const s of spans) {
    if (s.kind === "tool") byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  }
  return [...byName.entries()]
    .map(([name, list]) => {
      const totalMs = list.reduce((n, s) => n + execMs(s), 0);
      return {
        name,
        calls: list.length,
        errors: list.filter((s) => s.status === "error").length,
        totalMs,
        avgMs: Math.round(totalMs / list.length),
      };
    })
    .sort((a, b) => b.calls - a.calls);
}

export function turns(spans: readonly LocatedSpan[]): TurnView[] {
  const byStart = (a: LocatedSpan, b: LocatedSpan) => a.start.localeCompare(b.start);
  const turnSpans = spans.filter((s) => s.kind === "turn");
  const turnIds = new Set(turnSpans.map((s) => s.id));
  const childrenOf = (id: string | null) => spans.filter((s) => s.kind !== "turn" && s.parentId === id).sort(byStart);

  const views: TurnView[] = turnSpans.map((turn) => ({ turn, children: childrenOf(turn.id) }));
  const orphanParents = new Set(spans.filter((s) => s.kind !== "turn" && !turnIds.has(s.parentId ?? "")).map((s) => s.parentId));
  for (const parentId of orphanParents) views.push({ turn: null, children: childrenOf(parentId) });

  const startOf = (v: TurnView) => v.turn?.start ?? v.children[0]?.start ?? "";
  return views.sort((a, b) => startOf(a).localeCompare(startOf(b)));
}
