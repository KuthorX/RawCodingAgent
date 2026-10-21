import { createHash } from "node:crypto";
import type { Difficulty } from "../tasks.ts";

// One row of SWE-bench Verified as published (SWE-bench/SWE-bench_Verified). Only the fields the runner reads
// are typed; the whole row is passed to the swebench helper, which needs the rest (eval_script, FAIL_TO_PASS, ...).
export interface SweInstance {
  instance_id: string;
  repo: string;
  image: string;
  difficulty: string;
  problem_statement: string;
  patch: string;
  [field: string]: unknown;
}

// Verified's human-annotated time estimates, mapped onto the eval's difficulty tiers.
const DIFFICULTIES: Record<string, Difficulty> = {
  "<15 min fix": "easy",
  "15 min - 1 hour": "medium",
  "1-4 hours": "hard",
  ">4 hours": "expert",
};

export function toDifficulty(label: string): Difficulty {
  const d = DIFFICULTIES[label];
  if (!d) throw new Error(`unknown SWE-bench difficulty "${label}"`);
  return d;
}

export function parseInstances(raw: unknown): SweInstance[] {
  if (!Array.isArray(raw)) throw new Error("SWE-bench dataset must be a JSON array");
  return raw.map((row: unknown, i) => {
    const r = row as Record<string, unknown>;
    for (const key of ["instance_id", "repo", "image", "difficulty", "problem_statement", "patch", "eval_script"]) {
      if (typeof r?.[key] !== "string" || !r[key]) throw new Error(`SWE-bench row ${i}: "${key}" must be a non-empty string`);
    }
    toDifficulty(r.difficulty as string);
    return r as SweInstance;
  });
}

export interface Selection {
  only?: string[];
  repo?: string;
  difficulty?: Difficulty;
  sample?: number;
  seed?: string;
}

// Filters, then (with sample) takes a fixed pseudo-random subset: the same seed picks the same instances,
// so runs on a sample stay comparable.
export function selectInstances(all: readonly SweInstance[], s: Selection): SweInstance[] {
  if (s.only) {
    const unknown = s.only.filter((id) => !all.some((x) => x.instance_id === id));
    if (unknown.length > 0) throw new Error(`unknown instance(s): ${unknown.join(", ")}`);
  }
  const picked = all.filter(
    (x) =>
      (!s.only || s.only.includes(x.instance_id)) &&
      (!s.repo || x.repo === s.repo) &&
      (!s.difficulty || toDifficulty(x.difficulty) === s.difficulty),
  );
  if (s.sample === undefined) return [...picked].sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  const key = (x: SweInstance) => createHash("sha256").update(`${s.seed ?? ""}\0${x.instance_id}`).digest("hex");
  return [...picked]
    .sort((a, b) => key(a).localeCompare(key(b)))
    .slice(0, s.sample)
    .sort((a, b) => a.instance_id.localeCompare(b.instance_id));
}

export function promptFor(x: SweInstance): string {
  return [
    `Resolve the following GitHub issue of ${x.repo}. The repository is checked out at the workspace root.`,
    "",
    "<issue>",
    x.problem_statement.trim(),
    "</issue>",
    "",
    "Change the non-test source files so that the issue is fixed. The project's dependencies are installed and the bash tool " +
      "runs inside that environment, so you can reproduce the issue and run the existing tests. " +
      "Hidden tests will be run on your changes after you finish.",
  ].join("\n");
}
