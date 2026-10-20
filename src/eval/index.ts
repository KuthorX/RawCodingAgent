import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createRuntime, PROJECT_ROOT } from "../app.ts";
import { compare, experimentTable, formatTable, isError, summarize, type RunFile } from "./report.ts";
import { runTask, secretEnvNames, type TaskOutcome } from "./runner.ts";
import { copyRepo, loadTasks, overlay, runCheck, taskHash, type EvalTask } from "./tasks.ts";

const TASKS_DIR = join(PROJECT_ROOT, "eval", "tasks");
const RUNS_DIR = join(PROJECT_ROOT, ".eval-runs");

const USAGE = `usage: npm run eval -- [options]

  --only <ids>         comma-separated task ids (default: all)
  --repeat <n>         attempts per task (default 1)
  --concurrency <n>    tasks run in parallel (default 3)
  --validate           no model calls: check that every original repo fails and every solution passes
  --list               list tasks and budgets
  --report <runIds>    compare finished runs side by side (comma-separated ids from .eval-runs/)
`;

function positiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  return n;
}

function selectTasks(all: EvalTask[], only: string | undefined): EvalTask[] {
  if (!only) return all;
  const ids = only.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !all.some((t) => t.id === id));
  if (unknown.length > 0) throw new Error(`unknown task(s): ${unknown.join(", ")}`);
  return all.filter((t) => ids.includes(t.id));
}

// Runs jobs with at most `limit` in flight; results keep the input order.
async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
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

async function validate(tasks: EvalTask[]): Promise<boolean> {
  let ok = true;
  for (const task of tasks) {
    const dir = join(RUNS_DIR, "validate", task.id);
    const original = join(dir, "original");
    const solved = join(dir, "solved");
    rmSync(dir, { recursive: true, force: true });
    for (const d of [original, solved]) mkdirSync(d, { recursive: true });
    copyRepo(task, original);
    overlay(task, "check", original);
    copyRepo(task, solved);
    overlay(task, "solution", solved);
    overlay(task, "check", solved);
    const [before, after] = await Promise.all([runCheck(task, original), runCheck(task, solved)]);
    const good = !before.passed && after.passed;
    ok &&= good;
    const detail = good ? "" : `  original ${before.passed ? "PASSES (should fail)" : "fails"}, solution ${after.passed ? "passes" : "FAILS:\n" + after.output}`;
    process.stdout.write(`${good ? "ok  " : "BAD "} ${task.id}${detail}\n`);
  }
  return ok;
}

function previousRun(currentId: string): RunFile | null {
  if (!existsSync(RUNS_DIR)) return null;
  const ids = readdirSync(RUNS_DIR)
    .filter((id) => id !== currentId && existsSync(join(RUNS_DIR, id, "results.json")))
    .sort();
  const last = ids.at(-1);
  return last ? (JSON.parse(readFileSync(join(RUNS_DIR, last, "results.json"), "utf8")) as RunFile) : null;
}

// Random suffix: two runs started in the same second must not share a directory.
function runId(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

// The agent's bash inherits this process's environment. The provider already holds its key,
// so drop credentials before the first tool call.
function scrubSecrets(): void {
  for (const key of secretEnvNames(process.env)) delete process.env[key];
}

// An exception in the harness (not the agent) becomes an "error" outcome, so finished attempts are still saved.
function crashed(task: EvalTask, attempt: number, workspace: string, err: unknown): TaskOutcome {
  const message = err instanceof Error ? err.message : String(err);
  return {
    taskId: task.id, attempt, sessionId: "", workspace, passed: false, reasons: ["error"], finishReason: null, error: message,
    steps: 0, toolCalls: 0, toolErrors: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0,
    budget: task.budget, check: { passed: false, exitCode: null, output: "", timedOut: false },
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      only: { type: "string" },
      repeat: { type: "string", default: "1" },
      concurrency: { type: "string", default: "3" },
      validate: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      report: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.report) {
    const runs = values.report.split(",").map((id) => {
      const file = join(RUNS_DIR, id.trim(), "results.json");
      if (!existsSync(file)) throw new Error(`no results for run "${id}"`);
      return JSON.parse(readFileSync(file, "utf8")) as RunFile;
    });
    const difficulties = Object.fromEntries(loadTasks(TASKS_DIR).map((t) => [t.id, t.difficulty]));
    process.stdout.write(experimentTable(runs, difficulties) + "\n");
    return 0;
  }
  const tasks = selectTasks(loadTasks(TASKS_DIR), values.only);
  if (values.list) {
    for (const t of tasks) {
      process.stdout.write(`${t.id.padEnd(18)} ${t.difficulty.padEnd(6)} steps≤${t.budget.maxSteps} cost≤$${t.budget.maxCostUsd}  ${t.title}\n`);
    }
    return 0;
  }
  if (values.validate) return (await validate(tasks)) ? 0 : 1;

  const repeat = positiveInt(values.repeat, "--repeat");
  const concurrency = positiveInt(values.concurrency, "--concurrency");
  const startedAt = new Date();
  const id = runId(startedAt);
  const runDir = join(RUNS_DIR, id);
  // Eval sessions live with the run's results, not in the GUI's session list.
  // Created before the run directory, so a config error doesn't leave an empty one behind.
  const runtime = createRuntime("auto", { sessionsDir: join(runDir, "sessions"), webSearch: false });
  mkdirSync(runDir, { recursive: true });
  scrubSecrets();
  // Outside this project and outside any git repo, so the agent can't reach hidden tests, solutions or .env.
  const workRoot = mkdtempSync(join(tmpdir(), `rca-eval-${id}-`));
  const rules = runtime.promptRules.join(",") || "(none)";
  process.stdout.write(`eval run ${id}: ${tasks.length} task(s) × ${repeat}, model ${runtime.model}, prompt rules ${rules}\nworkspaces: ${workRoot}\n`);

  const jobs = tasks.flatMap((task) =>
    Array.from({ length: repeat }, (_, i) => async (): Promise<TaskOutcome> => {
      const attempt = i + 1;
      const workspace = join(workRoot, `${task.id}-${attempt}`);
      const outcome = await runTask(runtime, task, { workspace, attempt }).catch((err: unknown) => crashed(task, attempt, workspace, err));
      const mark = outcome.passed ? "PASS" : `${isError(outcome) ? "ERROR" : "FAIL"} (${outcome.reasons.join(",")})`;
      process.stdout.write(`  ${task.id} #${attempt}: ${mark}  ${outcome.steps} steps, $${outcome.costUsd.toFixed(4)}\n`);
      return outcome;
    }),
  );
  const outcomes = await pool(jobs, concurrency);

  const hashes = Object.fromEntries(tasks.map((t) => [t.id, taskHash(t)]));
  const summary = summarize({ runId: id, model: runtime.model, pricing: runtime.pricing, promptRules: [...runtime.promptRules], startedAt: startedAt.toISOString(), hashes }, outcomes);
  const file: RunFile = { summary, outcomes };
  writeFileSync(join(runDir, "results.json"), JSON.stringify(file, null, 2) + "\n");

  process.stdout.write(`\n${formatTable(tasks, outcomes)}\n\n`);
  const errors = summary.errors > 0 ? `, ${summary.errors} error(s) not counted` : "";
  process.stdout.write(`passed ${summary.passed}/${summary.attempts}${errors}, total cost $${summary.costUsd.toFixed(4)}\n`);
  const prev = previousRun(id);
  if (prev) process.stdout.write(compare(summary, prev.summary).join("\n") + "\n");
  process.stdout.write(`results: ${join(runDir, "results.json")}\nsessions (trace, events, messages): ${join(runDir, "sessions")}/<session>/\n`);
  return summary.passed === summary.attempts && summary.errors === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`eval: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
