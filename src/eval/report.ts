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
  promptRules: string[];
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
  promptRules: string[];
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
  const rules = (s: RunSummary) => (s.promptRules ?? []).join(",") || "(none)";
  if (rules(previous) !== rules(current)) lines.push(`  prompt rules: ${rules(previous)} → ${rules(current)}`);
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

// Wilson score interval (95%) for a pass rate: with 45 attempts, a few passes either way is noise.
export function wilson(passed: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = passed / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

// Task ids present in every run with identical content; only those are comparable across runs.
function comparableTasks(runs: readonly RunFile[]): { shared: string[]; excluded: string[] } {
  const all = [...new Set(runs.flatMap((r) => Object.keys(r.summary.byTask)))].sort();
  const shared = all.filter((id) => {
    const hashes = runs.map((r) => r.summary.byTask[id]?.hash);
    return hashes.every((h) => h !== undefined && h === hashes[0]);
  });
  return { shared, excluded: all.filter((id) => !shared.includes(id)) };
}

// Side-by-side view of several runs, e.g. the same suite under different prompt rules.
// Only tasks that exist unchanged in every run are counted.
export function experimentTable(runs: readonly RunFile[], difficulties: Record<string, string>): string {
  const { shared, excluded } = comparableTasks(runs);
  const graded = (r: RunFile) => r.outcomes.filter((o) => !isError(o) && shared.includes(o.taskId));
  const rows = [["run", "model", "prompt rules", "pass", "naive 95% CI", "expert pass", "avg steps", "avg cost"]];
  for (const run of runs) {
    const outcomes = graded(run);
    const passed = outcomes.filter((o) => o.passed).length;
    const expert = outcomes.filter((o) => difficulties[o.taskId] === "expert");
    const [lo, hi] = wilson(passed, outcomes.length);
    rows.push([
      run.summary.runId,
      run.summary.model,
      (run.summary.promptRules ?? []).join(",") || "(none)",
      `${passed}/${outcomes.length} ${pct(passed / Math.max(1, outcomes.length))}`,
      `${pct(lo)}-${pct(hi)}`,
      `${expert.filter((o) => o.passed).length}/${expert.length}`,
      mean(outcomes.map((o) => o.steps)).toFixed(1),
      `$${mean(outcomes.map((o) => o.costUsd)).toFixed(4)}`,
    ]);
  }

  // Per task, so differences can be traced to specific tasks instead of a pooled rate.
  const perTask = [["task", ...runs.map((r) => (r.summary.promptRules ?? []).join(",") || "(none)")]];
  for (const id of shared) {
    const cells = runs.map((r) => {
      const os = graded(r).filter((o) => o.taskId === id);
      return `${os.filter((o) => o.passed).length}/${os.length} ${mean(os.map((o) => o.steps)).toFixed(0)}st`;
    });
    if (new Set(cells.map((c) => c.split(" ")[0])).size > 1) perTask.push([id, ...cells]);
  }

  const notes: string[] = [];
  if (excluded.length > 0) notes.push(`! not compared (missing or changed in some run): ${excluded.join(", ")}`);
  if (new Set(runs.map((r) => r.summary.model)).size > 1) notes.push("! models differ between runs");
  const prices = runs.map((r) => r.summary.pricing).filter((p): p is Pricing => p !== undefined);
  if (prices.some((p) => !samePricing(p, prices[0]))) notes.push("! pricing differs: avg cost is not comparable");
  notes.push("naive CI treats every attempt as independent; repeats of one task are correlated, so the real uncertainty is wider.");

  const sections = [render(rows), perTask.length > 1 ? `tasks whose pass count differs (passes/attempts, avg steps):\n${render(perTask)}` : "no task's pass count differs between runs.", ...notes];
  return sections.join("\n\n");
}

function render(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((cell, i) => pad(cell, widths[i])).join("  ").trimEnd()).join("\n");
}
