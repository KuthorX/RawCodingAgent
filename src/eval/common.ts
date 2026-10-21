import { randomBytes } from "node:crypto";
import { secretEnvNames, type TaskOutcome } from "./runner.ts";
import type { Budget } from "./tasks.ts";

// Shared by the eval entry points (npm run eval, npm run eval:swe).

export function positiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  return n;
}

// Runs jobs with at most `limit` in flight; results keep the input order.
export async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

// Random suffix: two runs started in the same second must not share a directory.
export function runId(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

// The agent's bash inherits this process's environment. The provider already holds its key,
// so drop credentials before the first tool call.
export function scrubSecrets(): void {
  for (const key of secretEnvNames(process.env)) delete process.env[key];
}

// An exception in the harness (not the agent) becomes an "error" outcome, so finished attempts are still saved.
export function crashed(taskId: string, budget: Budget, attempt: number, workspace: string, err: unknown): TaskOutcome {
  const message = err instanceof Error ? err.message : String(err);
  return {
    taskId, attempt, sessionId: "", workspace, passed: false, reasons: ["error"], finishReason: null, error: message,
    steps: 0, toolCalls: 0, toolErrors: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0,
    budget, check: { passed: false, exitCode: null, output: "", timedOut: false },
  };
}
