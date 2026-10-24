import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runAgentTurn } from "../src/eval/runner.ts";
import { parseInstances, promptFor, selectInstances, toDifficulty, type SweInstance } from "../src/eval/swebench/dataset.ts";
import { PATCH_SCRIPT } from "../src/eval/swebench/docker.ts";
import { containerName } from "../src/eval/swebench/runner.ts";
import type { Tool } from "../src/tools/index.ts";
import { reply, ScriptedProvider, tempWorkspace, testRuntime } from "./helpers.ts";

function row(id: string, overrides: Partial<SweInstance> = {}): SweInstance {
  return {
    instance_id: id,
    repo: id.split("__")[0] === "django" ? "django/django" : "sympy/sympy",
    image: `swebench/sweb.eval.x86_64.${id}:latest`,
    difficulty: "<15 min fix",
    problem_statement: `issue of ${id}`,
    patch: "diff --git a/x b/x\n",
    eval_script: "#!/bin/bash\n",
    ...overrides,
  };
}

const rows = [
  row("django__django-1"),
  row("django__django-2", { difficulty: "15 min - 1 hour" }),
  row("django__django-3", { difficulty: "1-4 hours" }),
  row("sympy__sympy-1"),
  row("sympy__sympy-2", { difficulty: ">4 hours" }),
];

test("swebench: Verified's time estimates map onto the eval's difficulty tiers", () => {
  assert.deepEqual(["<15 min fix", "15 min - 1 hour", "1-4 hours", ">4 hours"].map(toDifficulty), ["easy", "medium", "hard", "expert"]);
  assert.throws(() => toDifficulty("a week"), /unknown SWE-bench difficulty/);
});

test("swebench: rows missing a field the runner or grader needs are rejected", () => {
  assert.equal(parseInstances(rows).length, 5);
  assert.throws(() => parseInstances({}), /JSON array/);
  assert.throws(() => parseInstances([row("a", { image: "" })]), /row 0: "image"/);
  const { eval_script: _, ...noScript } = row("a");
  assert.throws(() => parseInstances([noScript]), /"eval_script"/);
  assert.throws(() => parseInstances([row("a", { difficulty: "soon" })]), /unknown SWE-bench difficulty/);
});

test("swebench: selection filters by id, repo and difficulty", () => {
  const ids = (s: Parameters<typeof selectInstances>[1]) => selectInstances(rows, s).map((x) => x.instance_id);
  assert.deepEqual(ids({}), rows.map((x) => x.instance_id).sort());
  assert.deepEqual(ids({ repo: "django/django" }), ["django__django-1", "django__django-2", "django__django-3"]);
  assert.deepEqual(ids({ difficulty: "easy" }), ["django__django-1", "sympy__sympy-1"]);
  assert.deepEqual(ids({ only: ["sympy__sympy-2", "django__django-2"] }), ["django__django-2", "sympy__sympy-2"]);
  assert.throws(() => ids({ only: ["nope"] }), /unknown instance\(s\): nope/);
});

test("swebench: a sample is the same for the same seed and sorted by id", () => {
  const sample = (seed: string) => selectInstances(rows, { sample: 3, seed }).map((x) => x.instance_id);
  assert.deepEqual(sample("a"), sample("a"));
  assert.equal(sample("a").length, 3);
  assert.deepEqual(sample("a"), [...sample("a")].sort());
  // Some seed picks a different subset; otherwise --seed would do nothing.
  assert.ok(["b", "c", "d", "e", "f"].some((s) => sample(s).join() !== sample("a").join()));
  assert.equal(selectInstances(rows, { sample: 99 }).length, 5);
});

test("swebench: the prompt carries the repo and the issue text", () => {
  const p = promptFor(row("django__django-1", { problem_statement: "  Validator accepts a trailing newline\n" }));
  assert.match(p, /issue of django\/django/);
  assert.match(p, /<issue>\nValidator accepts a trailing newline\n<\/issue>/);
  assert.match(p, /Hidden tests will be run/);
});

test("swebench: container names only use characters Docker accepts", () => {
  assert.equal(containerName("rca-swe", "20261021-1-ab", "astropy__astropy-12907-1"), "rca-swe-20261021-1-ab-astropy__astropy-12907-1");
  assert.equal(containerName("a/b", "c:d e"), "a_b-c_d_e");
});

test("swebench: the patch script covers edits, new and binary files, ignores the repo's diff config, and applies", () => {
  const ws = tempWorkspace();
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { cwd: ws, encoding: "utf8" });
  writeFileSync(join(ws, "a.py"), "x = 1\n");
  writeFileSync(join(ws, ".gitignore"), "*.pyc\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD").trim();
  const pristine = tempWorkspace();
  execFileSync("git", ["-c", "core.autocrlf=false", "clone", "-q", ws, pristine]);

  // What an agent could do: change files, add a binary one, commit its work, and rig the repo's git config.
  writeFileSync(join(ws, "a.py"), "x = 2\n");
  writeFileSync(join(ws, "b.py"), "y = 1\n");
  writeFileSync(join(ws, "a.pyc"), "junk");
  git("add", "a.py");
  git("commit", "-q", "-m", "agent");
  writeFileSync(join(ws, "img.bin"), Buffer.from([0, 1, 2, 255, 0]));
  const marker = join(tempWorkspace(), "fsmonitor-ran");
  for (const [key, value] of [["diff.noprefix", "true"], ["color.ui", "always"], ["diff.external", "false"], ["core.fsmonitor", `touch ${marker}; false`]]) {
    git("config", key, value);
  }

  const patch = execFileSync("bash", ["-c", PATCH_SCRIPT, "patch", base], { cwd: ws, encoding: "utf8" });
  assert.match(patch, /^diff --git a\/a\.py b\/a\.py$/m);
  assert.match(patch, /^-x = 1\n\+x = 2$/m); // the committed change counts: the diff is against the base, not HEAD
  assert.match(patch, /new file mode[\s\S]*\+y = 1/);
  assert.match(patch, /GIT binary patch/);
  assert.doesNotMatch(patch, /a\.pyc|\x1b\[/);
  assert.equal(existsSync(marker), false);
  writeFileSync(join(pristine, "p.diff"), patch);
  execFileSync("git", ["-c", "core.autocrlf=false", "apply", "p.diff"], { cwd: pristine });
  assert.equal(readFileSync(join(pristine, "a.py"), "utf8"), "x = 2\n");
  assert.deepEqual([...readFileSync(join(pristine, "img.bin"))], [0, 1, 2, 255, 0]);
});

test("runAgentTurn: the tools option swaps a tool for this session only", async () => {
  const calls: string[] = [];
  const fakeBash: Tool = {
    spec: { name: "bash", description: "in a container", inputSchema: { type: "object", properties: {} } },
    dangerous: true,
    async run(input) {
      calls.push(String(input.command));
      return "ran in container\n[exit code: 0]";
    },
  };
  const provider = new ScriptedProvider([reply("", [{ id: "1", name: "bash", input: { command: "pytest" } }]), reply("done")]);
  const runtime = testRuntime(provider);
  const turn = await runAgentTurn(runtime, {
    workspace: tempWorkspace(),
    title: "[swe] x",
    prompt: "fix it",
    budget: { maxSteps: 5, maxCostUsd: 1 },
    tools: (tools) => tools.map((t) => (t.spec.name === "bash" ? fakeBash : t)),
  });
  assert.deepEqual(calls, ["pytest"]);
  assert.equal(turn.finishReason, "end_turn");
  assert.equal(turn.steps, 2);
  assert.equal(provider.requests[0].tools?.find((t) => t.name === "bash")?.description, "in a container");
  assert.equal(runtime.store.getMeta(turn.sessionId).title, "[swe] x");
});
