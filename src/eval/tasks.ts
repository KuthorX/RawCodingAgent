import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { runShell } from "../tools/bash.ts";

export type Difficulty = "easy" | "medium" | "hard" | "expert";

export interface Budget {
  maxSteps: number; // model calls in the turn
  maxCostUsd: number;
}

export interface EvalTask {
  id: string;
  dir: string;
  title: string;
  difficulty: Difficulty;
  skill: string;
  prompt: string;
  check: string; // shell command run in the workspace; exit 0 = pass
  budget: Budget;
}

export interface CheckResult {
  passed: boolean;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard", "expert"];
const CHECK_TIMEOUT_MS = 60_000;
const CHECK_OUTPUT_CHARS = 4000;

function fail(id: string, message: string): never {
  throw new Error(`eval task "${id}": ${message}`);
}

function parseTask(id: string, dir: string, raw: unknown): EvalTask {
  if (typeof raw !== "object" || raw === null) fail(id, "task.json must be an object");
  const t = raw as Record<string, unknown>;
  for (const key of ["title", "skill", "prompt", "check"]) {
    if (typeof t[key] !== "string" || !t[key]) fail(id, `"${key}" must be a non-empty string`);
  }
  if (!DIFFICULTIES.includes(t.difficulty as Difficulty)) fail(id, `"difficulty" must be one of ${DIFFICULTIES.join(", ")}`);
  const budget = t.budget as Record<string, unknown> | undefined;
  if (!budget || !Number.isInteger(budget.maxSteps) || (budget.maxSteps as number) < 1) fail(id, "budget.maxSteps must be an integer >= 1");
  if (typeof budget.maxCostUsd !== "number" || budget.maxCostUsd <= 0) fail(id, "budget.maxCostUsd must be a number > 0");
  for (const sub of ["repo", "check", "solution"]) {
    if (!existsSync(join(dir, sub))) fail(id, `missing ${sub}/ directory`);
  }
  return {
    id,
    dir,
    title: t.title as string,
    difficulty: t.difficulty as Difficulty,
    skill: t.skill as string,
    prompt: t.prompt as string,
    check: t.check as string,
    budget: { maxSteps: budget.maxSteps as number, maxCostUsd: budget.maxCostUsd },
  };
}

// Every subdirectory of `root` with a task.json is a task, sorted by difficulty then id.
export function loadTasks(root: string): EvalTask[] {
  const tasks = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "task.json")))
    .map((d) => {
      const dir = join(root, d.name);
      return parseTask(d.name, dir, JSON.parse(readFileSync(join(dir, "task.json"), "utf8")));
    });
  return tasks.sort((a, b) => DIFFICULTIES.indexOf(a.difficulty) - DIFFICULTIES.indexOf(b.difficulty) || a.id.localeCompare(b.id));
}

// The starting repo the agent sees. check/ and solution/ stay hidden until grading.
export function copyRepo(task: EvalTask, dest: string): void {
  cpSync(join(task.dir, "repo"), dest, { recursive: true });
}

// Makes the workspace its own git repo, so git commands the agent runs (status, diff, stash, reset)
// act on this copy only, never on a repository that happens to contain the workspace.
export function initGit(dest: string): void {
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@localhost", ...args], { cwd: dest, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
}

// Overlays files onto the workspace. For check/, every top-level directory it contains (tests/, test/) is
// replaced wholesale first: tests the agent edited are restored and tests it added can't affect the grade.
export function overlay(task: EvalTask, part: "check" | "solution", dest: string): void {
  const src = join(task.dir, part);
  if (part === "check") {
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (entry.isDirectory()) rmSync(join(dest, entry.name), { recursive: true, force: true });
    }
    removePycache(dest);
  }
  cpSync(src, dest, { recursive: true, force: true });
}

// Stale bytecode could otherwise stand in for a restored test file.
function removePycache(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.name === "__pycache__") rmSync(path, { recursive: true, force: true });
    else removePycache(path);
  }
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((rel) => statSync(join(dir, rel)).isFile())
    .sort();
}

// Content hash of the whole task directory: results are only comparable between runs with the same hash.
export function taskHash(task: EvalTask): string {
  const hash = createHash("sha256");
  for (const rel of listFiles(task.dir)) {
    hash.update(relative(task.dir, join(task.dir, rel)));
    hash.update("\0");
    hash.update(readFileSync(join(task.dir, rel)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

function clip(text: string): string {
  if (text.length <= CHECK_OUTPUT_CHARS) return text;
  const half = CHECK_OUTPUT_CHARS / 2;
  return `${text.slice(0, half)}\n...[${text.length - CHECK_OUTPUT_CHARS} chars omitted]...\n${text.slice(-half)}`;
}

// A parent `node --test` leaks NODE_TEST_CONTEXT, which would make a task's own `node --test` skip its files.
function checkEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("NODE_TEST")));
  return { ...env, PYTHONDONTWRITEBYTECODE: "1" };
}

// Runs in the agent's own shell, so a check behaves the same as when the agent runs it (Git Bash on Windows),
// and a hung test is killed together with its children on timeout.
export async function runCheck(task: EvalTask, cwd: string, timeoutMs = CHECK_TIMEOUT_MS): Promise<CheckResult> {
  const r = await runShell(task.check, { cwd, timeoutMs, env: checkEnv() });
  const output = r.startError ?? clip(r.output);
  return { passed: r.exitCode === 0 && !r.timedOut, exitCode: r.exitCode, output, timedOut: r.timedOut };
}
