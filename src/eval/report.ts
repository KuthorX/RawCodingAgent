import type { TaskOutcome } from "./runner.ts";
import type { EvalTask } from "./tasks.ts";

import type { Pricing } from "../pricing.ts";

export interface TaskTally {
  hash: string; // task directory content hash; tallies are only compared when it matches
  passed: number;
  attempts: number; // graded attempts, excluding errors
  errors: number;
}

export interface RunSummary {
  runId: string;
  model: string;
  pricing: Pricing;
  startedAt: string;
  attempts: number;
  passed: number;
  errors: number;
  costUsd: number;
  byTask: Record<string, TaskTally>;
}

export interface RunFile {
  summary: RunSummary;
  outcomes: TaskOutcome[];
}

export interface RunInfo {
  runId: string;
  model: string;
  pricing: Pricing;
  startedAt: string;
  hashes: Record<string, string>; // task id -> taskHash
}

export const isError = (o: TaskOutcome): boolean => o.reasons.includes("error");

export function summarize(info: RunInfo, outcomes: readonly TaskOutcome[]): RunSummary {
  const byTask: RunSummary["byTask"] = {};
  for (const o of outcomes) {
    const prev = byTask[o.taskId] ?? { hash: info.hashes[o.taskId] ?? "", passed: 0, attempts: 0, errors: 0 };
    byTask[o.taskId] = isError(o)
      ? { ...prev, errors: prev.errors + 1 }
      : { ...prev, passed: prev.passed + (o.passed ? 1 : 0), attempts: prev.attempts + 1 };
  }
  const tallies = Object.values(byTask);
  return {
    ...info,
    attempts: tallies.reduce((n, t) => n + t.attempts, 0),
    passed: tallies.reduce((n, t) => n + t.passed, 0),
    errors: tallies.reduce((n, t) => n + t.errors, 0),
    costUsd: outcomes.reduce((n, o) => n + o.costUsd, 0),
    byTask,
  };
}

const usd = (n: number): string => `$${n.toFixed(4)}`;
const pad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - s.length));

// Plain-text table for the terminal: one row per attempt, values shown against their budget.
export function formatTable(tasks: readonly EvalTask[], outcomes: readonly TaskOutcome[]): string {
  const rows = [["task", "diff", "result", "steps", "cost", "time", "session", "reasons"]];
  for (const task of tasks) {
    for (const o of outcomes.filter((x) => x.taskId === task.id)) {
      rows.push([
        o.attempt > 1 ? `${task.id} #${o.attempt}` : task.id,
        task.difficulty,
        o.passed ? "PASS" : isError(o) ? "ERROR" : "FAIL",
        `${o.steps}/${o.budget.maxSteps}`,
        `${usd(o.costUsd)}/${usd(o.budget.maxCostUsd)}`,
        `${(o.durationMs / 1000).toFixed(1)}s`,
        o.sessionId,
        o.reasons.join(","),
      ]);
    }
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((cell, i) => pad(cell, widths[i])).join("  ").trimEnd()).join("\n");
}

const samePricing = (a: Pricing, b: Pricing): boolean =>
  a.inputPerMTok === b.inputPerMTok && a.cachedInputPerMTok === b.cachedInputPerMTok && a.outputPerMTok === b.outputPerMTok;

// Compares only tasks present in both runs with identical content; a changed task (e.g. a fixed hidden test)
// would otherwise show up as an agent improvement or regression.
export function compare(current: RunSummary, previous: RunSummary): string[] {
  const shared = Object.keys(current.byTask).filter((id) => previous.byTask[id]?.hash === current.byTask[id].hash);
  const changed = Object.keys(current.byTask).filter((id) => previous.byTask[id] && !shared.includes(id));
  const sum = (s: RunSummary, key: "passed" | "attempts") => shared.reduce((n, id) => n + s.byTask[id][key], 0);
  const lines = [`vs ${previous.runId} (${previous.model}), ${shared.length} comparable task(s): ${sum(previous, "passed")}/${sum(previous, "attempts")} → ${sum(current, "passed")}/${sum(current, "attempts")}`];
  if (previous.model !== current.model) lines.push(`  ! model differs: ${previous.model} → ${current.model}`);
  if (previous.pricing && !samePricing(previous.pricing, current.pricing)) lines.push("  ! pricing differs: costs and over_cost verdicts are not comparable");
  if (changed.length > 0) lines.push(`  ! task content changed, not compared: ${changed.join(", ")}`);
  const rate = (t: TaskTally) => (t.attempts === 0 ? null : t.passed / t.attempts);
  for (const id of shared) {
    const now = current.byTask[id];
    const before = previous.byTask[id];
    const [a, b] = [rate(before), rate(now)];
    if (a !== null && b !== null && a !== b) {
      lines.push(`  ${b > a ? "↑" : "↓"} ${id}: ${before.passed}/${before.attempts} → ${now.passed}/${now.attempts}`);
    }
  }
  return lines;
}
