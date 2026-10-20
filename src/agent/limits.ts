import type { ToolCall } from "../types.ts";

// D1: why a turn was stopped by the agent itself rather than finished by the model.
// budget: a spending cap on the session, its workspace or its project (not just this turn) ran out.
export type LimitHit = "max_steps" | "max_cost" | "repeated" | "budget";

// Stable regardless of key order, so {a,b} and {b,a} count as the same call.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function callSignature(call: ToolCall): string {
  return `${call.name}:${stableJson(call.input)}`;
}

// True when the last `times` signatures are identical: the same call made back to back with nothing in between,
// which means no progress (an edit or a different command in between resets the count).
export function isRepeating(signatures: readonly string[], times: number): boolean {
  if (times < 2 || signatures.length < times) return false;
  const tail = signatures.slice(-times);
  return tail.every((s) => s === tail[0]);
}

export function limitDetail(
  hit: LimitHit,
  info: { maxSteps: number; maxCostUsd: number | null; maxRepeats: number; budgetScope?: string },
): string {
  if (hit === "max_steps") return `reached the step limit (${info.maxSteps} model calls)`;
  if (hit === "max_cost") return `reached the cost limit for one turn ($${info.maxCostUsd})`;
  if (hit === "budget") return `used up the spending budget of the ${info.budgetScope ?? "session"}`;
  return `made the same tool call ${info.maxRepeats} times in a row`;
}

// Sent as a user message so the model ends with a usable hand-off instead of being cut off mid-task.
export function limitNotice(detail: string): string {
  return (
    `[agent limit] This turn was stopped because it ${detail}. Do not call any tools now. ` +
    "Briefly tell the user what has been done, what is left, and the suggested next step, " +
    "so they can reply to continue. Reply in the user's language."
  );
}
