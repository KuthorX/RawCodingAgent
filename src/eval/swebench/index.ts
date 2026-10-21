import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createRuntime, PROJECT_ROOT } from "../../app.ts";
import { crashed, pool, positiveInt, runId, scrubSecrets } from "../common.ts";
import { compare, experimentTable, formatTable, isError, summarize, type RunFile } from "../report.ts";
import type { TaskOutcome } from "../runner.ts";
import type { Budget, Difficulty, EvalTask } from "../tasks.ts";
import { selectInstances, toDifficulty, type SweInstance } from "./dataset.ts";
import { docker, ensureImage } from "./docker.ts";
import { grade } from "./grade.ts";
import { containerName, runInstance } from "./runner.ts";
import { checkDocker, DATASET_REVISION, ensureDataset, ensurePython } from "./setup.ts";

// Under .eval-runs/ but one level down, so `npm run eval` never takes a SWE-bench run as its previous run.
const RUNS_DIR = join(PROJECT_ROOT, ".eval-runs", "swe");
const DATASET_TAG = `swe-bench-verified@${DATASET_REVISION.slice(0, 12)}`;
const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard", "expert"];

const USAGE = `usage: npm run eval:swe -- [options]

SWE-bench Verified: the agent works in each instance's Docker image, the official eval script grades its diff.

  --only <ids>           comma-separated instance ids
  --repo <owner/name>    only instances of this repo (e.g. django/django)
  --difficulty <d>       easy (<15 min) | medium (15 min-1 h) | hard (1-4 h) | expert (>4 h)
  --sample <n>           fixed pseudo-random subset of the selection (same --seed => same instances)
  --seed <s>             seed for --sample (default "0")
  --repeat <n>           attempts per instance (default 1)
  --concurrency <n>      instances run in parallel (default 1; each runs an emulated x86 container)
  --max-steps <n>        step budget per attempt (default 100)
  --max-cost <usd>       cost budget per attempt (default 0.5)
  --keep-workspaces      keep the host checkouts (deleted after grading by default; ~100-500 MB each)
  --remove-images        delete each instance image after its attempts (images are 1-4 GB each)
  --validate             no model calls: grade the reference patch of every selected instance (must resolve)
  --list                 list the selected instances
  --report <runIds>      compare finished runs side by side (ids from .eval-runs/swe/)
`;

function positiveNumber(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a number > 0`);
  return n;
}

function parseDifficulty(value: string | undefined): Difficulty | undefined {
  if (value === undefined) return undefined;
  if (!DIFFICULTIES.includes(value as Difficulty)) throw new Error(`--difficulty must be one of ${DIFFICULTIES.join(", ")}`);
  return value as Difficulty;
}

// report.ts lays out tables by task; an instance stands in as one.
function asTask(x: SweInstance, budget: Budget): EvalTask {
  return { id: x.instance_id, dir: "", title: x.instance_id, difficulty: toDifficulty(x.difficulty), skill: x.repo, prompt: "", check: "swebench", budget };
}

async function validate(instances: readonly SweInstance[], id: string): Promise<boolean> {
  let ok = true;
  for (const x of instances) {
    await ensureImage(x.image);
    const dir = join(RUNS_DIR, id, "validate", x.instance_id);
    mkdirSync(dir, { recursive: true });
    const r = await grade(x, x.patch, dir, containerName("rca-swe-validate", id, x.instance_id));
    ok &&= r.passed;
    process.stdout.write(`${r.passed ? "ok  " : "BAD "} ${x.instance_id}  ${r.output}\n`);
  }
  return ok;
}

// Every container of a run has the run id in its name. On Ctrl-C they'd otherwise keep running (`sleep infinity`).
function removeContainersOnInterrupt(id: string): void {
  process.once("SIGINT", () => {
    process.stderr.write(`\ninterrupted: removing this run's containers...\n`);
    void docker(["ps", "-aq", "--filter", `name=${id}`], 60_000)
      .then((r) => {
        const ids = r.stdout.split("\n").filter(Boolean);
        return ids.length > 0 ? docker(["rm", "-f", ...ids], 120_000) : null;
      })
      .finally(() => process.exit(130));
  });
}

function previousRun(currentId: string): RunFile | null {
  if (!existsSync(RUNS_DIR)) return null;
  const last = readdirSync(RUNS_DIR)
    .filter((id) => id !== currentId && existsSync(join(RUNS_DIR, id, "results.json")))
    .sort()
    .at(-1);
  return last ? (JSON.parse(readFileSync(join(RUNS_DIR, last, "results.json"), "utf8")) as RunFile) : null;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      only: { type: "string" },
      repo: { type: "string" },
      difficulty: { type: "string" },
      sample: { type: "string" },
      seed: { type: "string", default: "0" },
      repeat: { type: "string", default: "1" },
      concurrency: { type: "string", default: "1" },
      "max-steps": { type: "string", default: "100" },
      "max-cost": { type: "string", default: "0.5" },
      "keep-workspaces": { type: "boolean", default: false },
      "remove-images": { type: "boolean", default: false },
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
  await ensurePython();
  const all = await ensureDataset();
  if (values.report) {
    const runs = values.report.split(",").map((id) => {
      const file = join(RUNS_DIR, id.trim(), "results.json");
      if (!existsSync(file)) throw new Error(`no results for run "${id}"`);
      return JSON.parse(readFileSync(file, "utf8")) as RunFile;
    });
    const difficulties = Object.fromEntries(all.map((x) => [x.instance_id, toDifficulty(x.difficulty)]));
    process.stdout.write(experimentTable(runs, difficulties) + "\n");
    return 0;
  }

  const instances = selectInstances(all, {
    only: values.only?.split(",").map((s) => s.trim()).filter(Boolean),
    repo: values.repo,
    difficulty: parseDifficulty(values.difficulty),
    sample: values.sample === undefined ? undefined : positiveInt(values.sample, "--sample"),
    seed: values.seed,
  });
  if (instances.length === 0) throw new Error("no instances selected");
  if (values.list) {
    for (const x of instances) process.stdout.write(`${x.instance_id.padEnd(40)} ${toDifficulty(x.difficulty).padEnd(6)} ${x.repo}\n`);
    return 0;
  }
  await checkDocker();
  const startedAt = new Date();
  const id = runId(startedAt);
  removeContainersOnInterrupt(id);
  if (values.validate) return (await validate(instances, id)) ? 0 : 1;

  const repeat = positiveInt(values.repeat, "--repeat");
  const concurrency = positiveInt(values.concurrency, "--concurrency");
  const budget: Budget = { maxSteps: positiveInt(values["max-steps"], "--max-steps"), maxCostUsd: positiveNumber(values["max-cost"], "--max-cost") };
  const runDir = join(RUNS_DIR, id);
  const runtime = createRuntime("auto", { sessionsDir: join(runDir, "sessions"), webSearch: false });
  mkdirSync(runDir, { recursive: true });
  scrubSecrets();
  // The system temp dir: outside this project and any git repo, and shared with Docker Desktop by default.
  const workRoot = mkdtempSync(join(tmpdir(), `rca-swe-${id}-`));
  process.stdout.write(
    `swe-bench run ${id}: ${instances.length} instance(s) × ${repeat}, model ${runtime.model}, budget ${budget.maxSteps} steps / $${budget.maxCostUsd}\n`,
  );

  // One job per instance, its attempts in sequence, so an image can be removed once all of them are done.
  const jobs = instances.map((x) => async (): Promise<TaskOutcome[]> => {
    const results: TaskOutcome[] = [];
    try {
      await ensureImage(x.image);
    } catch (err) {
      return Array.from({ length: repeat }, (_, i) => crashed(x.instance_id, budget, i + 1, "", err));
    }
    for (let attempt = 1; attempt <= repeat; attempt++) {
      const artifactsDir = join(runDir, "attempts", `${x.instance_id}-${attempt}`);
      const options = { runId: id, attempt, budget, workRoot, artifactsDir, keepWorkspace: values["keep-workspaces"] };
      const outcome = await runInstance(runtime, x, options).catch((err: unknown) => crashed(x.instance_id, budget, attempt, "", err));
      const mark = outcome.passed ? "PASS" : `${isError(outcome) ? "ERROR" : "FAIL"} (${outcome.reasons.join(",")})`;
      const detail = outcome.error ?? outcome.check.output;
      process.stdout.write(`  ${x.instance_id} #${attempt}: ${mark}  ${outcome.steps} steps, $${outcome.costUsd.toFixed(4)}  ${detail}\n`);
      results.push(outcome);
    }
    if (values["remove-images"]) await docker(["rmi", x.image], 300_000);
    return results;
  });
  const outcomes = (await pool(jobs, concurrency)).flat();
  if (!values["keep-workspaces"]) rmSync(workRoot, { recursive: true, force: true });

  const hashes = Object.fromEntries(instances.map((x) => [x.instance_id, DATASET_TAG]));
  const summary = summarize({ runId: id, model: runtime.model, pricing: runtime.pricing, promptRules: [...runtime.promptRules], startedAt: startedAt.toISOString(), hashes }, outcomes);
  writeFileSync(join(runDir, "results.json"), JSON.stringify({ summary, outcomes } satisfies RunFile, null, 2) + "\n");

  process.stdout.write(`\n${formatTable(instances.map((x) => asTask(x, budget)), outcomes)}\n\n`);
  // Resolved ignores the budgets, like published SWE-bench numbers; PASS also needs a clean end within budget.
  const graded = outcomes.filter((o) => !isError(o));
  const resolved = graded.filter((o) => o.check.passed).length;
  const errors = summary.errors > 0 ? `, ${summary.errors} error(s) not counted` : "";
  process.stdout.write(`resolved ${resolved}/${graded.length}, passed ${summary.passed}/${summary.attempts}${errors}, total cost $${summary.costUsd.toFixed(4)}\n`);
  const prev = previousRun(id);
  if (prev) process.stdout.write(compare(summary, prev.summary).join("\n") + "\n");
  process.stdout.write(`results: ${join(runDir, "results.json")}\nper attempt (patch, eval.sh, test.log, report): ${join(runDir, "attempts")}/\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`eval:swe: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
